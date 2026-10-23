import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Download, LoaderCircle, Palette, RotateCcw, X } from 'lucide-react';
import type { Asset, Connection, MaterialBinding, MaterialConfig, MaterialInspection, MaterialPreview, MaterialRole } from './types';
import './materials.css';

const roles: [MaterialRole, string][] = [['base_color', '基础色'], ['normal', '法线'], ['roughness', '粗糙度'],
  ['metallic', '金属度'], ['ao', '环境遮蔽 AO'], ['emissive', '自发光'], ['opacity', '透明度']];
const rgbRoles = new Set(['base_color', 'normal', 'emissive']);
const cleanError = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': Error: /, '');

export function MaterialCanvas({ config, urls }: { config: MaterialConfig; urls: Partial<Record<MaterialRole, string>> }) {
  const mount = useRef<HTMLDivElement>(null);
  const material = useRef<THREE.MeshStandardMaterial | null>(null);
  const object = useRef<THREE.Mesh | null>(null);
  const reset = useRef(() => {});
  const [shape, setShape] = useState('sphere');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadedKey, setLoadedKey] = useState('');
  const sourceKey = JSON.stringify(urls);
  const latest = useRef(config); latest.current = config;
  const update = () => {
    const mat = material.current, c = latest.current;
    if (!mat) return;
    mat.color.set(c.color); mat.roughness = c.roughness; mat.metalness = c.metallic;
    mat.normalScale.set(c.normal_strength, c.normal_strength);
    mat.emissive.set(mat.emissiveMap ? '#ffffff' : '#000000'); mat.emissiveIntensity = c.emissive_strength;
    mat.opacity = c.opacity;
    const transparent = c.opacity < 1 || Boolean(mat.alphaMap);
    if (mat.transparent !== transparent) { mat.transparent = transparent; mat.needsUpdate = true; }
    mat.depthWrite = !transparent;
    for (const value of Object.values(mat)) if (value instanceof THREE.Texture) value.repeat.set(c.repeat, c.repeat);
  };
  useEffect(() => { update(); }, [config]);
  useEffect(() => {
    if (!mount.current) return;
    const holder = mount.current;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
    catch { setError('无法启动材质预览，请检查系统图形支持。'); return; }
    setError(''); setLoading(true);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    holder.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(room, .04);
    scene.environment = environment.texture;
    room.dispose(); pmrem.dispose();
    const appearance = () => { scene.background = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--stage').trim()); };
    appearance(); window.addEventListener('prism-appearance-change', appearance);
    const camera = new THREE.PerspectiveCamera(38, 1, .01, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.enablePan = false; controls.minDistance = 2.3; controls.maxDistance = 8;
    reset.current = () => { camera.position.set(.2, .15, 4.5); controls.target.set(0, 0, 0); controls.update(); };
    reset.current();
    const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
    material.current = mat;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), mat);
    object.current = mesh; scene.add(mesh);
    const urlsNow = JSON.parse(sourceKey) as Partial<Record<MaterialRole, string>>;
    let stopped = false;
    const textures: THREE.Texture[] = [];
    const slots: Record<MaterialRole, string> = { base_color: 'map', normal: 'normalMap', roughness: 'roughnessMap',
      metallic: 'metalnessMap', ao: 'aoMap', emissive: 'emissiveMap', opacity: 'alphaMap' };
    Promise.all(Object.entries(urlsNow).map(async ([role, url]) => {
      const texture = await new THREE.TextureLoader().loadAsync(url);
      if (stopped) { texture.dispose(); return; }
      textures.push(texture);
      texture.colorSpace = ['base_color', 'emissive'].includes(role) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
      (mat as unknown as Record<string, unknown>)[slots[role as MaterialRole]] = texture;
      mat.needsUpdate = true; update();
    })).then(() => { if (!stopped) { setLoading(false); setLoadedKey(sourceKey); } }).catch(() => {
      if (!stopped) { setLoading(false); setError('部分贴图预览无法读取，请刷新预览或检查源文件。'); }
    });
    update();
    const observer = new ResizeObserver(() => {
      camera.aspect = holder.clientWidth / Math.max(holder.clientHeight, 1);
      camera.updateProjectionMatrix(); renderer.setSize(holder.clientWidth, holder.clientHeight);
    });
    observer.observe(holder);
    renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
    return () => {
      stopped = true; observer.disconnect(); window.removeEventListener('prism-appearance-change', appearance);
      renderer.setAnimationLoop(null); controls.dispose(); mesh.geometry.dispose(); mat.dispose();
      textures.forEach(t => t.dispose()); environment.dispose();
      material.current = null; object.current = null; renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    };
  }, [sourceKey]);
  useEffect(() => {
    const mesh = object.current;
    if (!mesh) return;
    mesh.geometry.dispose();
    mesh.geometry = shape === 'plane' ? new THREE.PlaneGeometry(2, 2) : shape === 'cube'
      ? new THREE.BoxGeometry(1.65, 1.65, 1.65) : new THREE.SphereGeometry(1, 64, 48);
    mesh.rotation.set(shape === 'cube' ? .25 : 0, shape === 'cube' ? -.4 : 0, 0);
  }, [shape, sourceKey]);
  return <div className="material-stage" data-ready={sourceKey === loadedKey && Object.keys(urls).length > 0}>
    <div className="material-canvas" ref={mount} aria-label="可旋转材质画布">
      {loading && <div className="material-stage-status"><LoaderCircle className="spin" size={16}/>加载贴图</div>}
      {error && <div className="material-stage-status material-stage-error">{error}</div>}
    </div>
    <div className="material-stage-toolbar">
      <div role="group" aria-label="预览形状">{[['sphere', '材质球'], ['plane', '平面'], ['cube', '立方体']].map(([value, name]) =>
        <button key={value} aria-pressed={shape === value} className={shape === value ? 'active' : ''} onClick={() => setShape(value)}>{name}</button>)}</div>
      <button title="复位材质视角" onClick={() => reset.current()}><RotateCcw size={14}/></button>
    </div>
    <p>拖动旋转 · 滚轮缩放 · 标准 PBR 工作室光照</p>
  </div>;
}

function mapUrls(connection: Connection, metadata: MaterialPreview | null, aid?: string) {
  const urls: Partial<Record<MaterialRole, string>> = {};
  if (metadata) for (const [role] of roles) if (metadata.maps[role]) urls[role] = aid
    ? `${connection.base}/assets/${aid}/material/${role}/preview?token=${connection.token}&v=${metadata.cache}`
    : `${connection.base}/materials/previews/${metadata.preview_id}/${role}/preview?token=${connection.token}`;
  return urls;
}

export function MaterialEditor({ inspection, asset, connection, close, saved }: {
  inspection: MaterialInspection; asset?: Asset; connection: Connection; close: () => void; saved: (asset: Asset) => void;
}) {
  const [config, setConfig] = useState<MaterialConfig>(asset?.material?.config || inspection.config);
  const [preview, setPreview] = useState<MaterialPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);
  const [converting, setConverting] = useState(true);
  const [revision, setRevision] = useState(0);
  const mappingKey = JSON.stringify([config.source_dir, config.maps, config.normal_format]);
  useEffect(() => {
    let stopped = false;
    setConverting(true); setPreviewError('');
    const timer = setTimeout(() => {
      window.prism.api<MaterialPreview>('/materials/preview', 'POST', { config }).then(result => {
        if (!stopped) { setPreview(result); setConverting(false); }
      }).catch(error => { if (!stopped) { setPreviewError(cleanError(error)); setConverting(false); } });
    }, 220);
    return () => { stopped = true; clearTimeout(timer); };
  }, [mappingKey, revision]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) { event.stopImmediatePropagation(); close(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [close, busy]);
  const patch = (changes: Partial<MaterialConfig>) => setConfig(old => ({ ...old, ...changes }));
  const binding = (role: MaterialRole, changes: Partial<MaterialBinding>, remove = false) => {
    const maps = { ...config.maps };
    if (remove) delete maps[role];
    else maps[role] = { file: '', channel: rgbRoles.has(role) ? 'rgb' : 'r', invert: false, ...maps[role], ...changes };
    const factors: Partial<MaterialConfig> = {};
    if (!config.maps[role] && maps[role] && (role === 'metallic' || role === 'roughness')) factors[role] = 1;
    patch({ maps, ...factors });
  };
  const save = async () => {
    setBusy(true); setSaveError('');
    try { saved(await window.prism.api<Asset>(asset ? `/materials/${asset.id}` : '/materials', asset ? 'PATCH' : 'POST', { config })); }
    catch (error) { setSaveError(cleanError(error)); setBusy(false); }
  };
  const sliders: [keyof MaterialConfig, string, number, number, number][] = [
    ['roughness', '粗糙度', 0, 1, .01], ['metallic', '金属度', 0, 1, .01],
    ['normal_strength', '法线强度', 0, 4, .05], ['repeat', 'UV 重复', .25, 16, .25],
    ['emissive_strength', '自发光强度', 0, 10, .1], ['opacity', '透明度', 0, 1, .01]];
  return <div className="material-overlay" onClick={() => { if (!busy) close(); }}>
    <section className="material-dialog" role="dialog" aria-label={asset ? '编辑 PBR 材质' : '导入 PBR 材质'} onClick={e => e.stopPropagation()}>
      <header><Palette size={18}/><strong>{asset ? '编辑 PBR 材质' : '导入 PBR 材质'}</strong>
        <span>{inspection.files.length} 张贴图</span><button title="关闭材质编辑" disabled={busy} onClick={close}><X size={20}/></button></header>
      <div className="material-editor-body">
        <MaterialCanvas config={config} urls={mapUrls(connection, preview)}/>
        <div className="material-controls">
          <label className="material-name">材质名称<input aria-label="材质名称" value={config.name} maxLength={128} onChange={e => patch({ name: e.target.value })}/></label>
          <p className="material-source" title={config.source_dir}>{config.source_dir}</p>
          <h3>贴图通道</h3>
          {roles.map(([role, label]) => <div className="material-channel" key={role}>
            <label>{label}<select aria-label={`${label}贴图`} value={config.maps[role]?.file || ''} onChange={e => binding(role, { file: e.target.value }, !e.target.value)}>
              <option value="">不使用贴图</option>
              {config.maps[role] && !inspection.files.some(file => file.file === config.maps[role]?.file) &&
                <option value={config.maps[role]?.file}>{config.maps[role]?.file} · 文件缺失</option>}
              {inspection.files.map(file => <option key={file.file} value={file.file}>{file.file} · {file.width} × {file.height}</option>)}
            </select></label>
            {!rgbRoles.has(role) && config.maps[role] && <div className="material-channel-options">
              <select aria-label={`${label}通道`} value={config.maps[role]?.channel} onChange={e => binding(role, { channel: e.target.value })}>
                {['r', 'g', 'b', 'a'].map(c => <option key={c} value={c} disabled={c === 'a' && !inspection.files.find(f => f.file === config.maps[role]?.file)?.alpha}>{c.toUpperCase()}</option>)}
              </select>
              <label><input type="checkbox" aria-label={`${label}反相`} checked={config.maps[role]?.invert || false} onChange={e => binding(role, { invert: e.target.checked })}/>反相</label>
              <small>线性数据</small>
            </div>}
          </div>)}
          <label className="material-convention">法线约定<select aria-label="法线约定" value={config.normal_format} onChange={e => patch({ normal_format: e.target.value as 'opengl' | 'directx' })}>
            <option value="opengl">OpenGL · +Y</option><option value="directx">DirectX · −Y</option></select></label>
          <h3>表面参数</h3>
          <label className="material-color">材质颜色<input type="color" aria-label="材质颜色" value={config.color} onChange={e => patch({ color: e.target.value })}/><small>{config.color}</small></label>
          {sliders.map(([key, name, min, max, step]) => <label className="material-slider" key={key}><span>{name}<output>{Number(config[key]).toFixed(key === 'repeat' ? 2 : 2)}</output></span>
            <input type="range" aria-label={name} min={min} max={max} step={step} value={Number(config[key])} onChange={e => patch({ [key]: Number(e.target.value) })}/>
          </label>)}
          <p className="material-hint">有贴图时，粗糙度、金属度和透明度参数作为贴图乘数。预览贴图最长边为 2048 px。</p>
          {Array.from(new Set([...inspection.warnings, ...(preview?.warnings || [])])).map((warning, i) => <p className="material-hint" key={i}>{warning}</p>)}
        </div>
      </div>
      <footer><div>{previewError || saveError ? <span className="asset-error" role="alert">{saveError || previewError}</span>
        : converting ? <span><LoaderCircle size={14} className="spin"/>更新贴图预览…</span> : <span>原始贴图保留在当前文件夹</span>}</div>
        <button disabled={busy || converting} onClick={() => setRevision(r => r + 1)}>刷新预览</button>
        <button disabled={busy} onClick={close}>取消</button>
        <button className="primary" disabled={busy || !config.name.trim() || !Object.keys(config.maps).length} onClick={save}>{busy ? '保存中…' : asset ? '保存修改' : '导入材质'}</button>
      </footer>
    </section>
  </div>;
}

export function MaterialViewer({ asset, connection, close }: { asset: Asset; connection: Connection; close: () => void }) {
  const metadata = asset.material?.published;
  return <div className="material-overlay" onClick={close}><section className="material-dialog material-view-dialog" role="dialog" aria-label="PBR 材质预览" onClick={e => e.stopPropagation()}>
    <header><Palette size={18}/><strong>{asset.name}</strong><span>PBR 材质</span><button title="关闭材质预览" onClick={close}><X size={20}/></button></header>
    {metadata ? <MaterialCanvas config={metadata.config} urls={mapUrls(connection, metadata, asset.id)}/> : <p className="material-empty">交互预览尚未生成，请编辑材质或重试索引。</p>}
    {asset.status !== 'ready' && <p className="material-hint">正在显示上次成功生成的材质，请完成索引后查看最新修改。</p>}
  </section></div>;
}

export function MaterialDetails({ asset, edit, exported, removed }: { asset: Asset; edit: () => void; exported: (path: string) => void; removed: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => { setConfirmRemove(false); setError(''); }, [asset.id]);
  const config = asset.material?.config;
  if (!config) return null;
  const action = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(cleanError(e)); } finally { setBusy(false); } };
  return <div className="detail-section material-details"><h3>PBR 材质</h3>
    <div className="material-detail-channels">{roles.filter(([role]) => config.maps[role]).map(([role, name]) =>
      <div key={role}><span>{name}</span><small title={config.maps[role]?.file}>{config.maps[role]?.file}</small></div>)}</div>
    <button className="text-action" onClick={edit}>编辑通道与表面参数</button>
    <button className="text-action" disabled={busy || asset.status !== 'ready'} onClick={() => action(async () => { const path = await window.prism.exportMaterial(asset.id); if (path) exported(path); })}><Download size={14}/> 导出 Blender 材质包</button>
    <p className="material-hint">配套插件：文件 → 导入 → Prism PBR 材质包。将材质应用到选中的网格。</p>
    {confirmRemove ? <div className="material-remove"><p>移除材质定义及其整理记录？原始贴图保留。</p>
      <button disabled={busy} onClick={() => setConfirmRemove(false)}>取消</button><button disabled={busy} onClick={() => action(async () => { await window.prism.api(`/materials/${asset.id}`, 'DELETE'); removed(); })}>确认移除</button></div>
      : <button className="text-action" onClick={() => setConfirmRemove(true)}>移除材质定义</button>}
    {error && <p className="asset-error" role="alert">{error}</p>}
  </div>;
}
