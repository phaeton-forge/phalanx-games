import type * as THREE from 'three';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/**
 * Runtime dynamic-resolution scaler.
 *
 * Static tier detection (see `qualitySettings.ts`) can't know the actual
 * headroom of a device, so this class watches real frame times and steps
 * the render resolution down (and bloom off) when FPS drops, then slowly
 * steps back up when there is sustained headroom.
 *
 * Resolution scale is by far the cheapest lever: fragment cost falls with
 * the square of the scale, and on a blurred-background board game a
 * 0.7-0.85x internal resolution is barely noticeable.
 */

/** Progressive internal-resolution steps applied to the base pixel ratio. */
const SCALE_STEPS = [1.0, 0.85, 0.7, 0.55] as const;

/** Below this average FPS we step quality down. */
const FPS_LOW = 45;
/** Above this average FPS (sustained) we step quality back up. */
const FPS_HIGH = 57;
/** Length of one measurement window (ms). */
const WINDOW_MS = 1000;
/** Consecutive "good" windows required before stepping back up. */
const UPSCALE_WINDOWS = 4;
/** Cooldown after any change so measurements settle (ms). */
const COOLDOWN_MS = 2000;
/** Frames longer than this are treated as tab-switch stalls, not lag. */
const STALL_FRAME_MS = 500;

export class AdaptivePerformance {
  private stepIndex = 0;
  private frameCount = 0;
  private windowStart = 0;
  private lastFrameAt = 0;
  private lastChangeAt = 0;
  private goodWindows = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly composer: EffectComposer,
    /** Pixel-ratio cap chosen by the quality preset for this device. */
    private basePixelRatio: number,
    /** Bloom pass to toggle at the lowest step (null when tier has no bloom). */
    private readonly bloomPass: UnrealBloomPass | null
  ) {}

  /** Effective pixel ratio for the current adaptive step. */
  get pixelRatio(): number {
    return this.basePixelRatio * SCALE_STEPS[this.stepIndex];
  }

  /** Re-apply sizing on window resize/orientation change. */
  onResize(width: number, height: number): void {
    this.applyPixelRatio(width, height);
  }

  /** Call once per rendered frame, before `composer.render()`. */
  update(): void {
    const now = performance.now();

    if (this.windowStart === 0) {
      this.windowStart = now;
      this.lastFrameAt = now;
      this.lastChangeAt = now;
      return;
    }

    // Ignore stalls (tab hidden, GC, app switch) вЂ” restart the window.
    if (now - this.lastFrameAt > STALL_FRAME_MS) {
      this.windowStart = now;
      this.frameCount = 0;
      this.lastFrameAt = now;
      return;
    }
    this.lastFrameAt = now;
    this.frameCount++;

    const elapsed = now - this.windowStart;
    if (elapsed < WINDOW_MS) return;

    const fps = (this.frameCount * 1000) / elapsed;
    this.frameCount = 0;
    this.windowStart = now;

    if (now - this.lastChangeAt < COOLDOWN_MS) return;

    if (fps < FPS_LOW && this.stepIndex < SCALE_STEPS.length - 1) {
      this.stepIndex++;
      this.goodWindows = 0;
      this.lastChangeAt = now;
      this.applyStep();
      console.warn(
        `[perf] ${fps.toFixed(0)} fps в†’ lowering render scale to ` +
          `${SCALE_STEPS[this.stepIndex]} (pixelRatio ${this.pixelRatio.toFixed(2)})`
      );
    } else if (fps > FPS_HIGH && this.stepIndex > 0) {
      this.goodWindows++;
      if (this.goodWindows >= UPSCALE_WINDOWS) {
        this.stepIndex--;
        this.goodWindows = 0;
        this.lastChangeAt = now;
        this.applyStep();
        console.warn(
          `[perf] ${fps.toFixed(0)} fps sustained в†’ raising render scale to ` +
            `${SCALE_STEPS[this.stepIndex]}`
        );
      }
    } else {
      this.goodWindows = 0;
    }
  }

  private applyStep(): void {
    this.applyPixelRatio(window.innerWidth, window.innerHeight);
    // At the lowest rung, also drop bloom вЂ” its blur chain re-renders the
    // frame several times and is the priciest remaining post effect.
    if (this.bloomPass) {
      this.bloomPass.enabled = this.stepIndex < SCALE_STEPS.length - 1;
    }
  }

  private applyPixelRatio(width: number, height: number): void {
    const pr = this.pixelRatio;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(width, height);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(width, height);
  }
}
