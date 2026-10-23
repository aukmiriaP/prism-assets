import React, { useEffect, useRef, useState } from 'react';
import { X, Folder, Trash2, ChevronRight, ChevronDown, Plus, Pencil, RefreshCw } from 'lucide-react';
import type { Collection, Directory, Folder as FolderType } from './types';

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
  const [draft, setDraft] = useState(folder.exclusions);
  const [tree, setTree] = useState<Record<string, { items?: Directory[]; loading?: boolean; error?: string }>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const generation = useRef(0);
  const [impact, setImpact] = useState<{ excluded_files: number; newly_excluded: number; restored_files: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async (parent: string, current = generation.current) => {
    setTree(old => ({ ...old, [parent]: { loading: true } }));
    try {
      const result = await api<{ items: Directory[] }>(`/folders/${folder.id}/directories?parent=${encodeURIComponent(parent)}`);
      if (generation.current === current) setTree(old => ({ ...old, [parent]: { items: result.items } }));
    } catch (e) {
      if (generation.current === current) setTree(old => ({ ...old, [parent]: { error: message(e) } }));
    }
  };
  const refresh = () => {
    generation.current += 1;
    setTree({}); setExpanded([]);
    load('');
  };
  useEffect(() => {
    refresh();
    return () => { generation.current += 1; };
  }, [folder.id]);
  const change = (value: string[]) => {
    if (value.length > 100) { setError('最多选择 100 个排除范围'); return; }
    setDraft(value); setImpact(null); setError('');
  };
  const toggle = (path: string, checked: boolean) => {
    const rule = `./${path}`;
    change(checked ? [...draft.filter(r => r !== rule && !r.startsWith(`${rule}/`)), rule]
      : draft.filter(r => r !== rule));
  };
  const covers = (rule: string, path: string) => {
    const relative = rule.startsWith('./') ? rule.slice(2) : rule;
    if (rule.startsWith('./') || relative.includes('/')) return path === relative || path.startsWith(`${relative}/`);
    return path.split('/').includes(relative);
  };
  const expand = (path: string) => {
    const open = expanded.includes(path);
    setExpanded(old => open ? old.filter(p => p !== path) : [...old, path]);
    if (!open && !tree[path]?.items && !tree[path]?.loading) load(path);
  };
  const render = (parent = '', depth = 0): React.ReactNode => {
    const branch = tree[parent];
    if (!branch || branch.loading) return <p className="directory-state" role="status">正在读取文件夹…</p>;
    if (branch.error) return <div className="directory-state directory-error" role="alert"><span>{branch.error}</span>
      <button disabled={busy} onClick={() => load(parent)}>重试读取</button></div>;
    if (!branch.items?.length) return <p className="directory-state">{parent ? '没有子文件夹' : '当前目录没有可选的子文件夹'}</p>;
    return branch.items.map(item => {
      const exact = draft.includes(`./${item.path}`);
      const inherited = draft.some(rule => rule !== `./${item.path}` && covers(rule, item.path));
      const partial = !exact && !inherited && draft.some(rule => rule.startsWith(`./${item.path}/`));
      const open = expanded.includes(item.path);
      const leaf = tree[item.path]?.items?.length === 0;
      return <div className="directory-branch" key={item.path}>
        <div className={`directory-row ${inherited ? 'inherited' : ''}`} style={{ paddingLeft: 8 + depth * 18 }}>
          {leaf ? <span className="directory-expander-spacer"/> : <button className="directory-expander"
            aria-label={`${open ? '折叠' : '展开'}文件夹 ${item.path}`} aria-expanded={open}
            disabled={busy} onClick={() => expand(item.path)}>{open ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button>}
          <label title={`${item.path}${inherited ? ' · 已包含在其他排除范围中，可在「已选范围」中取消' : ''}`}>
            <input type="checkbox" aria-label={`排除文件夹 ${item.path}`} checked={exact || inherited}
              ref={el => { if (el) el.indeterminate = partial; }} disabled={busy || inherited}
              onChange={e => toggle(item.path, e.target.checked)}/>
            <Folder size={15}/><span>{item.name}</span>
          </label>
          {inherited && <small>已包含</small>}
          {partial && <small>已选子目录</small>}
        </div>
        {open && !leaf && <div className="directory-children">{render(item.path, depth + 1)}</div>}
      </div>;
    });
  };
  const submit = async (preview: boolean) => {
    setBusy(true); setError('');
    try {
      const result = await api<NonNullable<typeof impact>>(`/folders/${folder.id}/exclusions`, 'POST',
        { rules: draft, preview });
      if (preview) setImpact(result);
      else { await saved(); close(); }
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  const dismiss = () => { if (!busy) close(); };
  return <div className="modal-backdrop" onClick={dismiss}><section className="organization-modal exclusion-modal" role="dialog" aria-modal="true" aria-label="目录排除"
    onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); dismiss(); } }}>
    <div className="panel-heading"><div><h2>排除子目录</h2><p>勾选要跳过的文件夹，展开后可单独选择子目录。</p></div>
      <button aria-label="关闭目录排除" autoFocus disabled={busy} onClick={dismiss}><X size={20}/></button></div>
    <div className="exclusion-content">
      <div className="exclusion-root"><Folder size={16}/><div><strong>{folder.name}</strong><p title={folder.path}>{folder.path}</p></div></div>
      <div className="directory-toolbar"><span>当前目录的文件夹</span>
        <button aria-label="刷新文件夹列表" title="重新读取目录" disabled={busy || !!tree['']?.loading} onClick={refresh}><RefreshCw size={12}/>刷新</button></div>
      <div className="directory-tree" role="group" aria-label="可排除的文件夹">{render()}</div>
      {draft.length > 0 && <details className="exclusion-selections">
        <summary>已选范围 <span>{draft.length}</span><ChevronDown size={12}/></summary>
        <div>{draft.map(rule => <label className="exclusion-selected" key={rule}>
          <input type="checkbox" aria-label={`取消排除 ${rule.startsWith('./') ? rule.slice(2) : rule}`} checked disabled={busy}
            onChange={() => change(draft.filter(r => r !== rule))}/>
          <span>{rule.startsWith('./') ? rule.slice(2) : rule}<small>{!rule.startsWith('./') && !rule.includes('/')
            ? '已有设置 · 所有层级的同名文件夹' : '相对于当前关联目录 · 包含子文件夹'}</small></span>
        </label>)}</div>
      </details>}
    </div>
    <footer className="exclusion-footer">
      <p className="organization-description">选中父目录会包含其子目录。排除后保留原文件、标签、收藏与集合，取消勾选可恢复。</p>
      {impact && <div className="impact" role="status">已入库文件中：将排除 {impact.excluded_files} 个（新增 {impact.newly_excluded} 个），恢复 {impact.restored_files} 个。尚未入库的目录将在扫描时跳过。</div>}
      {error && <p className="asset-error" role="alert">{error}</p>}
      <div className="modal-actions"><button disabled={busy} onClick={() => submit(true)}>预览影响</button><button className="primary" disabled={busy || !impact} onClick={() => submit(false)}>保存排除规则</button></div>
    </footer>
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
