import * as THREE from 'three';

/**
 * Shared texture-quality state, set once the renderer (and therefore its
 * GPU capabilities) is available. `setupScene` calls {@link setMaxAnisotropy}
 * right after creating the `WebGLRenderer`; mesh factories (`BoardMesh`,
 * `CheckerMesh`, and `SceneSetup` itself) call {@link applyTextureQuality}
 * on every texture they use so board/checker surfaces stay crisp at
 * grazing viewing angles instead of blurring out on mobile GPUs.
 */
let maxAnisotropy = 1;

/** Call once, right after the WebGLRenderer is created. */
export function setMaxAnisotropy(value: number): void {
  maxAnisotropy = value;
}

/**
 * Applies mipmapped trilinear filtering + max anisotropy to a texture.
 * Safe to call on textures shared across meshes/materials (e.g. cloned
 * or reused instances) — it only sets properties, never re-uploads data
 * unless `needsUpdate` triggers a GPU-side filter change.
 */
export function applyTextureQuality<T extends THREE.Texture>(texture: T): T {
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
  return texture;
}
