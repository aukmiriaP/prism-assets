import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Activity, FolderOpen, Pause, Play, RotateCcw, SkipBack, SkipForward, X } from 'lucide-react';
import type { Asset, Connection, Result } from './types';
import { createPreviewStage } from './preview-stage';
import { PreviewCanvas, PreviewDialog, PreviewEnvironment, PreviewLoading } from './preview';
import { animateMotion, buildMotionMesh, mergeMotion, type Vmd } from './motion-rig';
import { buildDefaultMotionMesh, DEFAULT_MOTION_MODEL, MOTION_MODEL_STORAGE } from './motion-mannequin';
import './motion.css';

export const motionLabel = (asset: Asset) => ({ body: '身体动作', facial: '表情动作', camera: '镜头动作', other: '其他轨道' }[asset.motion?.type || 'other']);
export const motionTime = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
type Companion = { id: string; name: string; kind: 'audio' | 'document' };
type Bundle = { motions: Asset[]; files: Companion[] };

export function MotionDetails({ asset }: { asset: Asset }) {
  const info = asset.motion;
  if (!info) return null;
  return <div className="detail-section"><h3>{motionLabel(asset)}</h3>
    <div className="model-metrics"><span><b>{motionTime(info.duration)}</b>时长</span><span><b>{info.active_bones.length}</b>有效运动骨骼</span><span><b>{info.fps}</b>时间基 FPS</span></div>
    <p className="organization-description">{info.bone_keys.toLocaleString()} 骨骼关键帧 · {info.morph_keys} 表情关键帧 · {info.camera_keys} 镜头关键帧</p>
    <p className="organization-description">直接使用内置人形预览，也可切换库内 PMX 角色。搜索匹配文件名、目录与标签。</p>
    {info.warnings.map(w => <p className="organization-description" key={w}>{w}</p>)}
  </div>;
}

export function MotionViewer({ asset, connection, close }: { asset: Asset; connection: Connection; close(): void }) {
  const mount = useRef<HTMLDivElement>(null);
  const [models, setModels] = useState<Asset[]>([]);
  const [bundle, setBundle] = useState<Bundle>({ motions: [], files: [] });
  const [modelId, setModelId] = useState(''), [bodyId, setBodyId] = useState('');
  const [facialId, setFacialId] = useState(''), [cameraId, setCameraId] = useState(''), [audioId, setAudioId] = useState('');
  const [cameraMode, setCameraMode] = useState(false), [skeleton, setSkeleton] = useState(false);
  const [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1), [loop, setLoop] = useState(true);
  const [time, setTime] = useState(0), [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(true), [ready, setReady] = useState(false);
  const [error, setError] = useState(''), [audioError, setAudioError] = useState('');
  const [report, setReport] = useState({ matched: 0, total: 0, missing: [] as string[], warnings: [] as string[] });
  const [document, setDocument] = useState<{ name: string; text: string } | null>(null);
  const clock = useRef({ time: 0, playing: false, speed: 1, loop: true, camera: false, skeleton: false });
  const stage = useRef({ seek: (_time: number) => {}, reset: () => {} });
  const audio = useRef<HTMLAudioElement | null>(null);
  const selectedModel = models.find(m => m.id === modelId);
  const builtin = modelId === DEFAULT_MOTION_MODEL;
  const selectModel = (id: string) => {
    setModelId(id);
    try { localStorage.setItem(MOTION_MODEL_STORAGE, id); } catch { /* Selection works without persistent storage. */ }
  };
  const request = async (route: string, signal: AbortSignal) => {
    const response = await fetch(connection.base + route, { headers: { Authorization: `Bearer ${connection.token}` }, signal });
    if (!response.ok) throw new Error((await response.json()).detail || '本地文件读取失败');
    return response;
  };
  useEffect(() => {
    let stopped = false;
    (async () => {
      const candidates = await window.prism.api<Result>('/assets/list', 'POST', { kind: 'model', ext: 'pmx', status: 'ready', limit: 1000 });
      const companions = await window.prism.api<Bundle>(`/assets/${asset.id}/motion-companions`);
      if (stopped) return;
      candidates.items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      setModels(candidates.items); setBundle(companions);
      let saved = '';
      try { saved = localStorage.getItem(MOTION_MODEL_STORAGE) || ''; } catch { /* Use the built-in model. */ }
      setModelId(candidates.items.some(m => m.id === saved) ? saved : DEFAULT_MOTION_MODEL);
      setBodyId(asset.motion?.type === 'body' ? asset.id : companions.motions.find(m => m.motion?.type === 'body')?.id || asset.id);
      setFacialId(asset.motion?.type === 'facial' ? asset.id : '');
      setCameraId(asset.motion?.type === 'camera' ? asset.id : companions.motions.find(m => m.motion?.type === 'camera')?.id || '');
      setCameraMode(asset.motion?.type === 'camera');
    })().catch(e => { if (!stopped) { setError(String(e.message)); setLoading(false); } });
    return () => { stopped = true; };
  }, [asset.id]);

  useEffect(() => {
    Object.assign(clock.current, { camera: cameraMode, skeleton });
  }, [cameraMode, skeleton]);

  useEffect(() => {
    Object.assign(clock.current, { playing, speed, loop });
    if (audio.current) {
      audio.current.playbackRate = speed;
      if (!playing) audio.current.pause();
      else if (clock.current.time < audio.current.duration) {
        audio.current.currentTime = clock.current.time;
        audio.current.play().catch(() => setAudioError('音乐未能播放，请关闭音乐后重试。'));
      }
    }
  }, [playing, speed, loop]);

  useEffect(() => {
    setAudioError('');
    if (!audioId) return;
    const abort = new AbortController();
    let url = '', disposed = false;
    const player = new Audio(); player.volume = .65; player.preservesPitch = true;
    audio.current = player;
    player.onerror = () => { if (!disposed) setAudioError('音乐格式无法播放或文件读取失败'); };
    player.onloadedmetadata = () => {
      if (disposed) return;
      player.currentTime = Math.min(clock.current.time, player.duration);
      player.playbackRate = clock.current.speed;
      if (clock.current.playing && clock.current.time < player.duration)
        player.play().catch(() => { if (!disposed) setAudioError('音乐未能播放，请重新开启音乐。'); });
    };
    (async () => {
      const response = await request(`/assets/${asset.id}/motion-files/${audioId}`, abort.signal);
      const blob = await response.blob();
      if (!disposed) { url = URL.createObjectURL(blob); player.src = url; }
    })().catch(e => { if (!disposed) setAudioError(e.message); });
    return () => {
      disposed = true; abort.abort(); player.pause(); player.removeAttribute('src'); player.load();
      audio.current = null; if (url) URL.revokeObjectURL(url);
    };
  }, [audioId, asset.id]);

  useEffect(() => {
    if (!mount.current || (!builtin && !selectedModel) || !bodyId) return;
    const holder = mount.current, abort = new AbortController();
    let disposed = false, rig: ReturnType<typeof buildMotionMesh> | undefined;
    let animation: ReturnType<typeof animateMotion> | undefined, bones: THREE.SkeletonHelper | undefined;
    let preview: ReturnType<typeof createPreviewStage>;
    setLoading(true); setReady(false); setPlaying(false); setError(''); setTime(0); clock.current.time = 0; clock.current.playing = false;
    audio.current?.pause();
    try { preview = createPreviewStage(holder); }
    catch { setError('无法创建 3D 画布，请检查系统图形支持'); setLoading(false); return; }
    const { scene } = preview;
    const originalCamera = new THREE.PerspectiveCamera(38, 1, .1, 2000);
    const textures = new Set<THREE.Texture>(), bitmaps = new Set<ImageBitmap>();
    let clipDuration = 0;
    const seek = (value: number) => {
      clock.current.time = THREE.MathUtils.clamp(value, 0, clipDuration);
      animation?.sample(clock.current.time); setTime(clock.current.time);
      if (audio.current?.readyState && Math.abs(audio.current.currentTime - clock.current.time) > .12)
        audio.current.currentTime = Math.min(clock.current.time, audio.current.duration);
      if (audio.current?.readyState && clock.current.playing && audio.current.paused && clock.current.time < audio.current.duration)
        audio.current.play().catch(() => { if (!disposed) setAudioError('音乐未能继续播放，请重新开启音乐。'); });
    };
    stage.current.seek = seek;
    (async () => {
      if (builtin) rig = buildDefaultMotionMesh();
      else {
        const buffer = await (await request(`/assets/${selectedModel!.id}/motion-model`, abort.signal)).arrayBuffer();
        if (disposed) return;
        rig = buildMotionMesh(buffer);
      }
      rig.mesh.castShadow = true; rig.mesh.receiveShadow = builtin; scene.add(rig.mesh);
      const model = rig;
      const base = await (await request(`/assets/${bodyId}/motion`, abort.signal)).json() as Vmd;
      const facial = facialId && facialId !== bodyId ? await (await request(`/assets/${facialId}/motion`, abort.signal)).json() as Vmd : undefined;
      const camera = cameraId ? await (await request(`/assets/${cameraId}/motion`, abort.signal)).json() as Vmd : undefined;
      if (disposed) return;
      const data = mergeMotion(base, facial);
      clipDuration = Math.max(base.info.duration, facial?.info.duration || 0, camera?.info.duration || 0);
      data.info = { ...data.info, duration: clipDuration };
      animation = animateMotion(model.mesh, model.loader, data, originalCamera, camera);
      const warnings = [...base.info.warnings, ...(facial?.info.warnings || []), ...(camera?.info.warnings || [])];
      if (builtin) warnings.push('内置人形用于检查身体与手指动作，没有面部表情变形；需要表情时请选择带对应表情的 PMX。');
      else if (animation.missingMorphs.length) warnings.push(`${animation.missingMorphs.length} 个表情名称未匹配：${animation.missingMorphs.join('、')}`);
      if (!base.motions.length && !facial?.motions.length) warnings.push('当前没有身体轨道，角色保持初始姿态；可选择同包身体动作');
      if (animation.missing.length > data.info.active_bones.length * .2)
        throw new Error(`角色骨架不匹配，无法可靠预览。缺少：${animation.missing.join('、')}`);
      const normalized = (s: string) => s.replace(/\\/g, '/').toLocaleLowerCase();
      const loaded = new Map<string, THREE.Texture>();
      for (let i = 0; i < model.materials.length; i++) {
        const material = model.materials[i], ref = model.data.textures[model.data.materials[i].textureIndex];
        if (!ref) continue;
        if (disposed) return;
        if (loaded.has(ref)) { material.map = loaded.get(ref)!; material.transparent = true; material.needsUpdate = true; continue; }
        const index = selectedModel?.model?.resources.findIndex(r => normalized(r.reference) === normalized(ref) && r.exists) ?? -1;
        if (index < 0) { warnings.push(`缺失纹理：${ref}`); continue; }
        try {
          const blob = await (await request(`/assets/${selectedModel!.id}/motion-textures/${index}/preview`, abort.signal)).blob();
          const bitmap = await createImageBitmap(blob);
          if (disposed) { bitmap.close(); return; }
          bitmaps.add(bitmap);
          const texture = new THREE.Texture(bitmap);
          texture.flipY = false; texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true;
          textures.add(texture); loaded.set(ref, texture); material.map = texture;
          material.transparent = true; material.needsUpdate = true;
        } catch (e) { if (disposed) return; warnings.push(`纹理读取失败：${ref}`); }
      }
      if (disposed) return;
      model.mesh.geometry.computeBoundingBox();
      preview.frame(model.mesh.geometry.boundingBox!, 0);
      stage.current.reset = preview.reset;
      bones = new THREE.SkeletonHelper(model.mesh);
      (bones.material as THREE.LineBasicMaterial).depthTest = false; bones.renderOrder = 10; scene.add(bones);
      setDuration(clipDuration); setReport({ matched: animation.matched.length, total: data.info.active_bones.length,
        missing: animation.missing, warnings: [...new Set(warnings)] });
      seek(0); setReady(true); setLoading(false);
    })().catch(e => { if (!disposed) { setError(String(e.message || e)); setLoading(false); } });
    preview.start(elapsed => {
      const state = clock.current;
      if (animation && state.playing) {
        let next = state.time + elapsed * state.speed;
        if (next >= clipDuration) {
          if (state.loop && clipDuration > 0) {
            next %= clipDuration;
            if (audio.current?.readyState) { audio.current.currentTime = next; audio.current.play().catch(() => {}); }
          } else { next = clipDuration; state.playing = false; setPlaying(false); audio.current?.pause(); }
        }
        seek(next);
      }
      if (bones) bones.visible = state.skeleton && Boolean(rig?.mesh.visible);
      return state.camera && cameraId && animation ? originalCamera : undefined;
    });
    return () => {
      disposed = true; abort.abort(); preview.dispose();
      stage.current = { seek: () => {}, reset: () => {} };
      animation?.dispose();
      if (rig) { rig.mesh.skeleton.dispose(); rig.mesh.geometry.dispose(); rig.materials.forEach(m => m.dispose()); }
      if (bones) { bones.geometry.dispose(); (bones.material as THREE.Material).dispose(); }
      textures.forEach(t => t.dispose()); bitmaps.forEach(b => b.close());
    };
  }, [modelId, bodyId, facialId, cameraId, connection]);

  const toggle = () => { if (!playing && time >= duration) stage.current.seek(0); setPlaying(v => !v); };
  const step = (delta: number) => { setPlaying(false); clock.current.playing = false; stage.current.seek((Math.round(clock.current.time * 30) + delta) / 30); };
  return <PreviewDialog label="人形动作预览" title={asset.path.split('/').slice(-2, -1)[0]} subtitle={`${asset.name} · MMD 人形动作`}
    icon={<Activity size={19}/>} closeLabel="关闭动作预览" close={close} className="motion-dialog">
      <div className="motion-workspace">
        <PreviewCanvas className="motion-stage" mount={mount} data-ready={ready} data-model={modelId} aria-label="人形动作画布">
          {(loading || error) && <PreviewLoading className="motion-loading" loading={loading} title={error || '正在加载角色与动作…'} description={loading ? '读取本地骨架、蒙皮与贴图' : undefined}/>}
          {ready && <div className="motion-stage-label">{cameraMode && cameraId ? '原始镜头' : '自由机位'}<span>{report.matched} / {report.total} 有效骨骼匹配</span></div>}
        </PreviewCanvas>
        <aside className="motion-options">
          <label>预览角色<select aria-label="预览角色" value={modelId} onChange={e => selectModel(e.target.value)}>
            <option value={DEFAULT_MOTION_MODEL}>Prism 人形 · 内置</option>{models.map(m => <option key={m.id} value={m.id}>{m.name.replace(/\.pmx$/i, '')}</option>)}</select></label>
          <p className="motion-model-note">{builtin ? '内置人形用于身体动作；面部表情请切换 PMX。' : '使用角色自身的骨架与材质。'}角色选择自动记住。</p>
          <label>身体动作<select aria-label="身体动作" value={bodyId} onChange={e => setBodyId(e.target.value)}>
            {bundle.motions.filter(m => m.motion?.type === 'body' || m.id === bodyId).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <label>追加表情<select aria-label="追加表情" value={facialId} onChange={e => setFacialId(e.target.value)}><option value="">仅使用动作自带表情</option>
            {bundle.motions.filter(m => m.motion?.type === 'facial').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <label>镜头文件<select aria-label="镜头文件" value={cameraId} onChange={e => setCameraId(e.target.value)}><option value="">无</option>
            {bundle.motions.filter(m => m.motion?.camera_keys).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <label className="motion-check"><input type="checkbox" checked={cameraMode} disabled={!cameraId} onChange={e => setCameraMode(e.target.checked)}/>使用原始镜头</label>
          <label>音乐<select aria-label="音乐" value={audioId} onChange={e => setAudioId(e.target.value)}><option value="">关闭音乐</option>
            {bundle.files.filter(f => f.kind === 'audio').map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
          {audioError && <p className="asset-error">{audioError}</p>}
          <div className="motion-options-actions"><label className="motion-check"><input type="checkbox" checked={skeleton} onChange={e => setSkeleton(e.target.checked)}/>骨架叠加</label>
            <button disabled={!ready} onClick={() => { setCameraMode(false); stage.current.reset(); }}><RotateCcw size={13}/>复位视角</button></div>
          <PreviewEnvironment/>
          <p>自由机位：拖动旋转，滚轮缩放，右键平移。</p>
          <details><summary>预览范围与匹配详情</summary>
            <p>基础材质、蒙皮、骨骼 IK 与旋转继承。暂不模拟头发、衣裙物理与 MMD 特效；骨骼、UV 和材质变形不完整支持。</p>
            {report.missing.length > 0 && <p>缺失有效骨骼：{report.missing.join('、')}</p>}
            {report.warnings.map(w => <p key={w}>{w}</p>)}</details>
          <div className="motion-docs"><span>包内说明与使用约定</span>{bundle.files.filter(f => f.kind === 'document').map(f =>
            <button key={f.id} onClick={() => window.prism.api<{ name: string; text: string }>(`/assets/${asset.id}/motion-files/${f.id}`).then(setDocument).catch(e => setAudioError(e.message))}>{f.name}</button>)}
            <button onClick={() => window.prism.reveal(asset.path)}><FolderOpen size={13}/>在 Finder 中查看</button></div>
        </aside>
      </div>
      <footer className="motion-transport">
        <div className="motion-timeline"><output>{motionTime(time)}</output><input aria-label="动作时间轴" type="range" min="0" max={Math.round(duration * 30)} step="1" value={Math.round(time * 30)} disabled={!ready}
          onChange={e => stage.current.seek(Number(e.target.value) / 30)}/><span>{motionTime(duration)}</span></div>
        <div className="motion-playback"><button title="上一帧" disabled={!ready} onClick={() => step(-1)}><SkipBack size={15}/></button>
          <button className="motion-play" title={playing ? '暂停动作' : '播放动作'} disabled={!ready} onClick={toggle}>{playing ? <Pause size={17}/> : <Play size={17}/>}</button>
          <button title="下一帧" disabled={!ready} onClick={() => step(1)}><SkipForward size={15}/></button>
          <output>第 {Math.round(time * 30)} / {Math.round(duration * 30)} 帧</output>
          <label>速度<select aria-label="播放速度" value={speed} onChange={e => setSpeed(Number(e.target.value))}>{[.5, 1, 1.5, 2].map(v => <option key={v} value={v}>{v}×</option>)}</select></label>
          <label><input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)}/>循环</label><span>30 FPS 时间基</span></div>
      </footer>
      {document && <div className="motion-document" role="dialog" aria-label="动作使用说明"><header><strong>{document.name}</strong><button title="关闭说明" onClick={() => setDocument(null)}><X size={18}/></button></header><pre>{document.text}</pre></div>}
  </PreviewDialog>;
}
