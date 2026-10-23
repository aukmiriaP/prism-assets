import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Box, FolderOpen, LoaderCircle, RotateCcw, X } from 'lucide-react';
import type { Asset, Connection, ModelResource } from './types';
import { configureModelMaterials } from './model-materials';
import './model.css';

export function ModelViewer({ asset, connection, close }: { asset: Asset; connection: Connection; close: () => void }) {
  const mount = useRef<HTMLDivElement>(null);
  const reset = useRef<() => void>(() => {});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [material, setMaterial] = useState('');
  const objects = useRef<THREE.Mesh[]>([]);
  useEffect(() => {
    if (!mount.current) return;
    setError(''); setLoading(true);
    const holder = mount.current;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      setError('无法启动 3D 预览，请检查系统图形支持。'); setLoading(false); return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;
    holder.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x7d8592, 3));
    const key = new THREE.DirectionalLight(0xffffff, 3);
    key.position.set(3, 5, 4); scene.add(key);
    const fill = new THREE.DirectionalLight(0xcedaff, 2);
    fill.position.set(-3, 2, -4); scene.add(fill);
    const camera = new THREE.PerspectiveCamera(38, 1, .01, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.minDistance = .4; controls.maxDistance = 15;
    reset.current = () => { camera.position.set(.7, .35, 4.2); controls.target.set(0, 0, 0); controls.update(); };
    reset.current();
    const grid = new THREE.GridHelper(6, 24, 0x626875, 0x373d48);
    grid.position.y = -1.04; scene.add(grid);
    const updateAppearance = () => {
      const style = getComputedStyle(document.documentElement);
      scene.background = new THREE.Color(style.getPropertyValue('--stage').trim());
      const themedGrid = new THREE.GridHelper(6, 24,
        style.getPropertyValue('--stage-axis').trim(), style.getPropertyValue('--stage-grid').trim());
      const colors = grid.geometry.getAttribute('color') as THREE.BufferAttribute;
      colors.copy(themedGrid.geometry.getAttribute('color') as THREE.BufferAttribute);
      colors.needsUpdate = true;
      themedGrid.geometry.dispose(); (themedGrid.material as THREE.Material).dispose();
    };
    updateAppearance();
    window.addEventListener('prism-appearance-change', updateAppearance);
    let stopped = false;
    const disposeMesh = (mesh: THREE.Mesh) => {
      mesh.geometry.dispose();
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const value of Object.values(mat)) if (value instanceof THREE.Texture) {
          if (value.image && typeof value.image.close === 'function') value.image.close();
          value.dispose();
        }
        mat.dispose();
      }
    };
    const loader = new GLTFLoader();
    loader.setRequestHeader({ Authorization: `Bearer ${connection.token}` });
    loader.load(`${connection.base}/assets/${asset.id}/model?v=${asset.model?.cache}`, gltf => {
      if (stopped) { gltf.scene.traverse(o => { if (o instanceof THREE.Mesh) disposeMesh(o); }); return; }
      configureModelMaterials(gltf.scene, asset.ext);
      objects.current = [];
      gltf.scene.traverse(o => { if (o instanceof THREE.Mesh) objects.current.push(o); });
      scene.add(gltf.scene); setLoading(false);
    }, undefined, () => { if (!stopped) { setError('模型预览暂不可用，请等待索引完成或在索引任务中重试。'); setLoading(false); } });
    const observer = new ResizeObserver(() => {
      camera.aspect = holder.clientWidth / Math.max(holder.clientHeight, 1);
      camera.updateProjectionMatrix(); renderer.setSize(holder.clientWidth, holder.clientHeight);
    });
    observer.observe(holder);
    renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
    return () => {
      window.removeEventListener('prism-appearance-change', updateAppearance);
      stopped = true; observer.disconnect(); renderer.setAnimationLoop(null); controls.dispose();
      objects.current.forEach(disposeMesh); objects.current = [];
      grid.geometry.dispose(); (grid.material as THREE.Material).dispose();
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    };
  }, [asset.id, asset.model?.cache, connection]);
  useEffect(() => {
    objects.current.forEach(mesh => {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach(mat => { if ('wireframe' in mat) (mat as THREE.MeshStandardMaterial).wireframe = wireframe; });
      mesh.visible = !material || materials.some(m => m.name === material);
    });
  }, [wireframe, material, loading]);
  return <div className="model-overlay" role="dialog" aria-label="3D 模型预览">
    <section className="model-dialog">
      <header><Box size={20}/><strong>{asset.name}</strong><span>{asset.ext.toUpperCase()} · 静态预览</span><button title="关闭预览" onClick={close}><X size={22}/></button></header>
      <div className="model-canvas" ref={mount} aria-label="可旋转模型画布">
        {loading && <div className="model-loading"><LoaderCircle className="spin"/> 正在加载模型…</div>}
        {error && <div className="model-loading">{error}</div>}
      </div>
      <div className="model-toolbar">
        <button onClick={() => { setMaterial(''); reset.current(); }}><RotateCcw size={14}/> 复位视角</button>
        <label><input type="checkbox" checked={wireframe} onChange={e => setWireframe(e.target.checked)}/>线框</label>
        <select aria-label="隔离材质" value={material} onChange={e => setMaterial(e.target.value)}><option value="">全部材质</option>
          {asset.model?.materials.map((m, i) => <option key={i} value={m.name}>{m.name}</option>)}</select>
        <span>左键旋转 · 滚轮缩放 · 右键平移</span>
      </div>
      <p className="model-caveat">{asset.model?.warnings.join(' ')}</p>
    </section>
  </div>;
}

export function ModelDetails({ asset, connection }: { asset: Asset; connection: Connection }) {
  const [tab, setTab] = useState<'materials' | 'bound' | 'auxiliary'>('materials');
  const [reference, setReference] = useState<{ index: number; resource: ModelResource } | null>(null);
  const [imageError, setImageError] = useState(false);
  useEffect(() => { setReference(null); setTab('materials'); }, [asset.id]);
  const model = asset.model;
  if (!model) return null;
  const resourceUrl = (index: number) => `${connection.base}/assets/${asset.id}/resources/${index}/preview?token=${connection.token}&v=${model.cache}`;
  const show = (index: number) => { setImageError(false); setReference({ index, resource: model.resources[index] }); };
  const resourceRow = (r: ModelResource, i: number) => <div className="resource-row" key={i}>
    {r.kind === 'texture' && r.exists && !r.embedded ? <button className="resource-thumb" onClick={() => show(i)} title="预览贴图">
      <img loading="lazy" src={resourceUrl(i)} alt={r.reference}/></button> : <Box size={20}/>}
    <div><strong title={r.reference}>{r.reference.split(/[\\/]/).pop()}</strong>
      <small>{r.embedded ? '内嵌于模型' : !r.exists ? '文件缺失' : r.relation === 'auxiliary' ? '未发现材质引用' : r.materials.map(m => m.role).filter((v, n, a) => a.indexOf(v) === n).join(' · ') || '模型依赖'}</small></div>
    {r.path && <button title="在 Finder 定位资源" onClick={() => window.prism.reveal(r.path)}><FolderOpen size={14}/></button>}
  </div>;
  return <div className="detail-section model-details"><h3>模型与资源</h3>
    <div className="model-metrics"><span><b>{model.triangles.toLocaleString()}</b>三角面</span><span><b>{model.materials.length}</b>材质</span><span><b>{model.bound_textures}</b>引用贴图</span></div>
    {model.missing_resources > 0 && <p className="asset-error">{model.missing_resources} 个资源缺失，预览可能不完整</p>}
    <div className="resource-tabs">
      <button className={tab === 'materials' ? 'active' : ''} onClick={() => setTab('materials')}>材质</button>
      <button className={tab === 'bound' ? 'active' : ''} onClick={() => setTab('bound')}>已引用</button>
      <button className={tab === 'auxiliary' ? 'active' : ''} onClick={() => setTab('auxiliary')}>辅助文件</button>
    </div>
    {tab === 'materials' ? <div className="material-list">{model.materials.map((m, i) => <details key={i}><summary>{m.name}<span>{m.bindings.length} 绑定</span></summary>
      {m.bindings.length ? m.bindings.map((b, n) => <div className="material-binding" key={n}><small>{b.role}</small><button onClick={() => show(b.resource_index)} title={b.reference}>{b.reference.split(/[\\/]/).pop()}</button>{!b.exists && <em>缺失</em>}</div>) : <p>纯色 / 无纹理绑定</p>}</details>)}</div>
      : <div className="resource-list">{tab === 'auxiliary' && <p>同目录资源供查阅，未自动推断材质通道。</p>}{model.resources.map((r, i) => r.relation === tab ? resourceRow(r, i) : null)}</div>}
    {model.comment && <details className="model-notes"><summary>模型说明与使用约定</summary><p>{model.comment}</p></details>}
    {reference && <div className="resource-modal" role="dialog" aria-label="贴图资源预览" onClick={() => setReference(null)}>
      <section onClick={e => e.stopPropagation()}><header><strong>{reference.resource.reference}</strong><button title="关闭贴图" onClick={() => setReference(null)}><X size={20}/></button></header>
        {reference.resource.embedded ? <p>纹理内嵌于模型，可在 3D 预览中查看对应材质。</p> : !reference.resource.exists || imageError ? <p>贴图无法读取，请检查文件。</p>
          : <img src={resourceUrl(reference.index)} alt={reference.resource.reference} onError={() => setImageError(true)}/>}
        <p>{reference.resource.materials.map(m => `${m.name} → ${m.role}`).join('；')}</p>
      </section>
    </div>}
  </div>;
}
