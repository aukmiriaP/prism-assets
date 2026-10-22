import React, { useEffect, useState } from 'react';
import { X, Folder, Trash2, ChevronRight, ChevronDown, Plus, Pencil } from 'lucide-react';
import type { Collection, Folder as FolderType } from './types';

const api = <T,>(route: string, method?: string, body?: unknown) => window.prism.api<T>(route, method, body);
const message = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': Error: /, '');

export const orderedCollections = (collections: Collection[]) => [...collections]
  .sort((a, b) => (a.path || a.name).localeCompare(b.path || b.name, 'zh-CN'));

export function CollectionTree({ collections, activeId, open, create, edit }: {
  collections: Collection[]; activeId?: string; open: (id: string) => void;
  create: (id: string) => void; edit: (collection: Collection) => void;
}) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const activeAncestors = collections.find(c => c.id === activeId)?.ancestor_ids || [];
  const ancestorKey = activeAncestors.join(',');
  useEffect(() => { setCollapsed(old => old.filter(id => !activeAncestors.includes(id))); }, [ancestorKey]);
  const branches = new Map<string | null, Collection[]>();
  for (const item of collections) {
    const parent = item.parent_id || null;
    branches.set(parent, [...(branches.get(parent) || []), item]);
  }
  const render = (parent: string | null): React.ReactNode => (branches.get(parent) || []).map(item => {
    const children = branches.get(item.id)?.length || 0, expanded = !collapsed.includes(item.id);
    return <div className="collection-branch" key={item.id}>
      <div className={`collection-tree-row ${activeId === item.id ? 'active' : ''}`}>
        {children ? <button className="collection-expander" aria-label={`${expanded ? '折叠' : '展开'}集合 ${item.path}`}
          aria-expanded={expanded} onClick={() => setCollapsed(old => expanded ? [...old, item.id] : old.filter(id => id !== item.id))}>
          {expanded ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}</button> : <span className="collection-expander-spacer"/>}
        <button className="collection-open" title={`${item.path} · ${item.count} 个直属文件`}
          onClick={() => open(item.id)}><Folder size={13}/><b>{item.name}</b><span>{item.count}</span></button>
        <button className="collection-tree-action" aria-label={`新建子集合 ${item.path}`} title="新建子集合" onClick={() => create(item.id)}><Plus size={12}/></button>
        <button className="collection-tree-action" aria-label={`编辑集合 ${item.path}`} title="修改名称或所属父集合" onClick={() => edit(item)}><Pencil size={11}/></button>
      </div>
      {children > 0 && expanded && <div className="collection-children">{render(item.id)}</div>}
    </div>;
  });
  return <>{collections.length ? render(null) : <p className="nav-empty">按项目或主题收集素材</p>}</>;
}

export function ExclusionEditor({ folder, close, saved }: {
  folder: FolderType; close: () => void; saved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(folder.exclusions.join('\n'));
  const [impact, setImpact] = useState<{ excluded_files: number; newly_excluded: number; restored_files: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = (value: string) => { setDraft(value); setImpact(null); setError(''); };
  const submit = async (preview: boolean) => {
    setBusy(true); setError('');
    try {
      const result = await api<NonNullable<typeof impact>>(`/folders/${folder.id}/exclusions`, 'POST',
        { rules: draft.split('\n').map(s => s.trim()).filter(Boolean), preview });
      if (preview) setImpact(result);
      else { await saved(); close(); }
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onClick={close}><section className="organization-modal" role="dialog" aria-label="目录排除" onClick={e => e.stopPropagation()}>
    <div className="panel-heading"><div><span className="eyebrow">SCAN SCOPE</span><h2>排除子目录</h2></div><button aria-label="关闭目录排除" onClick={close}><X size={20}/></button></div>
    <p className="organization-description"><Folder size={14}/> {folder.name}<br/>{folder.path}</p>
    <label className="form-label" htmlFor="exclusion-rules">每行一个目录</label>
    <textarea id="exclusion-rules" aria-label="排除规则" value={draft} disabled={busy} onChange={e => change(e.target.value)} placeholder={'node_modules\nbuild\nComfyUI/output'} rows={7}/>
    <p className="organization-description">单个名称（如 build）排除任意层级的同名目录；带 / 的路径从当前关联目录开始匹配。排除后保留文件、标签、收藏与集合关系，取消排除可恢复。</p>
    <button className="text-action" disabled={busy} onClick={() => change([...new Set([...draft.split('\n').filter(Boolean), 'node_modules', 'build', 'dist', 'release', '__pycache__'])].join('\n'))}>填入常见开发目录</button>
    {impact && <div className="impact" role="status">已入库文件中：将排除 {impact.excluded_files} 个（新增 {impact.newly_excluded} 个），恢复 {impact.restored_files} 个。尚未入库的目录将在扫描时跳过。</div>}
    {error && <p className="asset-error" role="alert">{error}</p>}
    <div className="modal-actions"><button disabled={busy} onClick={() => submit(true)}>预览影响</button><button className="primary" disabled={busy || !impact} onClick={() => submit(false)}>保存排除规则</button></div>
  </section></div>;
}

export function CollectionEditor({ collection, collections, parentId, close, saved }: {
  collection?: Collection; collections: Collection[]; parentId?: string | null;
  close: () => void; saved: (id?: string, deleted?: boolean) => Promise<void>;
}) {
  const [name, setName] = useState(collection?.name || '');
  const [parent, setParent] = useState(collection ? collection.parent_id || '' : parentId || '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (remove = false) => {
    setBusy(true); setError('');
    try {
      if (remove && collection) {
        await api(`/collections/${collection.id}`, 'DELETE');
        await saved(collection.id, true);
      } else {
        const result = await api<Collection>(collection ? `/collections/${collection.id}` : '/collections',
          collection ? 'PATCH' : 'POST', { name: name.trim(), parent_id: parent || null });
        await saved(result.id);
      }
      close();
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onClick={close}><section className="organization-modal" role="dialog" aria-label={collection ? '管理集合' : '新建集合'} onClick={e => e.stopPropagation()}>
    <div className="panel-heading"><h2>{collection ? '管理集合' : '新建集合'}</h2><button aria-label="关闭集合窗口" onClick={close}><X size={20}/></button></div>
    <p className="organization-description">按项目建立多级集合，同一素材可加入多个集合。修改名称或父集合会保留素材关系，原文件位置保持不变。</p>
    <form onSubmit={e => { e.preventDefault(); submit(); }}>
      <label className="form-label" htmlFor="collection-name">集合名称</label>
      <input id="collection-name" aria-label="集合名称" autoFocus disabled={busy} maxLength={64} value={name} onChange={e => { setName(e.target.value); setConfirmDelete(false); }} placeholder="例如：角色资产、丽芙"/>
      <label className="form-label" htmlFor="collection-parent">所属父集合</label>
      <select id="collection-parent" aria-label="所属父集合" disabled={busy} value={parent} onChange={e => { setParent(e.target.value); setConfirmDelete(false); }}>
        <option value="">无（顶级集合）</option>
        {orderedCollections(collections).filter(c => c.id !== collection?.id && !(c.ancestor_ids || []).includes(collection?.id || ''))
          .map(c => <option key={c.id} value={c.id}>{c.path}</option>)}
      </select>
      <p className="organization-description collection-path-preview">路径：{parent ? `${collections.find(c => c.id === parent)?.path || ''} / ` : ''}{name.trim() || '新集合'}</p>
      {error && <p className="asset-error" role="alert">{error}</p>}
      <div className="modal-actions">
        {collection && <button type="button" disabled={busy || collection.child_count > 0} onClick={() => confirmDelete ? submit(true) : setConfirmDelete(true)}><Trash2 size={14}/>{confirmDelete ? '确认删除集合' : '删除集合'}</button>}
        <button type="submit" className="primary" disabled={busy || !name.trim()}>{collection ? '保存集合' : '创建集合'}</button>
      </div>
      {confirmDelete && <p className="organization-description">只删除集合与成员关系，素材、标签和收藏保留。</p>}
      {collection && collection.child_count > 0 && <p className="organization-description">包含 {collection.child_count} 个子集合；请先移出或删除子集合，再删除当前集合。</p>}
    </form>
  </section></div>;
}
