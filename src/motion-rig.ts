import * as THREE from 'three';
import { MMDLoader, MMDAnimationHelper } from 'three-stdlib';
import type { MotionInfo } from './types';

type BoneKey = { boneName: string; frameNum: number; position: number[]; rotation: number[]; interpolation: number[] };
type MorphKey = { morphName: string; frameNum: number; weight: number };
export type Vmd = {
  metadata: { motionCount: number; morphCount: number; cameraCount: number };
  motions: BoneKey[]; morphs: MorphKey[]; cameras: { frameNum: number; perspective: number; position: number[]; rotation: number[] }[];
  switches: { frameNum: number; visible: boolean; iks: { name: string; enabled: boolean }[] }[];
  info: MotionInfo;
};
type Pmx = {
  textures: string[];
  materials: { name: string; diffuse: number[]; textureIndex: number; flag: number }[];
};
// The library's declarations omit its builders and seek helpers; contain that adapter here.
type LoaderInternals = {
  _getParser(): { parsePmx(data: ArrayBuffer, rightHanded: boolean): Pmx };
  meshBuilder: { materialBuilder: { build: (data: Pmx) => THREE.Material[] }; build(data: Pmx, path: string): THREE.SkinnedMesh };
  animationBuilder: { build(data: Vmd, mesh: THREE.SkinnedMesh): THREE.AnimationClip; buildCameraAnimation(data: Vmd): THREE.AnimationClip };
};
type SeekHelper = MMDAnimationHelper & {
  _restoreBones(mesh: THREE.SkinnedMesh): void; _saveBones(mesh: THREE.SkinnedMesh): void;
  objects: WeakMap<THREE.Object3D, { mixer: THREE.AnimationMixer }>;
};

export const createMotionLoader = () => new MMDLoader() as unknown as LoaderInternals;

export function buildMotionMesh(buffer: ArrayBuffer) {
  const loader = createMotionLoader();
  const data = loader._getParser().parsePmx(buffer, true);
  const materials: THREE.MeshStandardMaterial[] = [];
  loader.meshBuilder.materialBuilder.build = () => {
    for (const m of data.materials) {
      materials.push(new THREE.MeshStandardMaterial({
        name: m.name, color: new THREE.Color().fromArray(m.diffuse),
        opacity: m.diffuse[3], transparent: m.diffuse[3] < .999,
        side: m.flag & 1 ? THREE.DoubleSide : THREE.FrontSide,
        roughness: .85, metalness: 0, alphaTest: .01,
      }));
    }
    return materials;
  };
  const mesh = loader.meshBuilder.build(data, '');
  mesh.frustumCulled = false;
  return { mesh, data, materials, loader };
}

export function mergeMotion(body: Vmd, facial?: Vmd): Vmd {
  if (!facial) return body;
  const boneNames = new Set(facial.motions.map(k => k.boneName));
  const morphNames = new Set(facial.morphs.map(k => k.morphName));
  const motions = [...body.motions.filter(k => !boneNames.has(k.boneName)), ...facial.motions];
  const morphs = [...body.morphs.filter(k => !morphNames.has(k.morphName)), ...facial.morphs];
  return { ...body, metadata: { ...body.metadata, motionCount: motions.length, morphCount: morphs.length },
    motions, morphs, info: { ...body.info, active_bones: [...new Set([...body.info.active_bones, ...facial.info.active_bones])] } };
}

export function animateMotion(mesh: THREE.SkinnedMesh, loader: LoaderInternals, data: Vmd,
  camera?: THREE.PerspectiveCamera, cameraData?: Vmd) {
  const helper = new MMDAnimationHelper({ sync: false, pmxAnimation: true } as ConstructorParameters<typeof MMDAnimationHelper>[0]) as SeekHelper;
  const clip = loader.animationBuilder.build(data, mesh);
  clip.duration = Math.max(data.info.duration, 1 / 30);
  helper.add(mesh, { animation: clip, physics: false });
  const mixer = helper.objects.get(mesh)!.mixer!;
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true;
  const cameraOffset = new THREE.Vector3();
  let cameraMixer: THREE.AnimationMixer | undefined, cameraAction: THREE.AnimationAction | undefined;
  if (camera && cameraData?.cameras.length) {
    const cameraClip = loader.animationBuilder.buildCameraAnimation(cameraData);
    // Interpolate distance separately: rotate the offset, then add the world-space target.
    // The legacy builder rotates the target as well, which shifts tilted shots.
    const offsetClip = loader.animationBuilder.buildCameraAnimation({ ...cameraData,
      cameras: cameraData.cameras.map(key => ({ ...key, position: [0, 0, 0], rotation: [0, 0, 0] })) });
    const offsetTrack = offsetClip.tracks.find(track => track.name === '.position')!;
    Object.assign(camera, { motionOffset: cameraOffset });
    offsetTrack.name = '.motionOffset';
    cameraClip.tracks = [...cameraClip.tracks.filter(track => track.name !== '.position'), offsetTrack];
    helper.add(camera, { animation: cameraClip });
    helper.enable('cameraAnimation', false);
    cameraMixer = helper.objects.get(camera)!.mixer!;
    cameraAction = cameraMixer.clipAction(cameraClip);
    cameraAction.setLoop(THREE.LoopOnce, 1); cameraAction.clampWhenFinished = true;
  }
  const iks = mesh.geometry.userData.MMD.iks as { target: number; links: { enabled: boolean }[] }[];
  const sample = (time: number) => {
    const frame = time * 30 + 1e-5, flags = new Map<string, boolean>();
    mesh.visible = true;
    for (const key of data.switches) {
      if (key.frameNum > frame) break;
      mesh.visible = key.visible;
      for (const ik of key.iks) flags.set(ik.name, ik.enabled);
    }
    for (const ik of iks) {
      const enabled = flags.get(mesh.skeleton.bones[ik.target].name) ?? true;
      for (const link of ik.links) link.enabled = enabled;
    }
    // Mixer sampling must start from the un-solved pose saved before IK/grants.
    helper._restoreBones(mesh);
    action.paused = false; action.enabled = true;
    mixer.setTime(Math.min(time, clip.duration));
    helper._saveBones(mesh);
    if (cameraAction && cameraMixer) {
      cameraAction.paused = false; cameraAction.enabled = true;
      cameraMixer.setTime(time);
    }
    helper.update(0);
    if (camera && cameraMixer) {
      camera.position.copy(cameraOffset).applyQuaternion(camera.quaternion).add(helper.cameraTarget.position);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
    }
    mesh.updateMatrixWorld(true); mesh.skeleton.update();
  };
  const matched = data.info.active_bones.filter(name => mesh.skeleton.getBoneByName(name));
  const missing = data.info.active_bones.filter(name => !mesh.skeleton.getBoneByName(name));
  const missingMorphs = [...new Set(data.morphs.map(k => k.morphName))]
    .filter(name => mesh.morphTargetDictionary?.[name] === undefined);
  return { sample, matched, missing, missingMorphs, dispose() {
    mixer.stopAllAction(); mixer.uncacheRoot(mesh); helper.remove(mesh);
    if (camera && cameraMixer) { cameraMixer.stopAllAction(); cameraMixer.uncacheRoot(camera); helper.remove(camera); }
  } };
}
