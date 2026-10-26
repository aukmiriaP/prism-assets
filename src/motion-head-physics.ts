import type { Object3D, SkinnedMesh } from 'three';
import type { MMDPhysics } from 'three-stdlib';
import { createJointPoseStabilizer } from './motion-pose-stabilizer';

export function isHeadChain(bone: Object3D | null): boolean {
  for (let current = bone; current; current = current.parent)
    if (/^(頭|头|head)(\d+)?$/i.test(current.name)) return true;
  return false;
}

export function createHeadPoseStabilizer(physics: MMDPhysics, mesh: SkinnedMesh, stepSeconds: number) {
  return createJointPoseStabilizer(physics, mesh, stepSeconds, {
    acceptsBone: isHeadChain, acceptsAnchor: isHeadChain, smoothingSeconds: .04,
  });
}
