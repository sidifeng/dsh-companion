import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { EMBEDDING_KEY } from './embedding-model.js';
export const memoryHash = row => createHash('sha256').update(JSON.stringify([row.text, row.status ?? ''])).digest('hex');
export const dot = (a, b) => a.length === b.length ? a.reduce((n, x, i) => n + x * b[i], 0) : 0;
const chunks = text => { const result = []; for (let i = 0; i < text.length; i += 224) result.push(text.slice(i, i + 256)); return result.slice(0, 10); };

export class LocalEmbedder {
  constructor(directory) { this.directory = directory; this.pending = new Map(); this.sequence = 0; this.status = 'cold'; }
  async start() {
    if (this.closed) throw Error('EMBEDDING_CLOSED');
    if (this.starting) return this.starting;
    this.status = 'loading';
    this.starting = new Promise((resolve, reject) => {
      const worker = this.worker = new Worker(new URL('./embedding-worker.js', import.meta.url), { execArgv: [], workerData: { directory: this.directory } });
      const timer = setTimeout(() => fail(), 30000);
      const fail = () => { clearTimeout(timer); this.status = 'unavailable'; reject(Error('EMBEDDING_UNAVAILABLE')); for (const entry of this.pending.values()) entry.reject(Error('EMBEDDING_UNAVAILABLE')); this.pending.clear(); void worker.terminate(); };
      worker.on('error', fail);
      worker.on('message', result => {
        if (result.ready) { clearTimeout(timer); this.status = 'ready'; worker.unref(); resolve(); return; }
        const entry = this.pending.get(result.id); if (!entry) return;
        this.pending.delete(result.id);
        if (result.error) entry.reject(Error(result.error)); else entry.resolve(result.vectors);
      });
    });
    return this.starting;
  }
  async embed(texts, signal) {
    signal?.throwIfAborted(); await this.start(); signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const finish = fn => value => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); if (!this.pending.size) this.worker?.unref(); fn(value); };
      const abort = () => entry.reject(Error('EMBEDDING_CANCELLED'));
      const timer = setTimeout(() => entry.reject(Error('EMBEDDING_TIMEOUT')), 12000);
      const entry = { resolve: finish(resolve), reject: finish(reject) };
      signal?.addEventListener('abort', abort, { once: true }); this.pending.set(id, entry);
      this.worker.ref(); this.worker.postMessage({ id, texts });
    });
  }
  async close() { this.closed = true; for (const p of this.pending.values()) p.reject(Error('EMBEDDING_CLOSED')); this.pending.clear(); await this.worker?.terminate(); }
}

export class SemanticMemory {
  constructor(store, embedder, { minSimilarity = 0.38 } = {}) { this.store = store; this.embedder = embedder; this.minSimilarity = minSimilarity; this.mode = 'local'; }
  async index(e, maximum = 32) {
    const epoch = this.store.profile(e).epoch; const rows = this.store.memoryRows(e);
    const cached = new Map(this.store.vectorRows(e, EMBEDDING_KEY).map(r => [r.memory_id, r])); let count = 0;
    for (const row of rows) {
      e.signal?.throwIfAborted(); const hash = memoryHash(row);
      if (cached.get(row.id)?.source_hash === hash) continue;
      if (count++ >= maximum) break;
      const vectors = await this.embedder.embed(chunks(row.text), e.signal); e.signal?.throwIfAborted();
      this.store.saveVector(e, row, hash, EMBEDDING_KEY, vectors, epoch);
    }
  }
  async recall(e, query = e.text, limit = 6) {
    const epoch = this.store.profile(e).epoch;
    const rows = this.store.memoryRows(e); if (!rows.length || !query.trim()) return rows.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
    try {
      await this.index(e);
      const cached = new Map(this.store.vectorRows(e, EMBEDDING_KEY).map(r => [r.memory_id, r]));
      const [q] = await this.embedder.embed([query.slice(0, 1000)], e.signal);
      if (this.store.profile(e).epoch !== epoch) return [];
      const live = new Map(this.store.memoryRows(e).map(r => [r.id, memoryHash(r)]));
      const ranked = rows.flatMap(row => {
        const entry = cached.get(row.id);
        if (!entry || entry.source_hash !== memoryHash(row) || live.get(row.id) !== entry.source_hash) return [];
        const similarity = Math.max(...JSON.parse(entry.vectors).map(v => dot(q, v)));
        const exact = query.trim().length >= 2 && (row.text.includes(query.trim()) || query.includes(row.text));
        return similarity >= this.minSimilarity || exact ? [{ ...row, score: similarity + Number(exact) * 0.2 }] : [];
      });
      this.mode = 'local'; return ranked.sort((a, b) => b.score - a.score || b.created_at - a.created_at).slice(0, limit);
    } catch (error) {
      if (e.signal?.aborted) throw error;
      this.mode = 'fallback';
      return this.store.recall(e, query, limit).filter(row => row.score > 0);
    }
  }
}
