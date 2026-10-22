/// <reference types="vite/client" />
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Aperture, ArrowDownUp, ArrowLeft, ArrowRight, Box, Check, ChevronRight, CircleHelp, Copy,
  Folder, FolderOpen, FolderPlus, Grid2X2, HardDrive, Heart, Image as ImageIcon,
  ImagePlus, LoaderCircle, Maximize2, RefreshCw, Search, Settings2, SlidersHorizontal,
  Sparkles, Tag, Trash2, TriangleAlert, X } from 'lucide-react';
import type { Asset, Collection, Connection, Folder as FolderType, Result, SearchStrategy, Summary } from './types';
import { CollectionEditor, CollectionTree, ExclusionEditor, orderedCollections } from './organization';
import { ModelDetails, ModelViewer } from './model-viewer';
import { listLocation, useNavigation, type BrowseView } from './navigation';
import { ViewResults } from './view-results';
import './style.css';
import './organization.css';
import './navigation.css';
import './search.css';
import './listing.css';

const api = <T,>(route: string, method?: string, body?: unknown) => window.prism.api<T>(route, method, body);
const bytes = (n: number) => n > 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
const labels: Record<string, string> = { ready: '已索引', pending: '等待索引', error: '索引失败', missing: '文件已失联',
  completed: '已完成', running: '索引中', queued: '等待中', partial: '部分失败', failed: '失败', interrupted: '已中断' };
const cleanError = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': Error: /, '');

function App() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [fatal, setFatal] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const navigation = useNavigation();
  const { scope, activeTag, draft, query, selected, filtersOpen, filters, limit,
    modelGroup, resourceRelation } = navigation.view;
  const field = <K extends keyof BrowseView>(key: K) =>
    (value: React.SetStateAction<BrowseView[K]>) => navigation.update(key, value);
  const setActiveTag = field('activeTag'), setDraft = field('draft'), setSelected = field('selected');
  const setFiltersOpen = field('filtersOpen'), setFilters = field('filters'), setLimit = field('limit');
  const setResourceRelation = field('resourceRelation');
  const [result, setResult] = useState<Result>({ items: [], total: 0 });
  const [busy, setBusy] = useState(true);
  const [loadingVisible, setLoadingVisible] = useState(false);
  const resultCache = useRef(new ViewResults());
  const lastFilename = useRef(filters.name);
  const [notice, setNotice] = useState('');
  const [tasksOpen, setTasksOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [cardSize, setCardSize] = useState(205);
  const [refresh, setRefresh] = useState(0);
  const [tagDraft, setTagDraft] = useState('');
  const [topK, setTopK] = useState(50);
  const [groupDuplicates, setGroupDuplicates] = useState(true);
  const [multiMode, setMultiMode] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [bulkTag, setBulkTag] = useState('');
  const [bulkCollection, setBulkCollection] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [detailCollection, setDetailCollection] = useState('');
  const [organizeBusy, setOrganizeBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [collectionEditor, setCollectionEditor] = useState<Collection | 'new' | null>(null);
  const [collectionIntent, setCollectionIntent] = useState<'navigation' | 'bulk' | 'detail'>('navigation');
  const [newCollectionParent, setNewCollectionParent] = useState<string | null>(null);
  const [exclusionEditor, setExclusionEditor] = useState<FolderType | null>(null);
  const [copies, setCopies] = useState<Asset[] | null>(null);
  const anchor = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(800);
  const requestId = useRef(0);
  const restoreScroll = useRef<number | null>(null);
  const searching = Boolean(query.text || query.image_path || query.asset_id);
  const viewLocation = listLocation(navigation.view);
  const loading = busy && loadingVisible;
  const strategy = query.strategy || 'hybrid';
  const inModels = scope === 'models' || scope === 'textures';
  const groupedResources = inModels && !modelGroup;
  const folder = summary?.folders.find(f => f.id === scope);
  const collection = summary?.collections.find(c => `collection:${c.id}` === scope);
  const collectionOptions = orderedCollections(summary?.collections || []);
  const collectionAncestors = collection?.ancestor_ids?.map(id => summary?.collections.find(c => c.id === id)).filter((c): c is Collection => Boolean(c)) || [];
  const childCollections = summary?.collections.filter(c => c.parent_id === collection?.id) || [];
  const title = modelGroup?.name || (activeTag ? `# ${activeTag}` : collection?.name || folder?.name || ({ all: '全部素材', models: '3D 模型', textures: '3D 模型', images: '独立图片', favorites: '我的收藏', error: '索引失败', missing: '失联文件' }[scope] || (scope.startsWith('collection:') ? '已删除集合' : '全部素材')));
  const checkedAssets = result.items.filter(a => checked.includes(a.id));
  const checkedIds = [...new Set(checkedAssets.flatMap(a => a.member_ids || [a.id]))];
  const columns = Math.max(2, Math.floor((gridWidth - 48) / (cardSize + 14)));
  const cellSize = (gridWidth - 48 - 14 * (columns - 1)) / columns;
  const virtual = useVirtualizer({ count: Math.ceil(result.items.length / columns), getScrollElement: () => scrollRef.current,
    estimateSize: () => cellSize + 64, overscan: 3 });
  const imageUrl = (asset: Asset, full = false) => connection
    ? `${connection.base}/assets/${asset.id}/${full ? 'preview' : 'thumbnail'}?token=${connection.token}&v=${asset.thumbnail || asset.mtime}` : '';
  const notify = useCallback((message: string) => setNotice(message), []);
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { notify(cleanError(e)); } };
  const loadSummary = useCallback(async () => {
    const value = await api<Summary>('/summary');
    setSummary(value);
  }, []);

  useEffect(() => {
    window.prism.connection().then(setConnection).catch(e => setFatal(cleanError(e)));
    return window.prism.onServiceError(setFatal);
  }, []);
  useEffect(() => {
    if (!connection) return;
    let stopped = false;
    const poll = async () => {
      try { const value = await api<Summary>('/summary'); if (!stopped) setSummary(value); }
      catch (e) { if (!stopped) setFatal(cleanError(e)); }
    };
    poll(); const timer = setInterval(poll, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [connection]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => { setPreviewError(false); }, [preview, selected?.id]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === 'Escape') { setPreview(false); setSettingsOpen(false); setTasksOpen(false); setExclusionEditor(null); setCollectionEditor(null); }
      if (event.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes((event.target as HTMLElement).tagName) && selected) {
        event.preventDefault(); setPreview(p => !p);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [selected]);
  useEffect(() => {
    if (!scrollRef.current) return;
    const observer = new ResizeObserver(entries => setGridWidth(entries[0].contentRect.width));
    observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, [connection, summary]);
  useEffect(() => { virtual.measure(); }, [cellSize, columns]);
  useEffect(() => { setChecked([]); anchor.current = null; }, [scope, activeTag, query, filters, groupDuplicates, topK, modelGroup, resourceRelation]);
  useEffect(() => { setCopies(null); setTagDraft(''); setDetailCollection(''); }, [selected?.id]);
  useEffect(() => {
    if (busy || restoreScroll.current === null) return;
    const top = restoreScroll.current;
    const frame = requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, top); restoreScroll.current = null; });
    return () => cancelAnimationFrame(frame);
  }, [busy, result, navigation.index]);

  const countsKey = JSON.stringify(summary?.counts);
  // A replacement can keep counts unchanged; empty periodic scans need no new search.
  const meaningfulScan = summary?.jobs.find(j => j.done > 0);
  const scanKey = meaningfulScan?.id + ':' + meaningfulScan?.done + ':' + meaningfulScan?.status;
  const cacheEpoch = JSON.stringify([connection?.base, refresh, summary?.counts, summary?.favorites,
    summary?.tags, summary?.collections,
    summary?.folders.map(f => [f.id, f.name, f.path, f.count, f.status, f.exclusions, f.excluded_count]), scanKey]);
  const requestFor = (view: BrowseView) => {
    const hasSearch = Boolean(view.query.text || view.query.image_path || view.query.asset_id);
    const models = view.scope === 'models' || view.scope === 'textures';
    const params = { ...view.filters, limit: hasSearch ? topK : view.limit, top_k: topK,
      kind: models ? !view.modelGroup || view.resourceRelation === 'model' ? 'model' : '' : view.scope === 'images' ? 'image' : '',
      exclude_components: view.scope === 'images', include_components: Boolean(view.modelGroup),
      model_id: view.modelGroup?.id || '', relation: view.resourceRelation === 'model' ? '' : view.resourceRelation,
      include_model: Boolean(view.modelGroup) && (!view.resourceRelation || view.resourceRelation === 'model'),
      group_duplicates: groupDuplicates,
      collection_id: view.scope.startsWith('collection:') ? view.scope.slice('collection:'.length) : '',
      tag: view.activeTag, favorite: view.scope === 'favorites',
      status: ['error', 'missing'].includes(view.scope) ? view.scope : '',
      folder_id: summary?.folders.find(f => f.id === view.scope)?.id || '' };
    return { route: hasSearch ? '/search' : '/assets/list',
      body: hasSearch ? { ...view.query, filters: params } : params,
      key: hasSearch ? null : JSON.stringify(params) };
  };
  useEffect(() => {
    setLoadingVisible(false);
    if (!busy || !connection || !summary) return;
    const timer = setTimeout(() => setLoadingVisible(true), 200);
    return () => clearTimeout(timer);
  }, [busy, viewLocation, connection, Boolean(summary)]);
  useEffect(() => {
    if (!connection || !summary) return;
    const current = ++requestId.current;
    const request = requestFor(navigation.view);
    const cached = request.key ? resultCache.current.peek(cacheEpoch, request.key) : undefined;
    const delay = filters.name !== lastFilename.current ? 180 : 0;
    lastFilename.current = filters.name;
    if (cached) {
      setResult(cached); setBusy(false);
      setChecked(old => old.filter(id => cached.items.some(a => a.id === id)));
      return;
    }
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const fetch = () => api<Result>(request.route, 'POST', request.body);
        const data = await (request.key ? resultCache.current.load(cacheEpoch, request.key, fetch) : fetch());
        if (current === requestId.current) {
          setResult(data);
          setChecked(old => old.filter(id => data.items.some(a => a.id === id)));
        }
      } catch (e) { if (current === requestId.current) notify(cleanError(e)); }
      finally { if (current === requestId.current) setBusy(false); }
    }, delay);
    return () => clearTimeout(timer);
  }, [connection, scope, folder?.id, collection?.id, activeTag, filters, query, limit, topK, groupDuplicates, refresh, countsKey, scanKey, modelGroup?.id, resourceRelation, groupedResources, cacheEpoch, Boolean(summary)]);
  useEffect(() => {
    let stopped = false;
    if (selected) {
      const updated = result.items.find(a => a.id === selected.id);
      if (updated) setSelected(updated);
      // A retried file leaves the failure list while queued, but its open detail
      // must still reflect completion or another failure.
      else api<Asset>(`/assets/${selected.id}`).then(value => {
        if (!stopped) setSelected(old => old?.id === selected.id ? value : old);
      }).catch(() => {});
    }
    return () => { stopped = true; };
  }, [result, selected?.id]);
  const resetResults = (view: BrowseView) => {
    ++requestId.current;
    const request = requestFor(view);
    const cached = request.key ? resultCache.current.peek(cacheEpoch, request.key) : undefined;
    setResult(cached || { items: [], total: 0 }); setBusy(!cached); setLoadingVisible(false);
    setChecked([]); scrollRef.current?.scrollTo(0, 0);
  };
  const browse = (changes: Partial<BrowseView>, keepScroll = false) => {
    const next = { ...navigation.view, ...changes };
    const reload = listLocation(next) !== listLocation(navigation.view);
    navigation.navigate(changes, scrollRef.current?.scrollTop || 0, keepScroll);
    restoreScroll.current = null;
    if (reload) resetResults(next);
    setMultiMode(false); setChecked([]); setPreview(false);
  };
  const chooseScope = (value: string, tag = '') => browse({ scope: value, activeTag: tag,
    selected: null, modelGroup: null, resourceRelation: '', limit: 200 });
  const enterModelGroup = (asset: Asset) => browse({ scope: 'models', activeTag: '', flatTextures: false,
    modelGroup: asset, selected: asset, resourceRelation: '', limit: 200,
    query: { strategy }, draft: '', filters: { name: '', ext: '', min_width: 0, sort: 'newest' } });
  const returnToModels = () => browse({ scope: 'models', modelGroup: null, selected: null,
    resourceRelation: '', flatTextures: false, limit: 200, query: { strategy }, draft: '',
    filters: { name: '', ext: '', min_width: 0, sort: 'newest' } });
  const openAsset = (asset: Asset) => browse({ selected: asset }, true);
  const moveHistory = (delta: number) => {
    const target = navigation.entries[navigation.index + delta];
    if (!target) return;
    navigation.go(delta, scrollRef.current?.scrollTop || 0);
    restoreScroll.current = target.scrollTop;
    if (listLocation(target) !== listLocation(navigation.view)) resetResults(target);
    setMultiMode(false); setChecked([]); setPreview(false); setCopies(null);
  };
  const search = (value: BrowseView['query'], input = '') => browse({
    query: { ...value, strategy: value.strategy || strategy }, draft: input, limit: 200,
  });
  const changeStrategy = (value: SearchStrategy) => {
    if (query.text) search({ ...query, strategy: value }, draft);
    else navigation.update('query', { ...query, strategy: value });
  };
  const addFolder = () => run(async () => {
    const paths = await window.prism.chooseFolder();
    for (const path of paths) await api('/folders', 'POST', { path });
    if (paths.length) { await loadSummary(); setTasksOpen(true); }
  });
  const chooseImage = () => run(async () => {
    const path = await window.prism.chooseImage();
    if (path) search({ image_path: path, label: path.split('/').pop() });
  });
  const patch = async (asset: Asset, changes: Partial<Asset>) => {
    const value = await api<Asset>(`/assets/${asset.id}`, 'PATCH', changes);
    resultCache.current.clear();
    setResult(old => ({ ...old, items: old.items.map(a => a.id === value.id ? { ...a, ...value } : a) }));
    setSelected(old => old?.id === value.id ? value : old);
    await loadSummary();
    setRefresh(n => n + 1);
  };
  const similar = (asset: Asset) => search({ asset_id: asset.id, label: asset.name });
  const scan = (f: FolderType) => run(async () => { await api(`/folders/${f.id}/scan`, 'POST', { retry: true }); await loadSummary(); setTasksOpen(true); });
  const retry = (ids?: string[]) => run(async () => {
    setRetryBusy(true);
    try {
      const data = await api<{ queued: number; busy: number }>('/assets/retry', 'POST', {
        ids: ids || [], filters: { ...filters, folder_id: folder?.id || '', collection_id: collection?.id || '',
          tag: activeTag, favorite: scope === 'favorites',
          kind: inModels ? !modelGroup || resourceRelation === 'model' ? 'model' : '' : scope === 'images' ? 'image' : '',
          include_components: Boolean(modelGroup), model_id: modelGroup?.id || '',
          relation: resourceRelation === 'model' ? '' : resourceRelation,
          include_model: Boolean(modelGroup) && (!resourceRelation || resourceRelation === 'model'),
          exclude_components: scope === 'images' },
      });
      notify(data.queued ? `已安排 ${data.queued} 项重试${data.busy ? `；另 ${data.busy} 项所在目录正在索引` : ''}`
        : data.busy ? `${data.busy} 项所在目录正在索引，请完成后重试` : '当前没有可重试的失败项');
      await loadSummary();
      setRefresh(n => n + 1);
      if (data.queued) setTasksOpen(true);
    } finally { setRetryBusy(false); }
  });
  const running = summary?.jobs.find(j => ['queued', 'running'].includes(j.status));
  const recover = () => run(async () => {
    setRecoveryBusy(true);
    try {
      const data = await api<{ recovered: number; duplicates: number; ambiguous: number; missing: number }>('/assets/recover', 'POST');
      notify(`恢复 ${data.recovered} 项，归档 ${data.duplicates} 项旧重复记录；${data.ambiguous} 项待选择，${data.missing} 项未找到`);
      await loadSummary(); setRefresh(n => n + 1);
    } finally { setRecoveryBusy(false); }
  });
  const reconnect = (old: Asset, candidate: Asset) => run(async () => {
    setRecoveryBusy(true);
    try {
      setSelected(await api<Asset>(`/assets/${old.id}/reconnect`, 'POST', { target_id: candidate.id }));
      notify('已恢复关联并合并标签、收藏和集合');
      await loadSummary(); setRefresh(n => n + 1);
    } finally { setRecoveryBusy(false); }
  });
  const clearSearch = () => search({});
  const selectAsset = (asset: Asset, extend = false) => {
    setSelected(asset);
    if (extend && anchor.current) {
      const start = result.items.findIndex(a => a.id === anchor.current);
      const end = result.items.findIndex(a => a.id === asset.id);
      if (start >= 0) {
        setChecked(old => [...new Set([...old, ...result.items.slice(Math.min(start, end), Math.max(start, end) + 1).map(a => a.id)])]);
        return;
      }
    }
    anchor.current = asset.id;
    setChecked(old => old.includes(asset.id) ? old.filter(id => id !== asset.id) : [...old, asset.id]);
  };
  const bulk = async (changes: Record<string, unknown>) => {
    if (!checkedIds.length || busy || bulkBusy) return;
    setBulkBusy(true);
    try {
      const value = await api<{ updated: number }>('/assets/bulk', 'POST', { ids: checkedIds, ...changes });
      resultCache.current.clear();
      notify(`已更新 ${value.updated} 个文件`); setChecked([]); setBulkTag('');
      await loadSummary(); setRefresh(n => n + 1);
    } catch (e) { notify(cleanError(e)); }
    finally { setBulkBusy(false); }
  };
  const applyDetailTag = () => run(async () => {
    const asset = selected, tag = tagDraft.trim();
    if (!asset || !tag || organizeBusy) return;
    if (asset.tags.includes(tag)) { notify('该素材已具有此标签'); return; }
    setOrganizeBusy(true);
    try {
      await patch(asset, { tags: [...asset.tags, tag] });
      setTagDraft(''); notify(`已为 ${asset.name} 添加标签「${tag}」`);
    } finally { setOrganizeBusy(false); }
  });
  const joinDetailCollection = () => run(async () => {
    const asset = selected, target = summary?.collections.find(c => c.id === detailCollection);
    if (!asset || !target || organizeBusy) return;
    setOrganizeBusy(true);
    try {
      await api('/assets/bulk', 'POST', { ids: [asset.id], collection_id: target.id });
      resultCache.current.clear();
      const updated = await api<Asset>(`/assets/${asset.id}`);
      setSelected(old => old?.id === asset.id ? updated : old);
      await loadSummary(); setRefresh(n => n + 1);
      notify(`已加入集合「${target.path}」`);
    } finally { setOrganizeBusy(false); }
  });
  const newCollection = (intent: 'navigation' | 'bulk' | 'detail' = 'navigation', parentId: string | null = null) => {
    setNewCollectionParent(parentId); setCollectionIntent(intent); setCollectionEditor('new');
  };
  const editCollection = (item: Collection) => {
    setCollectionIntent('navigation'); setCollectionEditor(item);
  };

  if (fatal) return <div className="boot"><Aperture size={40}/><h1>本地服务暂不可用</h1><p>{fatal}</p><button className="primary" onClick={() => window.prism.restart()}>重新启动应用</button></div>;
  if (!connection || !summary) return <div className="boot"><div className="brand-mark"><Aperture size={34}/></div><h1>PRISM <span>ASSETS</span></h1><p><LoaderCircle className="spin" size={15}/> 正在启动本地素材库…</p><small>首次启动需要准备运行环境，请稍候</small></div>;

  return <div className="app" onDragOver={e => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) setDragging(true); }}
    onDrop={e => { e.preventDefault(); setDragging(false); const file = e.dataTransfer.files[0]; if (file) {
      const path = window.prism.filePath(file); if (path) search({ image_path: path, label: file.name });
    } }}>
    <aside className="sidebar">
      <div className="traffic-space"/>
      <div className="brand"><div className="brand-mark"><Aperture size={25}/></div><div>PRISM<span>ASSET LIBRARY</span></div><span className="beta">0.3.1</span></div>
      <button className="add-folder" onClick={addFolder}><FolderPlus size={17}/> 关联素材文件夹 <span>＋</span></button>
      <div className="nav-label">素材库</div>
      <nav>
        <button title={`${summary.total} 个文件，其中 ${summary.components} 张贴图收纳在模型下`} className={scope === 'all' && !activeTag ? 'active' : ''} onClick={() => chooseScope('all')}><Grid2X2 size={17}/>全部素材<span>{summary.total - summary.components}</span></button>
        <button title="按模型分组，包含模型文件、材质和附属贴图" className={inModels ? 'active' : ''} onClick={() => modelGroup ? returnToModels() : chooseScope('models')}><Box size={17}/>3D 模型<span>{summary.models}</span></button>
        <button title="独立图片文件数，不包含模型附属贴图" className={scope === 'images' ? 'active' : ''} onClick={() => chooseScope('images')}><ImageIcon size={17}/>独立图片<span>{summary.independent_images}</span></button>
        <button className={scope === 'favorites' ? 'active' : ''} onClick={() => chooseScope('favorites')}><Heart size={17}/>我的收藏<span>{summary.favorites}</span></button>
      </nav>
      <div className="nav-label">关联目录<button title="添加目录" onClick={addFolder}><FolderPlus size={14}/></button></div>
      <nav className="folder-nav">{summary.folders.length ? summary.folders.map(f => <button key={f.id} title={f.path}
        className={scope === f.id ? 'active' : ''} onClick={() => chooseScope(f.id)}>
        {f.status === 'online' ? <Folder size={16}/> : <TriangleAlert size={16}/>}<b>{f.name}</b><span title="目录内文件总数，包含附属贴图">{f.count}</span></button>)
        : <p className="nav-empty">关联文件夹后，素材会出现在这里</p>}</nav>
      <div className="nav-label">虚拟集合<button title="新建集合" onClick={() => newCollection()}><FolderPlus size={14}/></button></div>
      <nav className="collection-nav" aria-label="集合树"><CollectionTree collections={summary.collections} activeId={collection?.id}
        open={id => chooseScope(`collection:${id}`)} create={id => newCollection('navigation', id)} edit={editCollection}/></nav>
      <div className="nav-label">标签<span>{summary.tags.length || ''}</span></div>
      <div className="tag-nav">{summary.tags.length ? summary.tags.map(t => <button className={activeTag === t.name ? 'active' : ''}
        key={t.name} onClick={() => chooseScope('all', t.name)}><i/> {t.name}<span>{t.count}</span></button>)
        : <p className="nav-empty">在素材详情中添加你的第一个标签</p>}</div>
      <div className="sidebar-bottom">
        {Boolean(summary.counts.error) && <button className="warning-link" onClick={() => chooseScope('error')}><TriangleAlert size={14}/> {summary.counts.error} 个文件索引失败</button>}
        {Boolean(summary.counts.missing) && <button className="muted-link" onClick={() => chooseScope('missing')}><Folder size={14}/> {summary.counts.missing} 个文件已失联</button>}
        <button className="local-status" onClick={() => setTasksOpen(true)}><div className={`status-dot ${summary.model === 'error' ? 'error' : ''}`}/><div>本地运行<span>{summary.model === 'loading' ? '正在加载模型' : summary.model === 'ready' ? '模型已就绪 · 离线可用' : summary.model === 'error' ? '模型加载失败' : '搜索时自动加载模型'}</span></div><ChevronRight size={15}/></button>
        <button className="settings-link" onClick={() => setSettingsOpen(true)}><Settings2 size={16}/> 设置与帮助 <span>⌘ K 搜索</span></button>
      </div>
    </aside>
    <section className="workspace">
      <header className="topbar">
        <div className="breadcrumb" aria-label="当前位置">素材库 <ChevronRight size={13}/>
          {collectionAncestors.map(c => <React.Fragment key={c.id}><button aria-label={`上级集合 ${c.name}`} title={c.path}
            onClick={() => chooseScope(`collection:${c.id}`)}>{c.name}</button><ChevronRight size={13}/></React.Fragment>)}
          {inModels && modelGroup && <>3D 模型 <ChevronRight size={13}/></>} <strong>{title}</strong></div>
        <button className={`task-toggle ${running ? 'working' : ''}`} onClick={() => setTasksOpen(v => !v)}>
          {running ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>}
          {running ? `正在索引 ${running.done}/${running.total || '…'}` : '索引任务'}</button>
      </header>
      <nav className="navigation-toolbar" aria-label="浏览导航">
        <button aria-label="返回" title="返回上一浏览位置" disabled={!navigation.canBack} onClick={() => moveHistory(-1)}><ArrowLeft size={16}/><span>返回</span></button>
        <button aria-label="前进" title="前进到下一浏览位置" disabled={!navigation.canForward} onClick={() => moveHistory(1)}><ArrowRight size={16}/><span>前进</span></button>
      </nav>
      <div className="search-area">
        <form className="search-box" onSubmit={e => { e.preventDefault(); if (draft.trim()) search({ text: draft.trim() }, draft.trim()); }}>
          <Search size={21}/><input ref={searchRef} aria-label="语义搜索" value={draft} onChange={e => setDraft(e.target.value)}
            placeholder="搜索名称、标签或画面描述，例如：赛琳娜 / 冷色石制拱门"/>
          {draft && <button type="button" title="清空搜索" onClick={clearSearch}><X size={15}/></button>}
          {!query.image_path && !query.asset_id && <select className="search-strategy" aria-label="文字搜索方式"
            value={strategy} onChange={e => changeStrategy(e.target.value as SearchStrategy)}>
            <option value="hybrid">混合检索</option><option value="keyword">关键词</option><option value="semantic">语义检索</option>
          </select>}
          <button type="button" title="以图搜图" className="image-search" onClick={chooseImage}><ImagePlus size={19}/><span>以图搜图</span></button>
          <button type="submit" className="search-submit" disabled={!draft.trim()} title="搜索"><ArrowRight size={18}/></button>
        </form>
        <div className="search-hint"><Sparkles size={12}/> {query.image_path || query.asset_id ? '按画面相似度寻找素材'
          : strategy === 'keyword' ? '匹配文件名、标签、所属模型与目录，无需加载模型'
          : strategy === 'semantic' ? '按中英文画面描述寻找相似素材'
          : '名称命中优先 · 语义候选补充 · 拖入图片寻找相似素材'} <span>完全在本机处理</span></div>
        {searching && result.warning && <p className="search-warning">{result.warning}</p>}
      </div>
      <div className="library-heading"><div><div className="eyebrow">{searching ? 'VISUAL SEARCH' : 'YOUR COLLECTION'}</div><h1>{searching ? '搜索候选' : title}{(!busy || result.items.length > 0) && <span>{result.total.toLocaleString()} {groupedResources ? '组' : '项'}</span>}</h1></div>
        <div className="view-controls"><label title="缩略图大小"><Grid2X2 size={15}/><input type="range" aria-label="缩略图大小" min="140" max="280" value={cardSize} onChange={e => setCardSize(+e.target.value)}/></label>
          <button className={multiMode ? 'selected-control' : ''} onClick={() => { setMultiMode(v => !v); setChecked([]); }}>{multiMode ? '退出多选' : '多选'}</button>
          {collection && <><button onClick={() => newCollection('navigation', collection.id)}><FolderPlus size={14}/>新建子集合</button>
            <button onClick={() => editCollection(collection)}>管理集合</button></>}
          {scope === 'error' && !searching && <button disabled={retryBusy || !result.total} onClick={() => retry()}><RefreshCw size={15}/> 重试当前范围</button>}
          {scope === 'missing' && <button disabled={recoveryBusy || Boolean(running)} onClick={recover}><RefreshCw size={15}/> 查找已移动文件</button>}
          <button className={filtersOpen ? 'selected-control' : ''} onClick={() => setFiltersOpen(v => !v)}><SlidersHorizontal size={15}/> 筛选</button>
          {folder && <button title="重新扫描此目录" onClick={() => scan(folder)}><RefreshCw size={16}/></button>}
        </div>
      </div>
      {collection && !searching && childCollections.length > 0 && <section className="child-collections" aria-label="直属子集合">
        <span>子集合 · {childCollections.length}</span><div>{childCollections.map(c => <button key={c.id} title={c.path}
          aria-label={`进入子集合 ${c.name}`} onClick={() => chooseScope(`collection:${c.id}`)}><Folder size={17}/>
          <b>{c.name}</b><small>{c.child_count} 个子集合 · {c.count} 个直属文件</small><ChevronRight size={14}/></button>)}</div>
      </section>}
      {collection && <div className="component-note collection-scope-note">素材列表与计数仅包含直接加入此集合的文件；子集合素材请进入对应子集合查看。</div>}
      {searching && <div className="query-chip"><span>{query.text ? <Search size={13}/> : <ImageIcon size={13}/>} {query.text || query.label}</span><button onClick={clearSearch}><X size={13}/> 退出搜索</button><small>{query.text && strategy !== 'semantic'
        ? strategy === 'keyword' ? '仅显示元数据关键词命中' : '关键词命中优先，其余为语义候选'
        : '按余弦相似度排序；分数不代表正确概率'}</small></div>}
      <div className="result-controls">
        <label><input type="checkbox" checked={groupDuplicates} onChange={e => setGroupDuplicates(e.target.checked)}/>聚合完全重复项</label>
        {inModels && <>
          {modelGroup && <><button className="text-action" onClick={returnToModels}>返回模型分组</button>
            <button className="text-action" onClick={() => run(async () => openAsset(await api<Asset>(`/assets/${modelGroup.id}`)))}>查看材质与说明</button></>}
          {modelGroup && <label>资源类型<select aria-label="资源类型" value={resourceRelation} onChange={e => setResourceRelation(e.target.value)}>
            <option value="">主文件与贴图</option><option value="model">模型文件</option><option value="bound">材质引用贴图</option><option value="auxiliary">辅助贴图</option></select></label>}
        </>}
        {searching && <label>候选上限<select aria-label="候选上限" value={topK} onChange={e => setTopK(+e.target.value)}>
          {[20, 50, 100, 200].map(k => <option key={k} value={k}>前 {k} 项</option>)}</select></label>}
        <span aria-live="polite">{loading ? '更新中…' : busy && result.items.length === 0 ? '' : groupedResources && !searching ? `${result.total} 个模型分组 · 主文件、材质与附属资源`
          : `${searching ? '检索范围' : '当前范围'} ${result.scope_total ?? result.total} 个文件 · ${result.unique_total ?? result.total} ${groupDuplicates ? '项不同内容' : '个文件条目'}${searching ? `${query.text && result.keyword_total !== undefined ? ` · 关键词命中 ${result.keyword_total} 项` : ''} · 返回 ${result.total} 个候选` : ''}`}</span>
      </div>
      {summary.models > 0 && <div className="component-note">{scope === 'images' ? '独立图片不展示模型附属贴图。模型文件、材质与贴图请到左侧“3D 模型”中查看。'
        : groupedResources ? '点击模型资产组，查看 PMX / FBX / GLB / glTF 主文件、材质、附属贴图与辅助文件。'
        : modelGroup ? '模型主文件和贴图在此分组内展示；材质绑定、文档和使用约定可在右侧模型详情中查看。'
        : '模型文件、材质与附属贴图统一收纳在“3D 模型”；收藏、标签与虚拟集合仍可单独整理文件。'}</div>}
      {scope === 'missing' && <div className="component-note">失联表示旧路径不存在。扫描会按文件内容找回已移动的图片；多个候选且有整理信息时，请在详情选择新位置。</div>}
      {filtersOpen && <div className="filters">
        <input aria-label="文件名筛选" placeholder="文件名包含…" value={filters.name} onChange={e => { setFilters({ ...filters, name: e.target.value }); setLimit(200); }}/>
        <select aria-label="格式筛选" value={filters.ext} onChange={e => { setFilters({ ...filters, ext: e.target.value }); setLimit(200); }}>
          <option value="">全部格式</option>{['pmx', 'fbx', 'glb', 'gltf', 'png', 'jpg', 'webp', 'tif', 'tiff', 'bmp', 'tga', 'sph', 'spa'].map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}</select>
        <select aria-label="分辨率筛选" value={filters.min_width} onChange={e => { setFilters({ ...filters, min_width: +e.target.value }); setLimit(200); }}>
          <option value="0">全部分辨率</option><option value="1024">宽度 ≥ 1K</option><option value="2048">宽度 ≥ 2K</option><option value="4096">宽度 ≥ 4K</option></select>
        <select aria-label="素材排序" disabled={searching} value={filters.sort} onChange={e => setFilters({ ...filters, sort: e.target.value })}>
          <option value="newest">最近导入</option><option value="oldest">最早导入</option><option value="name">文件名称</option></select>
        <button title="重置筛选" onClick={() => { setFilters({ name: '', ext: '', min_width: 0, sort: 'newest' }); setActiveTag(''); }}><RefreshCw size={14}/></button>
      </div>}
      {multiMode && <div className="bulk-toolbar" aria-label="批量整理">
        <div className="bulk-selection"><strong>已选 {checkedAssets.length} 项 · {checkedIds.length} 个文件</strong>
          <button disabled={busy || bulkBusy} onClick={() => setChecked(result.items.map(a => a.id))}>全选已显示项</button>
          <button onClick={() => setChecked([])}>清空选择</button>
          <small>聚合项操作应用到当前范围内的全部副本</small></div>
        <div className="bulk-actions"><div className="bulk-action-group" aria-label="批量标签操作"><span className="action-group-label">标签</span>
          <select aria-label="批量已有标签" value={summary.tags.some(t => t.name === bulkTag) ? bulkTag : ''} onChange={e => setBulkTag(e.target.value)}>
            <option value="">选择已有标签…</option>{summary.tags.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}</select>
          <input aria-label="批量标签" placeholder="或输入新标签…" value={bulkTag} maxLength={64} onChange={e => setBulkTag(e.target.value)}/>
          <button disabled={!checkedIds.length || !bulkTag.trim() || busy || bulkBusy} onClick={() => bulk({ add_tags: [bulkTag.trim()] })}>添加标签</button>
          <button disabled={!checkedIds.length || !bulkTag.trim() || busy || bulkBusy} onClick={() => bulk({ remove_tags: [bulkTag.trim()] })}>移除标签</button>
          </div><div className="bulk-action-group" aria-label="批量收藏操作"><span className="action-group-label">收藏</span>
          <button disabled={!checkedIds.length || busy || bulkBusy} onClick={() => bulk({ favorite: true })}>批量收藏</button>
          <button disabled={!checkedIds.length || busy || bulkBusy} onClick={() => bulk({ favorite: false })}>取消收藏</button>
          </div>
          {checkedAssets.some(a => a.status === 'error') && <button disabled={retryBusy || busy || bulkBusy}
            onClick={() => retry(checkedIds)}>重试选中失败项</button>}
          <div className="bulk-action-group" aria-label="批量集合操作"><span className="action-group-label">虚拟集合</span>
          <select aria-label="目标集合" disabled={!summary.collections.length} value={summary.collections.some(c => c.id === bulkCollection) ? bulkCollection : ''} onChange={e => setBulkCollection(e.target.value)}>
            <option value="">{summary.collections.length ? '选择集合…' : '尚无集合，请先新建'}</option>{collectionOptions.map(c => <option key={c.id} value={c.id}>{c.path}</option>)}</select>
          <button disabled={!checkedIds.length || !summary.collections.some(c => c.id === bulkCollection) || busy || bulkBusy} onClick={() => bulk({ collection_id: bulkCollection })}>加入集合</button>
          <button aria-label="批量新建集合" onClick={() => newCollection('bulk', collection?.id || null)}>新建集合</button>
          {collection && <button disabled={!checkedIds.length || busy || bulkBusy} onClick={() => bulk({ collection_id: collection.id, collection_action: 'remove' })}>移出当前集合</button>}
          </div>
        </div>
      </div>}
      <div className="content-row">
        <main className="gallery" ref={scrollRef} aria-label="素材网格">
          {loading && <div className="loading-line"/>}
          {result.items.length === 0 ? busy ? loading ? <div className="gallery-read-state" role="status">
            <LoaderCircle className="spin" size={17}/>{searching ? summary.model === 'loading' ? '正在准备本地模型…' : '正在搜索…' : '正在读取素材列表…'}
          </div> : null : collection && !searching ? <div className="collection-empty"><FolderOpen size={30}/>
            <h2>本集合还没有直属素材</h2><p>{childCollections.length ? '点击上方子集合继续浏览，或从素材详情与多选栏加入文件。' : '从素材详情与多选栏加入文件，或点击“新建子集合”继续组织。'}</p></div> : <div className="empty">
            <div className="empty-art"><div/><div/><div><Aperture size={42}/></div></div>
            <div className="eyebrow">{summary.folders.length ? 'ROOM FOR DISCOVERY' : 'A HOME FOR YOUR IDEAS'}</div>
            <h2>{!summary.folders.length ? '让灵感，有迹可循。' : running ? '你的素材正在入库' : '这里还没有匹配的素材'}</h2>
            <p>{!summary.folders.length ? '关联本地素材文件夹，用一句描述或一张图片，\n找回你需要的那份灵感。' : running ? '缩略图与语义索引会陆续出现。你可以继续浏览。' : '试试调整筛选条件、切换目录，或关联更多图片。'}</p>
            {!summary.folders.length && <><button className="primary" onClick={addFolder}><FolderPlus size={17}/> 关联素材文件夹</button><div className="empty-foot">图片 · PMX · FBX · GLB · glTF<span>仅建立索引，保留原始目录</span></div></>}
          </div> : <>
            <div className="virtual-grid" style={{ height: virtual.getTotalSize() }}>
              {virtual.getVirtualItems().map(row => <div key={row.index} className="grid-row"
                style={{ transform: `translateY(${row.start}px)`, gridTemplateColumns: `repeat(${columns}, minmax(0,1fr))` }}>
                {result.items.slice(row.index * columns, (row.index + 1) * columns).map(asset => <div role="button" tabIndex={0}
                  aria-label={`${groupedResources ? '模型分组' : '素材'} ${asset.name}`} key={asset.id} className={`asset-card ${selected?.id === asset.id ? 'selected' : ''} ${checked.includes(asset.id) ? 'checked' : ''}`}
                  onClick={e => { if (multiMode || e.metaKey || e.ctrlKey || e.shiftKey) { setMultiMode(true); selectAsset(asset, e.shiftKey); } else if (groupedResources) enterModelGroup(asset); else openAsset(asset); }}
                  onDoubleClick={() => { if (!multiMode && !groupedResources) { openAsset(asset); setPreview(true); } }}
                  onKeyDown={e => { if (e.target === e.currentTarget && e.key === 'Enter') { if (multiMode) selectAsset(asset, e.shiftKey); else if (groupedResources) enterModelGroup(asset); else openAsset(asset); } }}>
                  <div className="asset-image" style={{ height: cellSize }}>
                    {asset.thumbnail ? <img src={imageUrl(asset)} alt={asset.name} loading="lazy"/> : asset.kind === 'model' ? <Box size={35}/> : <ImageIcon size={35}/>}
                    <span className="format-badge">{asset.ext}</span>
                    {groupedResources && asset.status === 'ready' && (asset.copy_count || 0) < 2 && <span className="copy-badge">模型 + {asset.resource_count || 0} 张外置贴图</span>}
                    {multiMode && <input className="selection-check" type="checkbox" aria-label={`选择 ${asset.name}`} checked={checked.includes(asset.id)}
                      onClick={e => e.stopPropagation()} onChange={() => selectAsset(asset)}/>}
                    {(asset.copy_count || 0) > 1 && <span className="copy-badge">{asset.copy_count} 份相同文件</span>}
                    <button title={asset.favorite ? '取消收藏' : '收藏素材'} className={`favorite-button ${asset.favorite ? 'is-favorite' : ''}`}
                      onClick={e => { e.stopPropagation(); run(() => patch(asset, { favorite: !asset.favorite })); }}><Heart size={15} fill={asset.favorite ? 'currentColor' : 'none'}/></button>
                    {query.text && strategy !== 'semantic' && asset.match_kind && <span className={`match-badge ${asset.keyword_fields?.length ? 'keyword' : ''}`}
                      title={asset.keyword_fields?.join('、') || '按画面语义相似度召回'}>
                      {asset.keyword_fields?.length ? `${asset.keyword_fields[0]}匹配` : '语义候选'}</span>}
                    {asset.score !== undefined && (!query.text || strategy === 'semantic') && <span className="score-badge">{asset.score.toFixed(3)}</span>}
                    {asset.status !== 'ready' && <span className={`asset-state ${asset.status}`} title={asset.error || ''}>{labels[asset.status]}</span>}
                  </div>
                  <div className="asset-caption"><strong>{asset.name}</strong><span>{groupedResources ? `${asset.ext.toUpperCase()} · ${asset.model ? `${asset.model.materials.length} 材质` : labels[asset.status] || '准备中'}` : asset.kind === 'model' ? `模型主文件${asset.model ? ` · ${asset.model.materials.length} 材质` : ''}` : asset.width ? `${asset.width} × ${asset.height}` : '读取中'}<i>·</i>{groupedResources ? '打开资产组' : bytes(asset.size)}</span></div>
                </div>)}
              </div>)}
            </div>
            {result.total > result.items.length && <div className="load-more"><button disabled={busy} onClick={() => setLimit(n => Math.min(n + 200, 1000))}>{limit >= 1000 ? '当前显示前 1000 项，请缩小筛选范围' : `加载更多（已显示 ${result.items.length} 项）`}</button></div>}
          </>}
        </main>
        {selected && <aside className="inspector">
          <div className="inspector-top"><span>素材详情</span><button title="关闭详情" onClick={() => setSelected(null)}><X size={17}/></button></div>
          <button className="inspector-preview" onClick={() => setPreview(true)}>{selected.thumbnail ? <img src={imageUrl(selected)} alt="选中素材预览"/> : <ImageIcon size={40}/>}<span><Maximize2 size={14}/> {selected.kind === 'model' ? '旋转查看 3D' : '大图预览'}</span></button>
          <h2>{selected.name}</h2><div className="detail-status"><i className={selected.status}/> {labels[selected.status]}</div>
          {selected.error && <p className="asset-error">{selected.error}</p>}
          {selected.status === 'missing' && <div className="detail-section"><h3>恢复文件关联</h3>
            <p className="organization-description">{selected.recovery_candidates?.length ? '以下文件内容与旧文件完全一致。选择一个位置接续原有标签、收藏和集合。' : '未找到内容一致的现存文件。请先检查原目录或磁盘，再重新扫描。'}</p>
            <div className="copy-list">{selected.recovery_candidates?.map(candidate => <div key={candidate.id}><p>{candidate.path}</p>
              <button disabled={recoveryBusy || Boolean(running)} onClick={() => reconnect(selected, candidate)}>使用此位置恢复</button></div>)}</div>
          </div>}
          <div className="detail-actions"><button className="primary" disabled={selected.status === 'error'
            ? retryBusy || summary.jobs.some(j => j.folder_id === selected.folder_id && ['queued', 'running'].includes(j.status))
            : selected.status !== 'ready'} onClick={() => selected.status === 'error' ? retry([selected.id]) : similar(selected)}>
            {selected.status === 'error' ? <><RefreshCw size={15}/> 重试索引</> : <><Sparkles size={15}/> 查找相似</>}
          </button><button title={selected.favorite ? '取消收藏' : '收藏素材'} onClick={() => run(() => patch(selected, { favorite: !selected.favorite }))}><Heart size={17} fill={selected.favorite ? 'currentColor' : 'none'}/></button></div>
          {selected.kind === 'model' && <ModelDetails asset={selected} connection={connection}/>}
          {selected.kind === 'model' && !modelGroup && <button className="text-action" onClick={() => enterModelGroup(selected)}>打开模型资产组</button>}
          {Boolean(selected.owners?.length) && <div className="detail-section"><h3>所属模型</h3><div className="owner-links">{selected.owners?.map(owner => <button className="text-action" key={owner.id} onClick={() => run(async () => openAsset(await api<Asset>(`/assets/${owner.id}`)))}>{owner.name} · {owner.relation === 'bound' ? '材质引用' : '同目录辅助'}</button>)}</div></div>}
          <div className="detail-section"><h3>文件信息</h3><dl><dt>{selected.kind === 'model' ? '顶点' : '尺寸'}</dt><dd>{selected.kind === 'model' ? selected.model?.vertices.toLocaleString() || '—' : `${selected.width} × ${selected.height}`}</dd><dt>格式</dt><dd>{selected.ext.toUpperCase()}</dd><dt>文件大小</dt><dd>{bytes(selected.size)}</dd><dt>导入时间</dt><dd>{new Date(selected.added * 1000).toLocaleDateString('zh-CN')}</dd></dl></div>
          <div className="detail-section"><h3>文件副本</h3>
            <p className="organization-description">详情中的标签和收藏只修改当前文件。批量整理可处理选中项的全部副本。</p>
            <button className="text-action" onClick={() => run(async () => { const data = await api<{ items: Asset[] }>(`/assets/${selected.id}/copies`); setCopies(data.items); })}>查看全部未排除副本</button>
            {copies && <div className="copy-list">{copies.map(a => <div key={a.id}><p>{a.path}</p><button onClick={() => window.prism.reveal(a.path)}>定位</button>
              <button onClick={() => run(async () => { openAsset(await api<Asset>(`/assets/${a.id}`)); })}>详情</button></div>)}</div>}
          </div>
          <div className="detail-section"><h3>所在集合</h3><div className="collection-chips">{selected.collections?.filter(c => summary.collections.some(item => item.id === c.id)).map(c => <button className="text-action" key={c.id} onClick={() => chooseScope(`collection:${c.id}`)}>
            {summary.collections.find(item => item.id === c.id)?.path || c.path || c.name}</button>)}</div>
            <div className="detail-organize-controls"><select aria-label="详情目标集合" disabled={organizeBusy || !summary.collections.length}
              value={summary.collections.some(c => c.id === detailCollection) ? detailCollection : ''} onChange={e => setDetailCollection(e.target.value)}>
              <option value="">{summary.collections.length ? '选择集合…' : '尚无集合'}</option>{collectionOptions.map(c => <option key={c.id} value={c.id}>{c.path}</option>)}</select>
              <button disabled={organizeBusy || !summary.collections.some(c => c.id === detailCollection)} onClick={joinDetailCollection}>加入当前素材</button></div>
            <button className="text-action" aria-label="详情新建集合" onClick={() => newCollection('detail', detailCollection || collection?.id || null)}>新建集合</button>
            <button className="text-action bulk-detail-entry" title="选择此素材后，通过批量工具栏添加标签、收藏或加入集合" onClick={() => {
              const item = result.items.find(a => (a.member_ids || [a.id]).includes(selected.id));
              if (item) { setMultiMode(true); setChecked([item.id]); }
              else notify('此文件不在当前结果范围内，请切换到全部素材后选择');
            }}>批量整理此项</button></div>
          <div className="detail-section"><h3><Tag size={13}/> 标签</h3><div className="asset-tags">{selected.tags.map(t => <span key={t}>{t}<button title={`删除标签 ${t}`} onClick={() => run(() => patch(selected, { tags: selected.tags.filter(x => x !== t) }))}><X size={11}/></button></span>)}</div>
            <form onSubmit={e => { e.preventDefault(); applyDetailTag(); }}>
              <select aria-label="详情已有标签" disabled={organizeBusy} value={summary.tags.some(t => t.name === tagDraft) ? tagDraft : ''} onChange={e => setTagDraft(e.target.value)}>
                <option value="">选择已有标签…</option>{summary.tags.map(t => <option key={t.name} value={t.name}>{t.name}{selected.tags.includes(t.name) ? '（已应用）' : ''}</option>)}</select>
              <input aria-label="添加标签" disabled={organizeBusy} placeholder="或输入新标签，回车保存" value={tagDraft} maxLength={64} onChange={e => setTagDraft(e.target.value)}/>
              <button className="text-action" type="submit" disabled={organizeBusy || !tagDraft.trim() || selected.tags.includes(tagDraft.trim())}>
                {tagDraft.trim() && selected.tags.includes(tagDraft.trim()) ? '已应用此标签' : '应用标签'}</button>
            </form></div>
          <div className="detail-section"><h3>原始位置</h3><p className="file-path">{selected.path}</p><div className="path-actions"><button onClick={() => run(() => window.prism.reveal(selected.path))}><FolderOpen size={14}/> Finder</button><button onClick={() => run(async () => { await window.prism.copy(selected.path); notify('已复制原始路径'); })}><Copy size={14}/> 复制路径</button></div>
            <button className="open-original" onClick={() => run(() => window.prism.openFile(selected.id))}>使用默认应用打开 <ArrowRight size={13}/></button></div>
          {Boolean(selected.history?.length) && <div className="detail-section"><h3>历史位置</h3>{selected.history?.map((entry, i) =>
            <p className="file-path" key={i}>{entry.old_path}</p>)}<p className="organization-description">旧路径记录已保留，当前使用上方的现存文件。</p></div>}
        </aside>}
      </div>
      <footer className="footer"><span><HardDrive size={12}/> {summary.total} 个文件 · {summary.counts.ready || 0} 个已索引</span><span>{loading ? searching ? '正在搜索…' : '正在读取列表…' : searching ? query.text && strategy !== 'semantic' ? strategy === 'keyword' ? '关键词匹配' : '关键词优先 · 语义补充' : '按视觉相关度排序' : '目录变动自动同步'} <i/> 空格预览</span></footer>
    </section>
    {tasksOpen && <div className="task-panel"><div className="panel-heading"><div><span className="eyebrow">BACKGROUND ACTIVITY</span><h2>索引任务</h2></div><button title="关闭任务" onClick={() => setTasksOpen(false)}><X size={18}/></button></div>
      {summary.model_error && <p className="asset-error">{summary.model_error}</p>}
      <p className="panel-note">索引在后台进行，搜索请求会优先处理。</p>
      {summary.jobs.length ? summary.jobs.map(j => <div className="job" key={j.id}><div><Folder size={16}/><strong>{j.name}</strong><span className={j.failed ? 'text-warning' : ''}>{labels[j.status]}</span></div>
        <progress max={j.total || 1} value={j.done}/><div className="job-meta"><span>{j.done} / {j.total} 项 {j.failed > 0 && `· ${j.failed} 项失败`}</span>{['partial', 'failed', 'interrupted'].includes(j.status) && <button onClick={() => { const f = summary.folders.find(f => f.id === j.folder_id); if (f) scan(f); }}><RefreshCw size={12}/> 重试</button>}</div>{j.error && <p className="asset-error">{j.error}</p>}</div>)
        : <div className="task-empty"><Check size={25}/><p>暂无索引任务</p></div>}</div>}
    {settingsOpen && <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}><section className="settings-modal" role="dialog" aria-label="设置与帮助" onClick={e => e.stopPropagation()}>
      <div className="panel-heading"><div><span className="eyebrow">LOCAL, BY DESIGN</span><h2>你的素材，留在你的电脑。</h2></div><button title="关闭设置" onClick={() => setSettingsOpen(false)}><X size={20}/></button></div>
      <div className="settings-info"><HardDrive size={22}/><div><strong>Prism Assets 0.3.1 · Apple Silicon</strong><p>图文检索与索引完全本地运行。支持静态图片与 TGA，以及 PMX、FBX、GLB、glTF 模型。模型预览需安装 Blender：{summary.blender_available ? '已检测到' : '未检测到，请安装到“应用程序”后重试索引'}。</p></div></div>
      <h3>关联目录</h3>{summary.folders.map(f => <div className="folder-setting" key={f.id}><Folder size={18}/><div><strong>{f.name}</strong><p>{f.path}</p><small>{f.status === 'online' ? '在线' : '目录不可访问'} · {f.count} 个文件 · 已排除 {f.excluded_count} 个</small></div>
        <button aria-label={`排除子目录 ${f.name}`} title={`排除子目录 ${f.name}`} onClick={() => setExclusionEditor(f)}>排除</button><button title={`重新扫描 ${f.name}`} onClick={() => scan(f)}><RefreshCw size={16}/></button><button title={`解除关联 ${f.name}`} onClick={() => run(async () => {
        if (await window.prism.confirmDetach(f.name)) { await api(`/folders/${f.id}`, 'DELETE'); chooseScope('all'); await loadSummary(); setRefresh(n => n + 1); }
      })}><Trash2 size={16}/></button></div>)}
      <button className="add-folder inline" onClick={addFolder}><FolderPlus size={16}/> 关联文件夹</button>
      <h3>本地数据</h3><p className="settings-copy">索引、标签、收藏和缩略图存放在下方目录。备份前请退出应用，再复制整个目录。</p><button className="data-path" onClick={() => window.prism.reveal(summary.data_dir)}>{summary.data_dir}<FolderOpen size={15}/></button>
      <div className="help-note"><CircleHelp size={17}/><p>3D 检索基于模型的两张外观预览图，不判断拓扑或动作。PMX 展示基础材质，MMD 特效不完整还原；当前不播放动画。图片限制 100 MB / 4000 万像素，模型限制 512 MB。暂不解析视频与 PSD。</p></div>
    </section></div>}
    {collectionEditor && <CollectionEditor collection={collectionEditor === 'new' ? undefined : collectionEditor}
      collections={summary.collections} parentId={newCollectionParent} close={() => setCollectionEditor(null)}
      saved={async (id, deleted) => {
        resultCache.current.clear(); await loadSummary(); setRefresh(n => n + 1);
        if (!deleted && collectionIntent === 'bulk') setBulkCollection(id || '');
        else if (!deleted && collectionIntent === 'detail') setDetailCollection(id || '');
        else if (deleted && collection?.id === id) chooseScope(collectionEditor !== 'new' && collectionEditor.parent_id ? `collection:${collectionEditor.parent_id}` : 'all');
        else if (!deleted && collectionEditor === 'new') chooseScope(`collection:${id}`);
      }}/>}
    {exclusionEditor && <ExclusionEditor folder={exclusionEditor} close={() => setExclusionEditor(null)}
      saved={async () => { await loadSummary(); setRefresh(n => n + 1); setChecked([]); setSelected(null); }}/>}
    {preview && selected && (selected.kind === 'model' ? <ModelViewer asset={selected} connection={connection} close={() => setPreview(false)}/> : <div className="lightbox" role="dialog" aria-label="大图预览" onClick={() => setPreview(false)}><button title="关闭预览" onClick={() => setPreview(false)}><X size={23}/></button>{previewError ? <p>原图无法读取，请检查文件是否移动或磁盘是否连接。</p> : <img src={imageUrl(selected, true)} alt={selected.name} onError={() => setPreviewError(true)} onClick={e => e.stopPropagation()}/>}<div>{selected.name}<span>{selected.width} × {selected.height} · ESC 关闭</span></div></div>)}
    {dragging && <div className="drop-overlay" onDragLeave={() => setDragging(false)}><ImagePlus size={48}/><h2>放入参考图片，寻找相似素材</h2><p>图片仅在本机处理</p></div>}
    {notice && <div className="toast" role="status"><span>{notice}</span><button title="关闭提示" onClick={() => setNotice('')}><X size={15}/></button></div>}
  </div>;
}

export default App;
const appRoot = import.meta.hot?.data.appRoot || createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.data.appRoot = appRoot;
appRoot.render(<App/>);
