import type { Object3D, SkinnedMesh } from 'three';
import type { MMDPhysics } from 'three-stdlib';
import { isHeadChain } from './motion-head-physics';
import { createJointPoseStabilizer } from './motion-pose-stabilizer';

export function isGarmentChain(bone: Object3D | null): boolean {
  if (isHeadChain(bone)) return false;
  for (let current = bone; current; current = current.parent)
    if (/スカート|ｽｶｰﾄ|skirt|裙|dress|cloth|cape|マント|披风|披風/i.test(current.name)) return true;
  return false;
}

/** Keep the waist attached and smooth permitted cloth motion without altering Bullet. */
export function createGarmentPoseStabilizer(physics: MMDPhysics, mesh: SkinnedMesh, stepSeconds: number) {
  return createJointPoseStabilizer(physics, mesh, stepSeconds, {
    acceptsBone: isGarmentChain, acceptsAnchor: () => true, smoothingSeconds: .045,
    // Skirt grids also have lateral ring constraints. Those must not be treated
    // as parents or they progressively twist the entire skirt around the waist.
    skeletalParentOnly: true,
    // Some skirts lock every longitudinal joint and rely on compliant solver
    // motion for their shape. Only pin the kinematic attachment; filtering the
    // dynamic links preserves that bend instead of turning the skirt rigid.
    limitPolicy: 'kinematicAnchor',
  });
}
