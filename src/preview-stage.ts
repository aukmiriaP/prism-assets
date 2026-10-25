import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

type PreviewPreferences = { grid: boolean; shadows: boolean };
const STORAGE = 'prism.preview-stage.v1', CHANGE = 'prism-preview-stage-change';
const defaults: PreviewPreferences = { grid: false, shadows: true };
function readPreferences(): PreviewPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE) || '{}');
    return { grid: typeof stored?.grid === 'boolean' ? stored.grid : defaults.grid,
      shadows: typeof stored?.shadows === 'boolean' ? stored.shadows : defaults.shadows };
  } catch { return { ...defaults }; }
}
let preferences = readPreferences();
export const getPreviewPreferences = () => preferences;
export function subscribePreviewPreferences(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === STORAGE || event.key === null) { preferences = readPreferences(); listener(); }
  };
  window.addEventListener(CHANGE, listener);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener(CHANGE, listener); window.removeEventListener('storage', storage); };
}
export function setPreviewPreferences(patch: Partial<PreviewPreferences>) {
  preferences = { ...preferences, ...patch };
  try { localStorage.setItem(STORAGE, JSON.stringify(preferences)); } catch { /* Keep this session's preferences. */ }
  window.dispatchEvent(new Event(CHANGE));
}

/** Shared stage for static models and animated rigs, without changing asset coordinates. */
export function createPreviewStage(holder: HTMLDivElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  holder.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xa7a8b0, 2.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.5);
  key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -.0002;
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0xdbe4ed, 1.3);
  scene.add(rim, rim.target);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: .15 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const grid = new THREE.GridHelper(1, 40); scene.add(grid);
  const camera = new THREE.PerspectiveCamera(38, 1, .01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  let aspect = 1, stopped = false;
  const resize = () => {
    const width = Math.max(holder.clientWidth, 1), height = Math.max(holder.clientHeight, 1);
    aspect = width / height; camera.aspect = aspect; camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  };
  const observer = new ResizeObserver(resize); observer.observe(holder); resize();
  const updateAppearance = () => {
    const style = getComputedStyle(document.documentElement);
    scene.background = new THREE.Color(style.getPropertyValue('--stage').trim());
    const colors = new THREE.GridHelper(1, 40,
      style.getPropertyValue('--stage-axis').trim(), style.getPropertyValue('--stage-grid').trim());
    grid.geometry.setAttribute('color', colors.geometry.getAttribute('color').clone());
    colors.geometry.dispose(); (colors.material as THREE.Material).dispose();
  };
  const updatePreferences = () => {
    grid.visible = preferences.grid;
    ground.visible = preferences.shadows;
  };
  updateAppearance(); updatePreferences();
  window.addEventListener('prism-appearance-change', updateAppearance);
  const unsubscribe = subscribePreviewPreferences(updatePreferences);
  const reset = () => {
    // Consume pending orbit/pan deltas before restoring the saved view.
    const damping = controls.enableDamping;
    controls.enableDamping = false; controls.update(); controls.reset(); controls.enableDamping = damping;
  };
  const frame = (bounds: THREE.Box3, floorY = bounds.min.y) => {
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
    const scale = Math.max(size.x, size.y, size.z, .001);
    ground.scale.setScalar(scale * 6); ground.position.set(center.x, floorY + scale * .0005, center.z);
    grid.scale.setScalar(scale * 4); grid.position.set(center.x, floorY + scale * .001, center.z);
    key.position.copy(center).add(new THREE.Vector3(.85, 1.4, 1.4).multiplyScalar(scale));
    rim.position.copy(center).add(new THREE.Vector3(-.85, .8, -.85).multiplyScalar(scale));
    key.target.position.copy(center); rim.target.position.copy(center);
    key.shadow.normalBias = scale * .002;
    Object.assign(key.shadow.camera, { left: -scale * 1.25, right: scale * 1.25,
      top: scale * 1.25, bottom: -scale * 1.25, near: scale * .01, far: scale * 6 });
    key.shadow.camera.updateProjectionMatrix();
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const distance = Math.max(size.y, size.x / aspect) / (2 * Math.tan(halfFov)) * 1.3 + size.z / 2;
    camera.near = scale * .005; camera.far = scale * 100; camera.updateProjectionMatrix();
    controls.minDistance = scale * .1; controls.maxDistance = scale * 15;
    // Clear any previous orbit momentum before saving a new home view.
    reset(); camera.position.copy(center).add(new THREE.Vector3(0, scale * .12, distance));
    controls.target.copy(center); controls.update(); controls.saveState();
  };
  return {
    scene, camera, controls,
    frame,
    reset,
    start(tick?: (elapsed: number) => THREE.PerspectiveCamera | undefined) {
      let previous = performance.now();
      renderer.setAnimationLoop(now => {
        if (stopped) return;
        const elapsed = Math.max(0, Math.min((now - previous) / 1000, .15)); previous = now;
        const activeCamera = tick?.(elapsed) || camera;
        controls.enabled = activeCamera === camera;
        if (controls.enabled) controls.update();
        if (activeCamera.aspect !== aspect) { activeCamera.aspect = aspect; activeCamera.updateProjectionMatrix(); }
        renderer.render(scene, activeCamera);
      });
    },
    dispose() {
      stopped = true; renderer.setAnimationLoop(null); observer.disconnect(); controls.dispose();
      unsubscribe(); window.removeEventListener('prism-appearance-change', updateAppearance);
      grid.geometry.dispose(); (grid.material as THREE.Material).dispose();
      ground.geometry.dispose(); ground.material.dispose(); key.shadow.dispose();
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); scene.clear();
    },
  };
}
