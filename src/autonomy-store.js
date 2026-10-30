import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { InterestMemory } from './interests.js';

// 机器人的公开浏览经历与主动消息账本。与用户私人记忆分库，不迁移/覆盖记忆库。
export class AutonomyStore {
  constructor(file, appId) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.appId = appId; this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) { this.db.close(); throw new Error('自主活动数据库版本过新。'); }
    this.db.exec(`CREATE TABLE IF NOT EXISTS flags (app TEXT, name TEXT, value TEXT, PRIMARY KEY(app,name));
      CREATE TABLE IF NOT EXISTS peers (app TEXT, scope TEXT, target TEXT, last_at INTEGER NOT NULL DEFAULT 0,
        blocked TEXT NOT NULL DEFAULT '', PRIMARY KEY(app,scope,target));
      CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, app TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
        day TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
        topic TEXT NOT NULL DEFAULT '', bvid TEXT NOT NULL DEFAULT '', code TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS attempts_target ON attempts(app,kind,target,at DESC);
      CREATE TABLE IF NOT EXISTS videos (app TEXT, bvid TEXT, at INTEGER NOT NULL, state TEXT NOT NULL,
        PRIMARY KEY(app,bvid));
      CREATE TABLE IF NOT EXISTS experiences (id INTEGER PRIMARY KEY, app TEXT NOT NULL, bvid TEXT NOT NULL,
        title TEXT NOT NULL, summary TEXT NOT NULL, reaction TEXT NOT NULL, shareworthy INTEGER NOT NULL,
        evidence TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE(app,bvid));
      `);
    this.interests = new InterestMemory(this, file, version);
  }
  flag(name, fallback) {
    const row = this.db.prepare('SELECT value FROM flags WHERE app=? AND name=?').get(this.appId, name);
    return row ? row.value === 'true' : fallback;
  }
  setFlag(name, value) { this.db.prepare('INSERT INTO flags VALUES(?,?,?) ON CONFLICT(app,name) DO UPDATE SET value=excluded.value').run(this.appId, name, String(value)); }
  touch(scope, target, at) {
    this.db.prepare('INSERT INTO peers(app,scope,target,last_at) VALUES(?,?,?,?) ON CONFLICT(app,scope,target) DO UPDATE SET last_at=max(last_at,excluded.last_at)').run(this.appId, scope, target, at);
  }
  peer(scope, target) { return this.db.prepare('SELECT last_at,blocked FROM peers WHERE app=? AND scope=? AND target=?').get(this.appId, scope, target) ?? { last_at: 0, blocked: '' }; }
  block(scope, target, reason) {
    this.touch(scope, target, 0);
    this.db.prepare('UPDATE peers SET blocked=? WHERE app=? AND scope=? AND target=?').run(reason, this.appId, scope, target);
  }
  count(kind, target, day) { return this.db.prepare('SELECT count(*) AS n FROM attempts WHERE app=? AND kind=? AND target=? AND day=?').get(this.appId, kind, target, day).n; }
  latest(kind, target) { return this.db.prepare('SELECT * FROM attempts WHERE app=? AND kind=? AND target=? ORDER BY id DESC LIMIT 1').get(this.appId, kind, target); }
  reserve(kind, target, day, at, daily, intervalMs) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const previous = this.latest(kind, target);
      if (this.count(kind, target, day) >= daily || (previous && at - previous.at < intervalMs)) { this.db.exec('ROLLBACK;'); return null; }
      const result = this.db.prepare("INSERT INTO attempts(app,kind,target,day,at,state) VALUES(?,?,?,?,?,'reserved')").run(this.appId, kind, target, day, at);
      this.db.exec('COMMIT;'); return Number(result.lastInsertRowid);
    } catch (error) { this.db.exec('ROLLBACK;'); throw error; }
  }
  finish(id, state, { text = '', topic = '', bvid = '', code = '' } = {}) {
    this.db.prepare('UPDATE attempts SET state=?,text=?,topic=?,bvid=?,code=? WHERE app=? AND id=?').run(state, text, topic, bvid, code, this.appId, id);
  }
  history(kind, target, count = 8) { return this.db.prepare("SELECT text,topic,bvid,at,state FROM attempts WHERE app=? AND kind=? AND target=? AND text<>'' ORDER BY id DESC LIMIT ?").all(this.appId, kind, target, count); }
  seen(bvid) { return !!this.db.prepare('SELECT 1 FROM videos WHERE app=? AND bvid=?').get(this.appId, bvid); }
  claimVideo(bvid, at) { return this.db.prepare("INSERT OR IGNORE INTO videos VALUES(?,?,?,'reserved')").run(this.appId, bvid, at).changes > 0; }
  saveExperience(video, analysis, evidence, at, interestEpoch = this.interests.epoch()) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
    this.db.prepare('INSERT INTO experiences(app,bvid,title,summary,reaction,shareworthy,evidence,at) VALUES(?,?,?,?,?,?,?,?)')
      .run(this.appId, video.bvid, video.title.slice(0, 300), analysis.summary, analysis.reaction, Number(analysis.shareworthy), JSON.stringify(evidence), at);
    this.db.prepare("UPDATE videos SET state='viewed' WHERE app=? AND bvid=?").run(this.appId, video.bvid);
    this.reviewExperience(video,analysis,evidence,at,interestEpoch);
    this.db.exec('COMMIT;');
    } catch(error) {this.db.exec('ROLLBACK;');throw error;}
  }
  experiences(count = 4) { return this.db.prepare('SELECT bvid,title,summary,reaction,shareworthy,at FROM experiences WHERE app=? ORDER BY id DESC LIMIT ?').all(this.appId, count); }
  pendingReviews(count = 2) {
    return this.db.prepare(`SELECT bvid,title,evidence,at FROM experiences e WHERE app=?
      AND NOT EXISTS(SELECT 1 FROM flags f WHERE f.app=e.app AND f.name='reflection:'||e.bvid AND f.value IN ('saved','empty','cleared'))
      AND NOT EXISTS(SELECT 1 FROM reflections r WHERE r.app=e.app AND r.bvid=e.bvid)
      ORDER BY at DESC LIMIT ?`).all(this.appId,count).map(r=>({...r,evidence:JSON.parse(r.evidence)}));
  }
  reviewExperience(video,analysis,evidence,at,epoch) {
    if (epoch!==this.interests.epoch()) return false;
    const saved=this.interests.apply(video,analysis.reflections,evidence,at,epoch);
    this.setFlag(`reflection:${video.bvid}`,saved?'saved':analysis.reflectionStatus==='empty'?'empty':'failed');
    return saved;
  }
  shareable(kind, target, now) {
    return this.db.prepare(`SELECT bvid,title,summary,reaction,at FROM experiences e WHERE app=? AND shareworthy=1 AND at>=?
      AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.app=e.app AND a.kind=? AND a.target=? AND a.bvid=e.bvid AND a.state IN ('sent','sending','uncertain'))
      ORDER BY id DESC LIMIT 1`).get(this.appId, now - 48 * 3600000, kind, target);
  }
  close() { this.db.close(); }
}
