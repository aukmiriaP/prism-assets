import React, { useState } from 'react';
import { X, Folder, Trash2 } from 'lucide-react';
import type { Collection, Folder as FolderType } from './types';

const api = <T,>(route: string, method?: string, body?: unknown) => window.prism.api<T>(route, method, body);
const message = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': Error: /, '');

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

export function CollectionEditor({ collection, close, saved }: {
  collection?: Collection; close: () => void; saved: (id?: string, deleted?: boolean) => Promise<void>;
}) {
  const [name, setName] = useState(collection?.name || '');
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
          collection ? 'PATCH' : 'POST', { name: name.trim() });
        await saved(result.id);
      }
      close();
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onClick={close}><section className="organization-modal" role="dialog" aria-label={collection ? '管理集合' : '新建集合'} onClick={e => e.stopPropagation()}>
    <div className="panel-heading"><h2>{collection ? '管理集合' : '新建集合'}</h2><button aria-label="关闭集合窗口" onClick={close}><X size={20}/></button></div>
    <p className="organization-description">把不同目录的素材放在一起。同一素材可加入多个集合，原文件位置保持不变。</p>
    <form onSubmit={e => { e.preventDefault(); submit(); }}>
      <label className="form-label" htmlFor="collection-name">集合名称</label>
      <input id="collection-name" aria-label="集合名称" autoFocus maxLength={64} value={name} onChange={e => setName(e.target.value)} placeholder="例如：森林场景参考"/>
      {error && <p className="asset-error" role="alert">{error}</p>}
      <div className="modal-actions">
        {collection && <button type="button" disabled={busy} onClick={() => confirmDelete ? submit(true) : setConfirmDelete(true)}><Trash2 size={14}/>{confirmDelete ? '确认删除集合' : '删除集合'}</button>}
        <button type="submit" className="primary" disabled={busy || !name.trim()}>{collection ? '保存集合' : '创建集合'}</button>
      </div>
      {confirmDelete && <p className="organization-description">只删除集合与成员关系，素材、标签和收藏保留。</p>}
    </form>
  </section></div>;
}
