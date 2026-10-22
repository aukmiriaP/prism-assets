import { useState, type SetStateAction } from 'react';
import type { Asset, SearchStrategy } from './types';

export type BrowseView = {
  scope: string; activeTag: string; draft: string;
  query: { text?: string; image_path?: string; asset_id?: string; label?: string; strategy?: SearchStrategy };
  filters: { name: string; ext: string; min_width: number; sort: string };
  filtersOpen: boolean; selected: Asset | null; modelGroup: Asset | null;
  flatTextures: boolean; resourceRelation: string; limit: number; scrollTop: number;
};

const initialView: BrowseView = {
  scope: 'all', activeTag: '', draft: '', query: {},
  filters: { name: '', ext: '', min_width: 0, sort: 'newest' }, filtersOpen: false,
  selected: null, modelGroup: null, flatTextures: false, resourceRelation: '', limit: 200, scrollTop: 0,
};

// Metadata refreshes and edits update the current entry. Explicit browsing adds a new entry.
const destination = (view: BrowseView) => JSON.stringify([
  view.scope, view.activeTag, view.query, view.modelGroup?.id, view.flatTextures, view.selected?.id,
]);

export const listLocation = (view: BrowseView) => JSON.stringify([
  view.scope, view.activeTag, view.query, view.modelGroup?.id, view.flatTextures,
  view.resourceRelation, view.filters, view.limit,
]);

export function useNavigation() {
  const [history, setHistory] = useState({ entries: [initialView], index: 0 });
  const view = history.entries[history.index];

  function update<K extends keyof BrowseView>(key: K, value: SetStateAction<BrowseView[K]>) {
    setHistory(old => {
      const current = old.entries[old.index];
      const nextValue = typeof value === 'function'
        ? (value as (previous: BrowseView[K]) => BrowseView[K])(current[key]) : value;
      if (Object.is(current[key], nextValue)) return old;
      const entries = [...old.entries];
      entries[old.index] = { ...current, [key]: nextValue };
      return { ...old, entries };
    });
  }

  function navigate(changes: Partial<BrowseView>, scrollTop: number, keepScroll = false) {
    setHistory(old => {
      const current = { ...old.entries[old.index], scrollTop };
      const next = { ...current, ...changes, scrollTop: keepScroll ? scrollTop : 0 };
      const entries = [...old.entries.slice(0, old.index), current];
      if (destination(current) === destination(next)) {
        entries[old.index] = next;
        return { ...old, entries: [...entries, ...old.entries.slice(old.index + 1)] };
      }
      entries.push(next);
      const bounded = entries.slice(-100);
      return { entries: bounded, index: bounded.length - 1 };
    });
  }

  function go(delta: number, scrollTop: number) {
    setHistory(old => {
      const index = old.index + delta;
      if (index < 0 || index >= old.entries.length) return old;
      const entries = [...old.entries];
      entries[old.index] = { ...entries[old.index], scrollTop };
      return { entries, index };
    });
  }

  return { view, update, navigate, go, index: history.index, entries: history.entries,
    canBack: history.index > 0, canForward: history.index < history.entries.length - 1 };
}
