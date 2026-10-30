import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { partition, eventKey } from './identity.js';
import { initialBiology, advanceBiology, updateBiology } from './biology.js';
import { ContinuityMemory } from './continuity.js';

export class MemoryStore {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 5) { this.db.close(); throw new Error('数据库版本比插件新；请恢复匹配版本，未修改数据。'); }
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
    if (version < 3) {
      if (version > 0 && file !== ':memory:') this.db.exec(`VACUUM INTO '${String(file + '.before-v3-' + Date.now()).replaceAll("'", "''")}'`);
      this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE profiles ADD COLUMN followups INTEGER NOT NULL DEFAULT 1;
        CREATE TABLE episodes (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, source_event TEXT NOT NULL,
          text TEXT NOT NULL, evidence TEXT NOT NULL, due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          audience TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', asked_at INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(owner,source_event));
        CREATE INDEX episodes_owner ON episodes(owner,status,due_at);
        CREATE TABLE semantic_vectors (owner TEXT NOT NULL, memory_id TEXT NOT NULL, source_hash TEXT NOT NULL,
          model TEXT NOT NULL, vectors TEXT NOT NULL, PRIMARY KEY(owner,memory_id,model));
        PRAGMA user_version=3; COMMIT;`);
    }
    if (version < 4) {
      if (version > 0 && file !== ':memory:') this.db.exec(`VACUUM INTO '${String(file + '.before-v4-' + Date.now()).replaceAll("'", "''")}'`);
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE biology (owner TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL);
        CREATE TABLE biology_events (event_key TEXT PRIMARY KEY, owner TEXT NOT NULL, at INTEGER NOT NULL,
          kind TEXT NOT NULL, evidence TEXT NOT NULL, hash TEXT NOT NULL, applied INTEGER NOT NULL);
        CREATE INDEX biology_events_owner ON biology_events(owner,at);
        PRAGMA user_version=4; COMMIT;`);
    }
    this.life = new ContinuityMemory(this, file, version > 0);
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
    rows.push(...this.db.prepare("SELECT 'E'||id AS id,text,created_at,status FROM episodes WHERE owner=? ORDER BY updated_at DESC LIMIT 200").all(partition(e)));
    rows.push(...this.life.rows(e, 200));
    // 向量不可用时使用有界中文片段匹配。
    const compact = query.replace(/\s/gu, '');
    const terms = [...new Set(Array.from(compact).slice(0, 100).flatMap((_, i) => compact.slice(i, i + 2).length === 2 ? [compact.slice(i, i + 2)] : []))];
    return rows.map(row => ({ ...row, score: terms.reduce((n, term) => n + Number(row.text.includes(term)), 0) }))
      .sort((a, b) => b.score - a.score || b.created_at - a.created_at || String(b.id).localeCompare(String(a.id))).slice(0, limit);
  }
  memoryRows(e) {
    const owner = partition(e);
    return [...this.db.prepare("SELECT 'M'||id AS id,text,created_at FROM memories WHERE owner=? ORDER BY created_at,id").all(owner),
      ...this.db.prepare("SELECT 'F'||id AS id,value AS text,updated_at AS created_at,slot FROM facts WHERE owner=? ORDER BY updated_at,id").all(owner),
      ...this.db.prepare("SELECT 'E'||id AS id,text,created_at,status FROM episodes WHERE owner=? ORDER BY created_at,id").all(owner), ...this.life.rows(e)];
  }
  memoryOwners() { return this.db.prepare('SELECT owner FROM memories UNION SELECT owner FROM facts UNION SELECT owner FROM episodes UNION SELECT owner FROM stories').all().map(r => JSON.parse(r.owner)); }
  vectorRows(e, model) { return this.db.prepare('SELECT * FROM semantic_vectors WHERE owner=? AND model=?').all(partition(e), model); }
  saveVector(e, row, hash, model, vectors, epoch) {
    if (this.profile(e).epoch !== epoch || !this.memoryRows(e).some(r => r.id === row.id && r.text === row.text && r.status === row.status)) return false;
    this.db.prepare(`INSERT INTO semantic_vectors VALUES(?,?,?,?,?) ON CONFLICT(owner,memory_id,model)
      DO UPDATE SET source_hash=excluded.source_hash,vectors=excluded.vectors`).run(partition(e), row.id, hash, model, JSON.stringify(vectors)); return true;
  }
  profile(e) {
    this.db.prepare('INSERT OR IGNORE INTO profiles(owner) VALUES(?)').run(partition(e));
    return this.db.prepare('SELECT * FROM profiles WHERE owner=?').get(partition(e));
  }
  biologyEnabled(e) { return this.db.prepare('SELECT enabled FROM biology WHERE owner=?').get(partition(e))?.enabled !== 0; }
  biologySnapshot(e, now = Date.now()) {
    const stored = this.db.prepare('SELECT state FROM biology WHERE owner=?').get(partition(e));
    return advanceBiology(stored ? JSON.parse(stored.state) : initialBiology(this.profile(e), now), now);
  }
  biologyHistory(e) { return this.db.prepare('SELECT kind,at,applied FROM biology_events WHERE owner=? ORDER BY at DESC LIMIT 5').all(partition(e)); }
  setBiology(e, enabled) {
    const state = this.biologySnapshot(e, e.receivedAt);
    this.db.prepare('INSERT INTO biology VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET enabled=excluded.enabled').run(partition(e), Number(enabled), JSON.stringify(state));
    this.resetContext(e);
  }
  resetBiology(e) {
    const enabled = this.biologyEnabled(e);
    this.db.prepare('DELETE FROM biology_events WHERE owner=?').run(partition(e));
    this.db.prepare('INSERT INTO biology VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET state=excluded.state').run(partition(e), Number(enabled), JSON.stringify(initialBiology({}, e.receivedAt)));
    this.profile(e); this.db.prepare('UPDATE profiles SET familiarity=0,mood=0,epoch=epoch+1 WHERE owner=?').run(partition(e));
  }
  applyAppraisal(e, appraisal, epoch, options = {}) {
    const p = this.profile(e); const owner = partition(e);
    if (!p.auto_memory || p.epoch !== epoch || !this.biologyEnabled(e)) return false;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      if (this.db.prepare('SELECT 1 FROM biology_events WHERE event_key=?').get(eventKey(e))) { this.db.exec('ROLLBACK;'); return false; }
      const row = this.db.prepare('SELECT state FROM biology WHERE owner=?').get(owner);
      const previous = row ? JSON.parse(row.state) : initialBiology(p, e.receivedAt);
      const repeated = !!this.db.prepare('SELECT 1 FROM biology_events WHERE owner=? AND hash=? AND at>?').get(owner, appraisal.hash, e.receivedAt - 86400000);
      const result = updateBiology(previous, appraisal, e.receivedAt, { ...options, repeated });
      this.db.prepare('INSERT INTO biology VALUES(?,1,?) ON CONFLICT(owner) DO UPDATE SET state=excluded.state').run(owner, JSON.stringify(result.state));
      this.db.prepare('INSERT INTO biology_events VALUES(?,?,?,?,?,?,?)').run(eventKey(e), owner, e.receivedAt, appraisal.kind, appraisal.evidence, appraisal.hash, Number(result.applied));
      this.db.prepare('UPDATE profiles SET familiarity=?,mood=? WHERE owner=?').run(result.state.familiarity * 100, result.state.valence, owner);
      this.db.prepare('DELETE FROM biology_events WHERE owner=? AND (at<? OR event_key NOT IN (SELECT event_key FROM biology_events WHERE owner=? ORDER BY at DESC LIMIT 500))').run(owner, e.receivedAt - 90 * 86400000, owner);
      this.db.exec('COMMIT;'); return true;
    } catch (error) { this.db.exec('ROLLBACK;'); throw error; }
  }
  setAutoMemory(e, enabled) { this.profile(e); this.db.prepare('UPDATE profiles SET auto_memory=?,epoch=epoch+1 WHERE owner=?').run(Number(enabled), partition(e)); }
  resetContext(e) { this.profile(e); this.db.prepare('UPDATE profiles SET epoch=epoch+1 WHERE owner=?').run(partition(e)); }
  forget(e) {
    const owner = partition(e); this.profile(e);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      let count = 0;
      for (const table of ['memories', 'facts', 'fact_history', 'episodes', 'semantic_vectors', 'biology_events', 'stories', 'story_steps', 'fact_observations']) count += this.db.prepare(`DELETE FROM ${table} WHERE owner=?`).run(owner).changes;
      this.db.prepare('UPDATE biology SET state=? WHERE owner=?').run(JSON.stringify(initialBiology({}, e.receivedAt)), owner);
      this.db.prepare("UPDATE profiles SET summary='',familiarity=0,mood=0,interactions=0,last_at=0,last_growth=0,epoch=epoch+1 WHERE owner=?").run(owner);
      this.db.exec('COMMIT;'); return count;
    } catch (error) { this.db.exec('ROLLBACK;'); throw error; }
  }
  editMemory(e, id, replacement) {
    if (/^S\d+$/u.test(id)) {
      if (replacement !== undefined && (!replacement.trim() || replacement.length > 2000)) throw new Error('记忆内容应为 1～2000 字。');
      if (!this.life.editStory(e, id, replacement)) return false;
      this.profile(e); this.db.prepare("UPDATE profiles SET summary='',epoch=epoch+1 WHERE owner=?").run(partition(e)); return true;
    }
    const match = /^([MFE])(\d+)$/u.exec(id); if (!match) return false;
    const table = match[1] === 'F' ? 'facts' : match[1] === 'E' ? 'episodes' : 'memories';
    const owner = partition(e); const row = this.db.prepare(`SELECT * FROM ${table} WHERE owner=? AND id=?`).get(owner, Number(match[2]));
    if (!row) return false;
    if (replacement !== undefined && (!replacement.trim() || replacement.length > 2000)) throw new Error('记忆内容应为 1～2000 字。');
    if (replacement === undefined) this.db.prepare(`DELETE FROM ${table} WHERE owner=? AND id=?`).run(owner, row.id);
    else if (table === 'facts') this.db.prepare('UPDATE facts SET value=?,evidence=?,confidence=1,source_event=?,updated_at=? WHERE owner=? AND id=?').run(replacement, replacement, eventKey(e), e.receivedAt, owner, row.id);
    else if (table === 'episodes') this.db.prepare("UPDATE episodes SET text=?,evidence=?,status='closed',updated_at=? WHERE owner=? AND id=?").run(replacement, replacement, e.receivedAt, owner, row.id);
    else this.db.prepare('UPDATE memories SET text=? WHERE owner=? AND id=?').run(replacement, owner, row.id);
    this.db.prepare('DELETE FROM semantic_vectors WHERE owner=? AND memory_id=?').run(owner, id);
    if (table === 'facts') {
      this.db.prepare('DELETE FROM fact_history WHERE owner=? AND fact_id=?').run(owner, row.id);
      this.db.prepare('DELETE FROM fact_observations WHERE owner=? AND fact_id=?').run(owner, row.id);
      if (replacement !== undefined) this.life.observeFacts(e, [{slot:row.slot,value:replacement,evidence:replacement}]);
    }
    if (table === 'episodes') {
      const story = this.life.list(e, -1).find(s=>s.plan_id===id);
      if (story) { if (replacement === undefined) this.life.removeStory(e, story.id, false); else this.life.editStory(e, story.id, replacement); }
    }
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
        if (old) this.db.prepare('DELETE FROM semantic_vectors WHERE owner=? AND memory_id=?').run(owner, `F${old.id}`);
        if (old && old.value !== fact.value) this.db.prepare('INSERT INTO fact_history VALUES(?,?,?,?)').run(owner, old.id, old.value, e.receivedAt);
        this.db.prepare(`INSERT INTO facts(owner,slot,value,evidence,confidence,source_event,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(owner,slot) DO UPDATE SET value=excluded.value,evidence=excluded.evidence,confidence=excluded.confidence,source_event=excluded.source_event,updated_at=excluded.updated_at`)
          .run(owner, fact.slot, fact.value, fact.evidence, fact.confidence, eventKey(e), e.receivedAt, e.receivedAt);
      }
      this.life.observeFacts(e, analysis.facts);
      for (const resolution of analysis.resolutions ?? []) {
        this.closeFollowup(e, resolution.id, resolution.status);
        const story = this.life.list(e, -1).find(s=>s.plan_id===resolution.id);
        if (story && resolution.status === 'resolved') this.life.apply(e,[{id:story.id,stage:'completed',text:resolution.evidence,evidence:resolution.evidence}]);
      }
      for (const plan of analysis.followups ?? []) {
        this.saveFollowup(e, plan, epoch);
      }
      this.life.apply(e, analysis.stories);
      const summary = analysis.summary || current.summary;
      this.db.prepare('UPDATE profiles SET summary=?,interactions=interactions+1,last_at=? WHERE owner=?')
        .run(summary, Math.max(current.last_at, e.receivedAt), owner);
      this.db.exec('COMMIT;'); return true;
    } catch (error) { this.db.exec('ROLLBACK;'); throw error; }
  }
  setFollowups(e, enabled) { this.profile(e); this.db.prepare('UPDATE profiles SET followups=?,epoch=epoch+1 WHERE owner=?').run(Number(enabled), partition(e)); }
  saveFollowup(e, plan, epoch) {
    const p = this.profile(e); const owner = partition(e);
    if (!p.auto_memory || !p.followups || p.epoch !== epoch || this.db.prepare("SELECT 1 FROM episodes WHERE owner=? AND text=? AND status='open'").get(owner, plan.text)) return false;
    const added = this.db.prepare(`INSERT OR IGNORE INTO episodes(owner,source_event,text,evidence,due_at,expires_at,audience,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(owner, eventKey(e), plan.text, plan.evidence, plan.dueAt, plan.expiresAt, plan.audience, e.receivedAt, e.receivedAt);
    if (added.changes) this.life.seedPlan(e, `E${added.lastInsertRowid}`, plan);
    return added.changes > 0;
  }
  groupPlans(appId, targetId) {
    return this.db.prepare("SELECT 'E'||id AS id,owner,text FROM episodes WHERE json_extract(owner,'$[0]')=? AND json_extract(owner,'$[1]')='group' AND json_extract(owner,'$[2]')=? AND audience='group' AND status='open' ORDER BY id DESC LIMIT 20").all(appId, targetId);
  }
  plans(e) { return this.db.prepare("SELECT 'E'||id AS id,text,evidence,due_at,expires_at,status,asked_at,audience,created_at FROM episodes WHERE owner=? ORDER BY updated_at DESC LIMIT 20").all(partition(e)); }
  closeFollowup(e, id, status = 'closed') {
    if (!/^E\d+$/u.test(id) || !['closed', 'resolved'].includes(status)) return false;
    this.db.prepare('DELETE FROM semantic_vectors WHERE owner=? AND memory_id=?').run(partition(e), id);
    return this.db.prepare('UPDATE episodes SET status=?,updated_at=? WHERE owner=? AND id=?').run(status, e.receivedAt ?? Date.now(), partition(e), Number(id.slice(1))).changes > 0;
  }
  dueFollowup(e, now, groupPublic = false) {
    const p = this.profile(e); if (!p.followups || !p.auto_memory) return undefined;
    if (this.db.prepare('SELECT 1 FROM episodes WHERE owner=? AND asked_at>?').get(partition(e), now - 86400000)) return undefined;
    return this.db.prepare(`SELECT 'E'||id AS id,text,evidence,due_at,created_at FROM episodes WHERE owner=? AND status='open' AND asked_at=0 AND due_at<=? AND expires_at>?
      ${groupPublic ? "AND audience='group'" : ''} ORDER BY due_at LIMIT 1`).get(partition(e), now, now);
  }
  claimFollowup(e, id, now, groupPublic = false) {
    const candidate = this.dueFollowup(e, now, groupPublic);
    if (candidate?.id !== id) return false;
    return this.db.prepare("UPDATE episodes SET asked_at=? WHERE owner=? AND id=? AND asked_at=0 AND status='open'").run(now, partition(e), Number(id.slice(1))).changes > 0;
  }
  dueGroupFollowup(appId, targetId, now) {
    const owners = this.db.prepare("SELECT DISTINCT owner FROM episodes WHERE json_extract(owner,'$[0]')=? AND json_extract(owner,'$[1]')='group' AND json_extract(owner,'$[2]')=?").all(appId, targetId);
    for (const { owner } of owners) if (this.db.prepare('SELECT 1 FROM episodes WHERE owner=? AND asked_at>?').get(owner, now - 86400000)) return undefined;
    for (const { owner } of owners) {
      const [appId, scope, targetId, senderId] = JSON.parse(owner); const e = { appId, scope, targetId, senderId };
      const plan = this.dueFollowup(e, now, true); if (plan) return { ...plan, owner: e };
    }
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
