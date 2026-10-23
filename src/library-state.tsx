import type { ReactNode } from 'react';
import './library-state.css';

/** One quiet motif for empty libraries, empty results and work in progress. */
export function LibraryState({ title, description, loading = false, className = '', children }: {
  title: string; description?: string; loading?: boolean; className?: string; children?: ReactNode;
}) {
  return <section className={`library-state ${className}`} role={loading ? 'status' : undefined}
    aria-live={loading ? 'polite' : undefined} aria-atomic={loading ? true : undefined}>
    <svg className={`state-symbol${loading ? ' is-loading' : ''}`} width="56" height="56" viewBox="0 0 56 56"
      fill="none" aria-hidden="true">
      <rect x="8" y="8" width="17" height="17" rx="3"/>
      <rect x="31" y="8" width="17" height="17" rx="3"/>
      <rect x="31" y="31" width="17" height="17" rx="3"/>
      <rect x="8" y="31" width="17" height="17" rx="3"/>
    </svg>
    <h2>{title}</h2>
    {description && <p>{description}</p>}
    {children && <div className="state-actions">{children}</div>}
  </section>;
}
