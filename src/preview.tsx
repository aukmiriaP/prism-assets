import { useSyncExternalStore, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { X } from 'lucide-react';
import { LibraryState } from './library-state';
import { getPreviewPreferences, setPreviewPreferences, subscribePreviewPreferences } from './preview-stage';
import './preview.css';

export function PreviewDialog({ label, title, subtitle, icon, closeLabel, close, className, children }: {
  label: string; title: string; subtitle: string; icon: ReactNode; closeLabel: string;
  close(): void; className: string; children: ReactNode;
}) {
  return <div className="preview-overlay" role="dialog" aria-modal="true" aria-label={label}>
    <section className={`preview-dialog ${className}`}>
      <header>{icon}<div><strong title={title}>{title}</strong><span title={subtitle}>{subtitle}</span></div>
        <button title={closeLabel} onClick={close}><X size={21}/></button></header>
      {children}
    </section>
  </div>;
}

export function PreviewLoading({ loading, title, description, className }: {
  loading: boolean; title: string; description?: string; className: string;
}) {
  return <div className={`preview-loading ${className}`}>
    <LibraryState loading={loading} title={title} description={description}/>
  </div>;
}

export function PreviewCanvas({ mount, className, children, ...props }: HTMLAttributes<HTMLDivElement> & {
  mount: Ref<HTMLDivElement>;
}) {
  return <div className={`preview-canvas ${className || ''}`} {...props}>
    {/* Keep Three.js's DOM separate from React's loading/label reconciliation. */}
    <div className="preview-surface" ref={mount}/>
    {children}
  </div>;
}

export function PreviewEnvironment() {
  const settings = useSyncExternalStore(subscribePreviewPreferences, getPreviewPreferences);
  return <div className="preview-environment">
    <label><input type="checkbox" checked={settings.grid} onChange={e => setPreviewPreferences({ grid: e.target.checked })}/>地面网格</label>
    <label><input type="checkbox" checked={settings.shadows} onChange={e => setPreviewPreferences({ shadows: e.target.checked })}/>地面阴影</label>
  </div>;
}
