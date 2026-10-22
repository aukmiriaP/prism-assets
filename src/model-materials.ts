import { Material, Mesh, Object3D } from 'three';

/**
 * Prism's PMX proxy uses Blender DITHERED materials. glTF has no matching mode,
 * so Blender exports BLEND even for solid surfaces. GLTFLoader disables depth
 * writes for BLEND; intersecting body/clothing/face layers then sort incorrectly.
 * Alpha hashing preserves each fragment's alpha while restoring depth occlusion,
 * matching the source preview more closely than object-sorted blending.
 *
 * Scope this to our PMX proxies. Authored FBX/glTF transparency remains untouched.
 * Applying at load time also repairs already-indexed v0.3 proxies without rebuilds.
 */
export function configureModelMaterials(root: Object3D, format: string): void {
  if (format.toLowerCase() !== 'pmx') return;
  const visited = new Set<Material>();
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (visited.has(material) || !material.transparent) continue;
      visited.add(material);
      material.transparent = false;
      material.depthWrite = true;
      material.alphaHash = true;
      material.needsUpdate = true;
    }
  });
}
