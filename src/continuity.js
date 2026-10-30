import { partition, eventKey } from './identity.js';

export const stages = { planned: '计划中', progress: '进行中', completed: '已完成', cancelled: '已取消', reopened: '重新开始', recorded: '已记录' };
const sensitive = /(?:密码|口令|token|secret|身份证|银行卡|手机号|家庭住址|诊断|病历|自杀|自残|性侵|性骚扰)|\d{11,}/iu;
const recordedDate = new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',dateStyle:'short'});
export function validateStories(items, source, known = []) {
  if (/(?:这是测试|假设|举个例|测试一下)/u.test(source)) return [];
  return (Array.isArray(items) ? items : []).slice(0, 2).flatMap(s => {
    if (!s || !Object.hasOwn(stages, s.stage) || s.subject !== 'speaker' || !(s.confidence >= 0.9 && s.confidence <= 1)
      || typeof s.text !== 'string' || !s.text.trim() || s.text.length > 220 || typeof s.evidence !== 'string'
      || s.evidence.length < 4 || s.evidence.length > 240 || !source.includes(s.evidence) || sensitive.test(s.text + s.evidence)
      || /(?:假设|测试|举例|如果|比如|他说|她说|听说)/u.test(s.evidence)) return [];
    const existing = s.id && known.find(k => k.id === s.id);
    if (s.id && !existing) return [];
    if (!existing && (typeof s.title !== 'string' || !s.title.trim() || s.title.length > 60 || sensitive.test(s.title))) return [];
    if (s.stage === 'reopened' && !existing) return [];
    return [{ id: existing?.id, title: existing?.title ?? s.title.trim(), stage: s.stage, text: s.text.trim(), evidence: s.evidence }];
  });
}

// 与旧记忆共用事务和权限边界；画像来自明确陈述，不推断性格、疾病或私聊身份。
export class ContinuityMemory {
  constructor(store, file, existed) {
    this.store = store; this.db = store.db;
    if (this.db.prepare('PRAGMA user_version').get().user_version < 5) {
      if (existed && file !== ':memory:') this.db.exec(`VACUUM INTO '${String(file + '.before-v5-' + Date.now()).replaceAll("'", "''")}'`);
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS stories (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
          plan_id TEXT, source_event TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(owner,plan_id));
        CREATE TABLE IF NOT EXISTS story_steps (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, story_id INTEGER NOT NULL,
          source_event TEXT NOT NULL, stage TEXT NOT NULL, text TEXT NOT NULL, evidence TEXT NOT NULL, at INTEGER NOT NULL,
          UNIQUE(owner,story_id,source_event));
        CREATE INDEX IF NOT EXISTS stories_owner ON stories(owner,updated_at DESC);
        CREATE TABLE IF NOT EXISTS fact_observations (owner TEXT NOT NULL, fact_id INTEGER NOT NULL, source_event TEXT NOT NULL,
          value TEXT NOT NULL, evidence TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(owner,fact_id,source_event));
        INSERT OR IGNORE INTO fact_observations SELECT owner,id,source_event,value,evidence,updated_at FROM facts;
        INSERT OR IGNORE INTO stories(owner,title,status,plan_id,source_event,created_at,updated_at)
          SELECT owner,substr(text,1,60),CASE WHEN status='open' THEN 'planned' ELSE 'recorded' END,'E'||id,source_event,created_at,created_at FROM episodes;
        INSERT OR IGNORE INTO story_steps(owner,story_id,source_event,stage,text,evidence,at)
          SELECT s.owner,s.id,e.source_event,'planned',e.text,e.evidence,e.created_at FROM stories s JOIN episodes e ON s.owner=e.owner AND s.plan_id='E'||e.id;
        PRAGMA user_version=5; COMMIT;`);
    }
  }
  list(e, limit = 20) {
    return this.db.prepare("SELECT 'S'||id AS id,title,status,plan_id,created_at,updated_at FROM stories WHERE owner=? ORDER BY updated_at DESC,id DESC LIMIT ?").all(partition(e), limit);
  }
  detail(e, id) {
    if (!/^S\d+$/u.test(id)) return undefined;
    const story = this.db.prepare("SELECT 'S'||id AS id,title,status,plan_id,created_at,updated_at FROM stories WHERE owner=? AND id=?").get(partition(e), Number(id.slice(1)));
    if (!story) return undefined;
    const all = this.db.prepare('SELECT stage,text,evidence,at FROM story_steps WHERE owner=? AND story_id=? ORDER BY at,id').all(partition(e), Number(id.slice(1)));
    return { ...story, steps: all.length <= 12 ? all : [all[0], ...all.slice(-11)] };
  }
  rows(e, limit = -1) {
    return this.list(e, limit).map(s => { const d = this.detail(e, s.id); return { id: s.id, created_at: s.updated_at, status: s.status,
      text: `${s.title}（${stages[s.status]}）\n` + d.steps.map(x => `${recordedDate.format(x.at)}记录 ${stages[x.stage]}：${x.text}`).join('\n') }; });
  }
  seedPlan(e, id, plan) {
    const result = this.db.prepare("INSERT OR IGNORE INTO stories(owner,title,status,plan_id,source_event,created_at,updated_at) VALUES(?,?,'planned',?,?,?,?)")
      .run(partition(e), plan.text.slice(0, 60), id, eventKey(e), e.receivedAt, e.receivedAt);
    if (result.changes) this.append(e, Number(result.lastInsertRowid), { stage: 'planned', text: plan.text, evidence: plan.evidence });
  }
  append(e, id, step) {
    const owner = partition(e);
    const inserted = this.db.prepare('INSERT OR IGNORE INTO story_steps(owner,story_id,source_event,stage,text,evidence,at) VALUES(?,?,?,?,?,?,?)')
      .run(owner, id, eventKey(e), step.stage, step.text, step.evidence, e.receivedAt).changes;
    if (!inserted) return false;
    this.db.prepare('UPDATE stories SET status=?,updated_at=? WHERE owner=? AND id=?').run(step.stage === 'reopened' ? 'progress' : step.stage, e.receivedAt, owner, id);
    this.db.prepare('DELETE FROM semantic_vectors WHERE owner=? AND memory_id=?').run(owner, `S${id}`);
    this.db.prepare(`DELETE FROM story_steps WHERE owner=? AND story_id=? AND id NOT IN (
      SELECT id FROM story_steps WHERE owner=? AND story_id=? ORDER BY at DESC,id DESC LIMIT 31)
      AND id<>(SELECT id FROM story_steps WHERE owner=? AND story_id=? ORDER BY at,id LIMIT 1)`).run(owner,id,owner,id,owner,id);
    return true;
  }
  apply(e, updates = []) {
    const owner = partition(e);
    for (const s of updates) {
      if (!s.id && s.stage === 'planned' && this.db.prepare('SELECT 1 FROM stories s JOIN story_steps p ON s.owner=p.owner AND s.id=p.story_id WHERE s.owner=? AND s.source_event=? AND s.plan_id IS NOT NULL AND p.evidence=?').get(owner,eventKey(e),s.evidence)) continue;
      let row = s.id ? this.db.prepare('SELECT * FROM stories WHERE owner=? AND id=?').get(owner, Number(s.id.slice(1)))
        : this.db.prepare('SELECT * FROM stories WHERE owner=? AND title=? ORDER BY id DESC LIMIT 1').get(owner, s.title);
      if (s.id && !row) continue;
      if (!s.id && s.stage === 'planned' && ['completed','cancelled'].includes(row?.status)) row = undefined;
      if (row && (e.receivedAt < row.updated_at || (['completed','cancelled'].includes(row.status) && !['reopened','completed','cancelled'].includes(s.stage)))) continue;
      if (!row) {
        const result = this.db.prepare('INSERT INTO stories(owner,title,status,source_event,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(owner,s.title,s.stage,eventKey(e),e.receivedAt,e.receivedAt);
        row = { id: Number(result.lastInsertRowid) };
      }
      const last = this.db.prepare('SELECT stage,text FROM story_steps WHERE owner=? AND story_id=? ORDER BY at DESC,id DESC LIMIT 1').get(owner,row.id);
      if (last?.text === s.text && last.stage === s.stage) continue;
      if (this.append(e,row.id,s) && row.plan_id && ['completed','cancelled'].includes(s.stage)) this.store.closeFollowup(e,row.plan_id,s.stage === 'completed' ? 'resolved' : 'closed');
    }
  }
  observeFacts(e, facts) {
    const owner = partition(e);
    for (const f of facts) {
      const row = this.db.prepare('SELECT id FROM facts WHERE owner=? AND slot=?').get(owner,f.slot); if (!row) continue;
      this.db.prepare('INSERT OR IGNORE INTO fact_observations VALUES(?,?,?,?,?,?)').run(owner,row.id,eventKey(e),f.value,f.evidence,e.receivedAt);
      this.db.prepare('DELETE FROM fact_observations WHERE owner=? AND fact_id=? AND source_event NOT IN (SELECT source_event FROM fact_observations WHERE owner=? AND fact_id=? ORDER BY at DESC LIMIT 20)').run(owner,row.id,owner,row.id);
      this.db.prepare('DELETE FROM fact_history WHERE owner=? AND fact_id=? AND rowid NOT IN (SELECT rowid FROM fact_history WHERE owner=? AND fact_id=? ORDER BY replaced_at DESC LIMIT 3)').run(owner,row.id,owner,row.id);
    }
  }
  portrait(e) {
    const owner = partition(e);
    return this.db.prepare("SELECT 'F'||id AS id,slot,value,evidence,confidence,created_at,updated_at FROM facts WHERE owner=? AND slot NOT LIKE 'plan:%' ORDER BY CASE WHEN slot LIKE 'boundary:%' THEN 0 WHEN slot LIKE 'style:%' THEN 1 ELSE 2 END,updated_at DESC LIMIT 16").all(owner).map(f => {
      const obs = this.db.prepare('SELECT at FROM fact_observations WHERE owner=? AND fact_id=? AND value=?').all(owner,Number(f.id.slice(1)),f.value);
      const days = new Set(obs.map(o => new Date(o.at + 8*3600000).toISOString().slice(0,10))).size;
      const previous = this.db.prepare('SELECT value,replaced_at FROM fact_history WHERE owner=? AND fact_id=? ORDER BY replaced_at DESC LIMIT 1').get(owner,Number(f.id.slice(1)));
      return { ...f, confirmationDays: days, stability: days >= 3 ? '多日明确表达' : '近期明确表达', ...(previous ? {previous} : {}) };
    });
  }
  removeStory(e, id, removePlan = true) {
    const story = this.detail(e,id); if (!story) return false;
    const owner = partition(e), number = Number(id.slice(1));
    this.db.prepare('DELETE FROM story_steps WHERE owner=? AND story_id=?').run(owner,number);
    this.db.prepare('DELETE FROM stories WHERE owner=? AND id=?').run(owner,number);
    this.db.prepare('DELETE FROM semantic_vectors WHERE owner=? AND memory_id=?').run(owner,id);
    if (removePlan && story.plan_id) {
      this.db.prepare('DELETE FROM episodes WHERE owner=? AND id=?').run(owner,Number(story.plan_id.slice(1)));
      this.db.prepare('DELETE FROM semantic_vectors WHERE owner=? AND memory_id=?').run(owner,story.plan_id);
    }
    return true;
  }
  editStory(e, id, replacement) {
    const old = this.detail(e,id); if (!old) return false;
    if (replacement === undefined) return this.removeStory(e,id);
    const owner = partition(e), number = Number(id.slice(1));
    this.db.prepare('DELETE FROM story_steps WHERE owner=? AND story_id=?').run(owner,number);
    this.db.prepare("UPDATE stories SET title=?,status='recorded' WHERE owner=? AND id=?").run(replacement.slice(0,60),owner,number);
    this.append(e,number,{stage:'recorded',text:replacement,evidence:replacement});
    if (old.plan_id) {
      this.db.prepare("UPDATE episodes SET text=?,evidence=?,status='closed',updated_at=? WHERE owner=? AND id=?").run(replacement,replacement,e.receivedAt,owner,Number(old.plan_id.slice(1)));
      this.db.prepare('DELETE FROM semantic_vectors WHERE owner=? AND memory_id=?').run(owner,old.plan_id);
    }
    return true;
  }
}
