import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { partition, eventKey } from './identity.js';

export class MemoryStore {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) { this.db.close(); throw new Error('数据库版本比插件新；请恢复匹配版本，未修改数据。'); }
    if (version === 0) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY, owner TEXT NOT NULL, source_event TEXT NOT NULL,
        text TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(owner, source_event)
      );
      CREATE INDEX memories_owner ON memories(owner, created_at DESC);
      CREATE TABLE inbound (event_key TEXT PRIMARY KEY, state TEXT NOT NULL, received_at INTEGER NOT NULL);
      CREATE TABLE replies (event_key TEXT PRIMARY KEY, used INTEGER NOT NULL, received_at INTEGER NOT NULL);
      CREATE TABLE capabilities (scope TEXT NOT NULL, capability TEXT NOT NULL,
        status TEXT NOT NULL, observed_at INTEGER NOT NULL, PRIMARY KEY(scope, capability));
      PRAGMA user_version=1;
      COMMIT;
    `);
    this.db.exec('PRAGMA journal_mode=WAL;');
    if (version < 2) {
      if (version === 1 && file !== ':memory:') this.db.exec(`VACUUM INTO '${String(file + '.before-v2-' + Date.now()).replaceAll("'", "''")}'`);
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE facts (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, slot TEXT NOT NULL, value TEXT NOT NULL,
          evidence TEXT NOT NULL, confidence REAL NOT NULL, source_event TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(owner,slot));
        CREATE TABLE fact_history (owner TEXT NOT NULL, fact_id INTEGER NOT NULL, value TEXT NOT NULL, replaced_at INTEGER NOT NULL);
        CREATE TABLE profiles (owner TEXT PRIMARY KEY, auto_memory INTEGER NOT NULL DEFAULT 1, epoch INTEGER NOT NULL DEFAULT 0,
          summary TEXT NOT NULL DEFAULT '', familiarity REAL NOT NULL DEFAULT 0, mood REAL NOT NULL DEFAULT 0,
          interactions INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL DEFAULT 0, last_growth INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE analyzed (event_key TEXT PRIMARY KEY);
        PRAGMA user_version=2; COMMIT;`);
    }
  }
  claim(e) {
    return this.db.prepare('INSERT OR IGNORE INTO inbound VALUES (?, ?, ?)')
      .run(eventKey(e), 'processing', e.receivedAt).changes > 0;
  }
  finish(e, state = 'handled') {
    this.db.prepare('UPDATE inbound SET state=? WHERE event_key=?').run(state, eventKey(e));
  }
  remember(e, text) {
    const normalized = String(text).trim();
    if (!normalized || normalized.length > 2000) throw new Error('记忆内容应为 1～2000 字。');
    this.db.prepare('INSERT OR IGNORE INTO memories(owner,source_event,text,created_at) VALUES (?,?,?,?)')
      .run(partition(e), eventKey(e), normalized, e.receivedAt);
  }
  recall(e, query = '', limit = 6) {
    const rows = this.db.prepare("SELECT 'M'||id AS id,text,created_at FROM memories WHERE owner=? ORDER BY created_at DESC,id DESC LIMIT 200")
      .all(partition(e));
    rows.push(...this.db.prepare("SELECT 'F'||id AS id,value AS text,updated_at AS created_at,slot,confidence FROM facts WHERE owner=? ORDER BY updated_at DESC LIMIT 200").all(partition(e)));
    // P0 有界中文片段匹配，后续用中文全文/向量检索替换。
    const compact = query.replace(/\s/gu, '');
    const terms = [...new Set(Array.from(compact).slice(0, 100).flatMap((_, i) => compact.slice(i, i + 2).length === 2 ? [compact.slice(i, i + 2)] : []))];
    return rows.map(row => ({ ...row, score: terms.reduce((n, term) => n + Number(row.text.includes(term)), 0) }))
      .sort((a, b) => b.score - a.score || b.created_at - a.created_at || String(b.id).localeCompare(String(a.id))).slice(0, limit);
  }
  profile(e) {
    this.db.prepare('INSERT OR IGNORE INTO profiles(owner) VALUES(?)').run(partition(e));
    return this.db.prepare('SELECT * FROM profiles WHERE owner=?').get(partition(e));
  }
  setAutoMemory(e, enabled) { this.profile(e); this.db.prepare('UPDATE profiles SET auto_memory=?,epoch=epoch+1 WHERE owner=?').run(Number(enabled), partition(e)); }
  resetContext(e) { this.profile(e); this.db.prepare('UPDATE profiles SET epoch=epoch+1 WHERE owner=?').run(partition(e)); }
  forget(e) {
    const owner = partition(e); this.profile(e);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      let count = 0;
      for (const table of ['memories', 'facts', 'fact_history']) count += this.db.prepare(`DELETE FROM ${table} WHERE owner=?`).run(owner).changes;
      this.db.prepare("UPDATE profiles SET summary='',familiarity=0,mood=0,interactions=0,last_at=0,last_growth=0,epoch=epoch+1 WHERE owner=?").run(owner);
      this.db.exec('COMMIT;'); return count;
    } catch (error) { this.db.exec('ROLLBACK;'); throw error; }
  }
  editMemory(e, id, replacement) {
    const match = /^([MF])(\d+)$/u.exec(id); if (!match) return false;
    const table = match[1] === 'F' ? 'facts' : 'memories'; const field = table === 'facts' ? 'value' : 'text';
    const owner = partition(e); const row = this.db.prepare(`SELECT * FROM ${table} WHERE owner=? AND id=?`).get(owner, Number(match[2]));
    if (!row) return false;
    if (replacement !== undefined && (!replacement.trim() || replacement.length > 2000)) throw new Error('记忆内容应为 1～2000 字。');
    if (replacement === undefined) this.db.prepare(`DELETE FROM ${table} WHERE owner=? AND id=?`).run(owner, row.id);
    else if (table === 'facts') this.db.prepare('UPDATE facts SET value=?,evidence=?,confidence=1,source_event=?,updated_at=? WHERE owner=? AND id=?').run(replacement, replacement, eventKey(e), e.receivedAt, owner, row.id);
    else this.db.prepare('UPDATE memories SET text=? WHERE owner=? AND id=?').run(replacement, owner, row.id);
    if (table === 'facts') this.db.prepare('DELETE FROM fact_history WHERE owner=? AND fact_id=?').run(owner, row.id);
    this.profile(e); this.db.prepare("UPDATE profiles SET summary='',epoch=epoch+1 WHERE owner=?").run(owner);
    return true;
  }
  applyAnalysis(e, analysis, epoch) {
    const owner = partition(e); const current = this.profile(e);
    if (!current.auto_memory || current.epoch !== epoch) return false;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      if (!this.db.prepare('INSERT OR IGNORE INTO analyzed VALUES(?)').run(eventKey(e)).changes) { this.db.exec('ROLLBACK;'); return false; }
      for (const fact of analysis.facts) {
        const old = this.db.prepare('SELECT * FROM facts WHERE owner=? AND slot=?').get(owner, fact.slot);
        if (old && old.value !== fact.value) this.db.prepare('INSERT INTO fact_history VALUES(?,?,?,?)').run(owner, old.id, old.value, e.receivedAt);
        this.db.prepare(`INSERT INTO facts(owner,slot,value,evidence,confidence,source_event,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(owner,slot) DO UPDATE SET value=excluded.value,evidence=excluded.evidence,confidence=excluded.confidence,source_event=excluded.source_event,updated_at=excluded.updated_at`)
          .run(owner, fact.slot, fact.value, fact.evidence, fact.confidence, eventKey(e), e.receivedAt, e.receivedAt);
      }
      const elapsed = Math.max(0, e.receivedAt - current.last_at);
      const neutralized = current.mood * Math.pow(0.5, elapsed / 14_400_000);
      const delta = analysis.tone === 'positive' ? 0.08 : analysis.tone === 'negative' ? -0.08 : 0;
      const mood = Math.max(-0.6, Math.min(0.6, neutralized + delta));
      const grow = e.receivedAt - current.last_growth >= 300000 || current.interactions === 0;
      const summary = analysis.summary || current.summary;
      this.db.prepare('UPDATE profiles SET summary=?,familiarity=?,mood=?,interactions=interactions+1,last_at=?,last_growth=? WHERE owner=?')
        .run(summary, Math.min(100, current.familiarity + Number(grow)), mood, Math.max(current.last_at, e.receivedAt), grow ? e.receivedAt : current.last_growth, owner);
      this.db.exec('COMMIT;'); return true;
    } catch (error) { this.db.exec('ROLLBACK;'); throw error; }
  }
  used(e) { return this.db.prepare('SELECT used FROM replies WHERE event_key=?').get(eventKey(e))?.used ?? 0; }
  reserve(e, maximum, now) {
    const window = e.scope === 'group' ? 300_000 : 3_600_000;
    if (now - e.receivedAt >= window || e.receivedAt > now) return null;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const used = this.used(e);
      if (used >= maximum) { this.db.exec('ROLLBACK;'); return null; }
      this.db.prepare(`INSERT INTO replies VALUES (?,?,?) ON CONFLICT(event_key) DO UPDATE SET used=excluded.used`)
        .run(eventKey(e), used + 1, e.receivedAt);
      this.db.exec('COMMIT;');
      return used + 1;
    } catch (error) { this.db.exec('ROLLBACK;'); throw error; }
  }
  observe(scope, capability, status, now = Date.now()) {
    this.db.prepare('INSERT INTO capabilities VALUES (?,?,?,?) ON CONFLICT(scope,capability) DO UPDATE SET status=excluded.status,observed_at=excluded.observed_at')
      .run(scope, capability, status, now);
  }
  capabilities() { return this.db.prepare('SELECT * FROM capabilities ORDER BY scope,capability').all(); }
  close() { this.db.close(); }
}
