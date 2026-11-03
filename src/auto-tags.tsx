import React, { useEffect, useState } from 'react';
import { Check, Plus, RotateCcw, Sparkles, Trash2, X } from 'lucide-react';
import type { Asset, TagGroup, TagSuggestion } from './types';

const api = <T,>(route: string, method?: string, body?: unknown) => window.prism.api<T>(route, method, body);
const message = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': Error: /, '');
const sourceLabel: Record<TagSuggestion['source'], string> = {
  prompt: '英文描述', examples: '已打标签的样例', 'prompt+examples': '英文描述 + 已打标签的样例', color: '像素颜色',
};

const basis = (s: TagSuggestion) =>
  `${s.group} · 依据${sourceLabel[s.source]} · ${s.source === 'color' ? '画面占比' : '组内份额'} ${Math.round(s.score * 100)}%`;

/** Suggestions for one asset in the inspector. Nothing is written until the user accepts. */
export function DetailSuggestions({ asset, accept, enabled }: {
  asset: Asset; enabled: boolean; accept: (tags: string[]) => Promise<void>;
}) {
  const [items, setItems] = useState<TagSuggestion[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState('');
  const tagsKey = asset.tags.join('\n');
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    setError(''); setActive('');
    api<{ suggestions: Record<string, TagSuggestion[]> }>('/tags/suggest', 'POST', { ids: [asset.id] })
      .then(data => { if (!stopped) setItems(data.suggestions[asset.id] || []); })
      .catch(e => { if (!stopped) { setItems([]); setError(message(e)); } });
    return () => { stopped = true; };
  }, [asset.id, asset.status, tagsKey, enabled]);
  if (!enabled) return null;
  const take = async (tags: string[]) => {
    setBusy(true);
    try { await accept(tags); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const dismiss = async (label: string) => {
    setBusy(true);
    try { await api('/tags/dismiss', 'POST', { ids: [asset.id], label }); setItems(old => old?.filter(s => s.label !== label) || null); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return <div className="tag-suggestions" aria-label="建议标签">
    <div className="suggestion-heading"><span><Sparkles size={11}/> 建议标签</span>
      {items && items.length > 1 && <button className="text-action" disabled={busy} onClick={() => take(items.map(s => s.label))}>全部采纳</button>}</div>
    {items === null ? <p className="organization-description">正在分析…</p>
      : items.length ? <>
        <div className="suggestion-chips" onMouseLeave={() => setActive('')}>{items.map(s => <span key={s.label}
          className={`suggestion-chip ${active === s.label ? 'active' : ''}`} onMouseEnter={() => setActive(s.label)}
          onFocus={() => setActive(s.label)} onBlur={() => setActive('')}>
          <button disabled={busy} aria-label={`采纳建议标签 ${s.label}`} aria-describedby={`basis-${asset.id}`} onClick={() => take([s.label])}><Plus size={11}/>{s.label}</button>
          <button disabled={busy} aria-label={`忽略建议标签 ${s.label}`} onClick={() => dismiss(s.label)}><X size={11}/></button>
        </span>)}</div>
        <p className="suggestion-basis" id={`basis-${asset.id}`} aria-live="polite">{(() => {
          const s = items.find(item => item.label === active);
          return s ? `${s.label}：${basis(s)}。× 忽略后此素材不再建议` : '悬停或聚焦建议标签可查看依据';
        })()}</p></>
      : <p className="organization-description">{asset.status === 'ready' ? '暂无达到阈值的建议。' : '索引完成后提供类别建议，当前仅检查颜色。'}</p>}
    {error && <p className="asset-error">{error}</p>}
  </div>;
}

type Review = { label: string; group: string; source: TagSuggestion['source']; ids: string[]; score: number };

/** Groups suggestions for the checked items by label, so 40 “道具” cards are confirmed in one click. */
export function BulkSuggestions({ items, close, done }: {
  items: Asset[]; close: () => void; done: (text: string) => Promise<void>;
}) {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = items.map(a => a.id).join(',');
  useEffect(() => {
    let stopped = false;
    setReviews(null); setError('');
    api<{ suggestions: Record<string, TagSuggestion[]> }>('/tags/suggest', 'POST', { ids: items.slice(0, 1000).map(a => a.id) }).then(data => {
      if (stopped) return;
      const byLabel = new Map<string, Review>();
      for (const asset of items) for (const s of data.suggestions[asset.id] || []) {
        const entry = byLabel.get(s.label) || { label: s.label, group: s.group, source: s.source, ids: [], score: 0 };
        // A grouped card stands for every exact copy in scope, as in the bulk toolbar.
        entry.ids.push(...(asset.member_ids || [asset.id])); entry.score += s.score;
        byLabel.set(s.label, entry);
      }
      setReviews([...byLabel.values()].map(r => ({ ...r, score: r.score / r.ids.length }))
        .sort((a, b) => b.ids.length - a.ids.length || a.label.localeCompare(b.label, 'zh-CN')));
    }).catch(e => { if (!stopped) { setReviews([]); setError(message(e)); } });
    return () => { stopped = true; };
  }, [key]);
  const act = async (review: Review, accept: boolean) => {
    setBusy(true);
    try {
      const ids = [...new Set(review.ids)];
      if (accept) await api('/assets/bulk', 'POST', { ids, add_tags: [review.label] });
      else await api('/tags/dismiss', 'POST', { ids, label: review.label });
      setReviews(old => old?.filter(r => r.label !== review.label) || null);
      await done(accept ? `已为 ${ids.length} 个文件添加「${review.label}」` : `已忽略 ${ids.length} 个文件的「${review.label}」建议`);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return <div className="bulk-suggestions" role="region" aria-label="批量建议标签">
    <div className="suggestion-heading"><span><Sparkles size={11}/> 建议标签 · {items.length} 项</span>
      <button className="text-action" onClick={close}>收起</button></div>
    {items.length > 1000 && <p className="organization-description">一次最多分析 1000 项，已取前 1000 项。</p>}
    {reviews === null ? <p className="organization-description">正在分析选中的素材…</p>
      : reviews.length ? <div className="suggestion-rows">{reviews.map(r => <div className="suggestion-row" key={r.label}>
        <strong>{r.label}</strong><span>{r.group} · {r.ids.length} 个文件 · 依据{sourceLabel[r.source]} · 平均{r.source === 'color' ? '画面占比' : '组内份额'} {Math.round(r.score * 100)}%</span>
        <button disabled={busy} onClick={() => act(r, true)}><Check size={12}/>采纳</button>
        <button disabled={busy} onClick={() => act(r, false)}><X size={12}/>忽略</button></div>)}</div>
      : <p className="organization-description">选中的素材暂无达到阈值的建议。</p>}
    {error && <p className="asset-error">{error}</p>}
  </div>;
}

const blankLabel = { label: '', prompt: '' };

/** Settings → 自动标签: edit groups, English prompts and thresholds. */
export function TagVocabularySettings({ changed }: { changed: (groups: TagGroup[]) => void }) {
  const [groups, setGroupsState] = useState<TagGroup[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ groups: TagGroup[] }>('/tags/vocabulary').then(d => setGroupsState(d.groups)).catch(e => setError(message(e))); }, []);
  if (!groups) return <p className="settings-empty">{error || '正在读取词表…'}</p>;
  const setGroups = (update: (old: TagGroup[]) => TagGroup[]) => { setSaved(false); setGroupsState(old => old && update(old)); };
  const edit = (index: number, change: Partial<TagGroup>) => setGroups(old => old.map((g, i) => i === index ? { ...g, ...change } : g));
  const persist = async (method: 'POST' | 'DELETE') => {
    setBusy(true); setError('');
    try {
      const body = method === 'POST' ? { groups: groups.map(g => ({ ...g, labels: g.labels.filter(l => l.label.trim()) })) } : undefined;
      const data = await api<{ groups: TagGroup[] }>('/tags/vocabulary', method, body);
      setGroupsState(data.groups); changed(data.groups); setSaved(true);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return <section className="tag-vocabulary" aria-label="自动标签设置">
    <div className="settings-page-heading"><h3>自动标签</h3>
      <p>用本机检索模型给素材推荐标签，采纳后才写入。每组标签互相比较，取最匹配的一个；组内份额达到阈值才显示。
        英文描述决定匹配效果；某个标签被手动打在 3 个以上已索引素材上后，会同时参考这些样例。主色直接从缩略图像素计算。</p></div>
    {groups.map((group, gi) => <div className="tag-group" key={group.id}>
      <div className="tag-group-head">
        <label className="tag-group-toggle"><input type="checkbox" checked={group.enabled} aria-label={`启用分组 ${group.name}`}
          onChange={e => edit(gi, { enabled: e.target.checked })}/>
          <input className="tag-group-name" aria-label="分组名称" value={group.name} maxLength={32} onChange={e => edit(gi, { name: e.target.value })}/></label>
        <label className="tag-threshold">阈值<input type="number" aria-label={`${group.name} 阈值`} min={0.05} max={0.95} step={0.05}
          value={group.threshold} onChange={e => edit(gi, { threshold: Number(e.target.value) })}/></label>
        {group.kind === 'prompt' && <button title={`删除分组 ${group.name}`} aria-label={`删除分组 ${group.name}`}
          onClick={() => setGroups(old => old.filter((_, i) => i !== gi))}><Trash2 size={14}/></button>}
      </div>
      {group.kind === 'color' ? <p className="organization-description">固定 12 种颜色：{group.labels.map(l => l.label).join('、')}。阈值是颜色在画面中的占比，模型与材质封面会忽略纯色背景。</p>
        : <div className="tag-label-list">{group.labels.map((item, li) => <div className="tag-label-row" key={li}>
          <input aria-label="标签名" placeholder="标签名" value={item.label} maxLength={64}
            onChange={e => edit(gi, { labels: group.labels.map((l, i) => i === li ? { ...l, label: e.target.value } : l) })}/>
          <input aria-label={`${item.label || '标签'} 英文描述`} placeholder="英文描述，如 game prop" value={item.prompt} maxLength={300}
            onChange={e => edit(gi, { labels: group.labels.map((l, i) => i === li ? { ...l, prompt: e.target.value } : l) })}/>
          <button title="删除标签" aria-label={`删除标签 ${item.label}`} onClick={() => edit(gi, { labels: group.labels.filter((_, i) => i !== li) })}><X size={13}/></button>
        </div>)}
          <button className="text-action" onClick={() => edit(gi, { labels: [...group.labels, { ...blankLabel }] })}><Plus size={12}/> 添加标签</button></div>}
    </div>)}
    <div className="tag-vocabulary-actions">
      <button className="text-action" onClick={() => setGroups(old => [...old, { id: `group-${Date.now().toString(36)}`, name: '新分组', kind: 'prompt',
        enabled: true, threshold: 0.6, labels: [{ ...blankLabel }, { ...blankLabel }] }])}><Plus size={12}/> 新建分组</button>
      <span/>
      <button disabled={busy} onClick={() => persist('DELETE')}><RotateCcw size={13}/> 恢复默认</button>
      <button className="primary" disabled={busy} onClick={() => persist('POST')}>保存词表</button>
    </div>
    {error && <p className="asset-error">{error}</p>}
    {!error && saved && <p className="settings-copy">已保存。新的英文描述会在下次分析时编码，首次可能需要几秒。</p>}
  </section>;
}

