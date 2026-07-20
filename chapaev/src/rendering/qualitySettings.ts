/**
 * Device-tier graphics quality presets.
 *
 * The game previously ran with a single fixed "high" configuration
 * (DPR 2, 4096px PCFSoft shadows, MSAA + bloom) which tanks the FPS on
 * weak GPUs: cheap Android phones (Mali-4xx/T, Adreno 3-5xx, PowerVR)
 * and even laptop dGPUs pushing Retina resolutions (MacBook Pro 2019
 * Radeon Pro 555X/560X → ~5 Mpx framebuffer at DPR 2).
 *
 * A tier (low / medium / high) is picked once at startup from GPU/device
 * heuristics, and can be overridden with `?quality=low|medium|high` in
 * the URL or persisted via {@link setQualityOverride}. Runtime FPS-based
 * adjustment is handled separately by `AdaptivePerformance`.
 */

export type QualityTier = 'low' | 'medium' | 'high';

export interface QualityPreset {
  readonly tier: QualityTier;
  /** Upper bound for `renderer.setPixelRatio` (biggest FPS lever). */
  readonly pixelRatioCap: number;
  /** Context-level MSAA — costly on tile-based mobile GPUs. */
  readonly antialias: boolean;
  /** Shadow map resolution (width = height). */
  readonly shadowMapSize: number;
  /** PCFSoft (true) vs plain PCF (false) shadow filtering. */
  readonly softShadows: boolean;
  /** Shadow blur radius (only meaningful for PCFSoft). */
  readonly shadowRadius: number;
  /** UnrealBloomPass — multi-target blur chain, heavy on fill-rate. */
  readonly bloom: boolean;
  /** Max anisotropic filtering samples (clamped by GPU capability). */
  readonly anisotropyCap: number;
}

const PRESETS: Record<QualityTier, QualityPreset> = {
  low: {
    tier: 'low',
    pixelRatioCap: 1,
    antialias: false,
    shadowMapSize: 1024,
    softShadows: false,
    shadowRadius: 1,
    bloom: false,
    anisotropyCap: 2,
  },
  medium: {
    tier: 'medium',
    pixelRatioCap: 1.5,
    antialias: true,
    shadowMapSize: 2048,
    softShadows: true,
    shadowRadius: 12,
    bloom: true,
    anisotropyCap: 4,
  },
  high: {
    tier: 'high',
    pixelRatioCap: 2,
    antialias: true,
    shadowMapSize: 4096,
    softShadows: true,
    shadowRadius: 20,
    bloom: true,
    anisotropyCap: 16,
  },
};

const STORAGE_KEY = 'chapaev.quality';

export function getQualityPreset(tier: QualityTier): QualityPreset {
  return PRESETS[tier];
}

/** Persist a manual quality override (e.g. from a future settings UI). */
export function setQualityOverride(tier: QualityTier | null): void {
  try {
    if (tier === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, tier);
  } catch {
    /* storage unavailable (private mode) — ignore */
  }
}

function readOverride(): QualityTier | null {
  // URL param wins (handy for debugging on devices): ?quality=low
  try {
    const param = new URLSearchParams(window.location.search).get('quality');
    if (param === 'low' || param === 'medium' || param === 'high') {
      return param;
    }
  } catch {
    /* ignore */
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'low' || stored === 'medium' || stored === 'high') {
      return stored;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Reads the unmasked GPU renderer string from a throwaway WebGL context.
 * Returns '' when unavailable (the heuristics then fall back to
 * memory/core-count signals).
 */
function probeGpuRenderer(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl');
    if (!gl || !('getParameter' in gl)) return '';
    const ctx = gl;
    const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg
      ? (ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string)
      : (ctx.getParameter(ctx.RENDERER) as string);
    ctx.getExtension('WEBGL_lose_context')?.loseContext();
    return renderer ?? '';
  } catch {
    return '';
  }
}

/** GPUs that should never run the full pipeline. */
const LOW_GPU_PATTERNS: RegExp[] = [
  /swiftshader|llvmpipe|software rasterizer/i, // software rendering
  /\bmali-4\d{2}\b/i, // Mali-400/450 (old budget Android)
  /\bmali-t\d{3}\b/i, // Mali-T6xx/T7xx/T8xx
  /\bmali-g[35]1\b/i, // Mali-G31/G51 entry-level
  /adreno\s*\(tm\)\s*[2345]\d{2}\b/i, // Adreno 2xx-5xx
  /powervr/i, // PowerVR (older iPhones / budget Android)
  /\bvideocore\b/i,
];

/** Capable-but-limited GPUs → medium tier. */
const MEDIUM_GPU_PATTERNS: RegExp[] = [
  /adreno\s*\(tm\)\s*6[0-2]\d\b/i, // Adreno 600-629 (mid-range)
  /\bmali-g[57]\d\b/i, // Mali-G52/G57/G72/G76 etc.
  /intel.*\b(hd|uhd|iris)\b/i, // Intel integrated
  /radeon pro 5[56]\dx?\b/i, // MBP 2016-2019 dGPUs (555X/560X…)
  /radeon (pro )?vega/i, // Vega iGPU/MBP16
  /geforce (gt|mx)\s?\d/i, // entry-level NVIDIA laptop chips
];

/**
 * Chooses the initial quality tier for this device.
 * Order: explicit override → GPU string match → memory/core heuristics.
 */
export function detectQualityTier(): QualityTier {
  const override = readOverride();
  if (override) {
    console.warn(`[quality] Using override tier: ${override}`);
    return override;
  }

  const gpu = probeGpuRenderer();
  const nav = navigator as Navigator & { deviceMemory?: number };
  const memory = nav.deviceMemory ?? 0; // GB, Chromium-only
  const cores = navigator.hardwareConcurrency ?? 0;
  const isMobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent);

  let tier: QualityTier;
  if (LOW_GPU_PATTERNS.some((re) => re.test(gpu))) {
    tier = 'low';
  } else if (MEDIUM_GPU_PATTERNS.some((re) => re.test(gpu))) {
    tier = 'medium';
  } else if (memory > 0 && memory <= 2) {
    tier = 'low';
  } else if ((memory > 0 && memory <= 4) || (isMobile && cores <= 4)) {
    tier = 'medium';
  } else if (isMobile) {
    // Unknown mobile GPU — be conservative, adaptive scaler can't add
    // back what a fixed-function stage (shadows/bloom) already cost.
    tier = 'medium';
  } else {
    tier = 'high';
  }

  console.warn('[quality] Detected tier', {
    tier,
    gpu,
    memory,
    cores,
    isMobile,
  });
  return tier;
}
