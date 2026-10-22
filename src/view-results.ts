import type { Result } from './types';

type CacheState = {
  epoch: string;
  ready: Map<string, Result>;
  pending: Map<string, Promise<Result>>;
};

/** Window-local list results; invalidate on library changes, never cache search encodings. */
export class ViewResults {
  private state: CacheState | null = null;
  constructor(private capacity = 12) {}

  clear() { this.state = null; }

  private current(epoch: string) {
    if (!this.state || this.state.epoch !== epoch) {
      this.state = { epoch, ready: new Map(), pending: new Map() };
    }
    return this.state;
  }

  peek(epoch: string, key: string) {
    const cache = this.current(epoch);
    const result = cache.ready.get(key);
    if (result) {
      cache.ready.delete(key);
      cache.ready.set(key, result);
    }
    return result;
  }

  load(epoch: string, key: string, fetch: () => Promise<Result>) {
    const cached = this.peek(epoch, key);
    if (cached) return Promise.resolve(cached);
    const cache = this.current(epoch);
    const pending = cache.pending.get(key);
    if (pending) return pending;
    const request = fetch().then(result => {
      if (this.state === cache) {
        cache.ready.set(key, result);
        while (cache.ready.size > this.capacity) {
          const oldest = cache.ready.keys().next().value;
          if (oldest !== undefined) cache.ready.delete(oldest);
        }
      }
      return result;
    }).finally(() => cache.pending.delete(key));
    cache.pending.set(key, request);
    return request;
  }
}
