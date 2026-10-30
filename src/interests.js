const normalize = text => text.replace(/[\p{P}\p{S}\s]/gu, '').toLowerCase();
const day = at => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
const sensitive = /(?:密码|口令|token|secret|身份证|银行卡|手机号|家庭住址|诊断|病历)|\d{11,}/iu;

export function validateReflections(raw, evidence) {
  const frames = evidence?.frames ?? [];
  if (!frames.some(f=>typeof f.text === 'string')) return [];
  const topics = new Set();
  return (Array.isArray(raw) ? raw : []).slice(0,2).flatMap(r=>{
    if (!r || typeof r.topic !== 'string' || !/^[\p{L}\p{N}]{2,16}$/u.test(r.topic) || topics.has(r.topic)
      || !Array.isArray(r.keywords) || typeof r.evidence !== 'string' || r.evidence.length < 4 || r.evidence.length > 200
      || !frames.some(f=>typeof f.text === 'string' && f.text.includes(r.evidence)) || typeof r.opinion !== 'string' || r.opinion.length < 4 || r.opinion.length > 120
      || !['reinforce','revise'].includes(r.action) || !Number.isFinite(r.affinity) || Math.abs(r.affinity)>1
      || sensitive.test(r.topic + r.opinion + r.evidence)) return [];
    const keywords = [...new Set(r.keywords.filter(k=>typeof k==='string' && /^[\p{L}\p{N}]{1,12}$/u.test(k) && frames.some(f=>typeof f.text === 'string' && f.text.includes(k))))].slice(0,4);
    if (!keywords.length) return [];
    topics.add(r.topic); return [{...r,keywords}];
  });
}

// 仅处理本应用的公开观看证据。不会用某人的私聊偏好改写机器人的全局观点。
export class InterestMemory {
  constructor(store, file, version) {
    this.store = store; this.db = store.db; this.app = store.appId;
    if (version < 2) {
      if (version > 0 && file !== ':memory:') this.db.exec(`VACUUM INTO '${String(file + '.before-v2-' + Date.now()).replaceAll("'", "''")}'`);
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS interests (app TEXT NOT NULL,topic TEXT NOT NULL,keywords TEXT NOT NULL,weight REAL NOT NULL,
          opinion TEXT NOT NULL,pending TEXT NOT NULL DEFAULT '',pending_sources TEXT NOT NULL DEFAULT '[]',history TEXT NOT NULL DEFAULT '[]',
          last_day TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(app,topic));
        CREATE TABLE IF NOT EXISTS reflections (app TEXT NOT NULL,bvid TEXT NOT NULL,topic TEXT NOT NULL,evidence TEXT NOT NULL,
          opinion TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(app,bvid,topic));
        PRAGMA user_version=2; COMMIT;`);
    }
  }
  epoch() { return this.db.prepare("SELECT value FROM flags WHERE app=? AND name='interestEpoch'").get(this.app)?.value ?? '0'; }
  reset() {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare('DELETE FROM interests WHERE app=?').run(this.app); this.db.prepare('DELETE FROM reflections WHERE app=?').run(this.app);
      this.db.prepare("INSERT INTO flags VALUES(?,'interestEpoch',?) ON CONFLICT(app,name) DO UPDATE SET value=excluded.value").run(this.app,String(Number(this.epoch())+1));
      this.db.exec('COMMIT;');
    } catch(error) {this.db.exec('ROLLBACK;');throw error;}
  }
  context(query = '', limit = 8) {
    return this.db.prepare('SELECT * FROM interests WHERE app=? ORDER BY weight DESC,updated_at DESC LIMIT 40').all(this.app).map(row=>{
      const sources=this.db.prepare('SELECT bvid,evidence,at FROM reflections WHERE app=? AND topic=? ORDER BY at DESC LIMIT 8').all(this.app,row.topic);
      const days=new Set(sources.map(r=>day(r.at))).size;
      return {topic:row.topic,keywords:JSON.parse(row.keywords),weight:row.weight,opinion:row.opinion,
        confidence:days>=3?'多日观察后的暂定看法':'初步感想',pending:row.pending||undefined,history:JSON.parse(row.history),sources:sources.slice(0,3)};
    }).sort((a,b)=> Number(b.keywords.some(k=>query.includes(k)))-Number(a.keywords.some(k=>query.includes(k))) || b.weight-a.weight).slice(0,limit);
  }
  apply(video, raw, evidence, at, epoch) {
    if (epoch !== this.epoch()) return false;
    if (!this.db.prepare('SELECT 1 FROM experiences WHERE app=? AND bvid=?').get(this.app,video.bvid)) return false;
    const reflections=validateReflections(raw,evidence);
    for (const r of reflections) {
      const prior=this.db.prepare('SELECT * FROM interests WHERE app=? AND topic=?').get(this.app,r.topic);
      if (!prior && this.db.prepare('SELECT count(*) n FROM interests WHERE app=?').get(this.app).n>=40) continue;
      if (!this.db.prepare('INSERT OR IGNORE INTO reflections VALUES(?,?,?,?,?,?)').run(this.app,video.bvid,r.topic,r.evidence,r.opinion,at).changes) continue;
      if (prior && at < prior.updated_at) continue;
      let opinion=prior?.opinion ?? r.opinion, pending=prior?.pending ?? '', sources=JSON.parse(prior?.pending_sources ?? '[]'), history=JSON.parse(prior?.history ?? '[]');
      if (prior && r.action==='revise' && normalize(r.opinion)!==normalize(opinion)) {
        if (normalize(pending)!==normalize(r.opinion)) {pending=r.opinion;sources=[];}
        sources.push({bvid:video.bvid,day:day(at),evidence:r.evidence}); sources=sources.slice(-6);
        if (new Set(sources.map(s=>s.bvid)).size>=2 && new Set(sources.map(s=>s.day)).size>=2) {
          history.push({opinion,at,reason:r.evidence,bvid:video.bvid});history=history.slice(-3);opinion=r.opinion;pending='';sources=[];
        }
      } else if (prior && r.action==='reinforce' && normalize(r.opinion)===normalize(opinion)) { pending='';sources=[]; }
      const weight=Math.max(.15,Math.min(.85,(prior?.weight ?? .5)+(prior?.last_day===day(at)?0:.04*r.affinity)));
      const keywords=[...new Set([...JSON.parse(prior?.keywords??'[]'),...r.keywords])].slice(-8);
      this.db.prepare(`INSERT INTO interests VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(app,topic) DO UPDATE SET keywords=excluded.keywords,
        weight=excluded.weight,opinion=excluded.opinion,pending=excluded.pending,pending_sources=excluded.pending_sources,
        history=excluded.history,last_day=excluded.last_day,updated_at=excluded.updated_at`).run(this.app,r.topic,JSON.stringify(keywords),weight,opinion,pending,JSON.stringify(sources),JSON.stringify(history),day(at),at);
    }
    return reflections.length>0;
  }
  select(choices, configured, attempt = 1) {
    const seed=configured.split(/[、，,\s]+/u).filter(Boolean), learned=this.context('',40);
    const ranked=choices.map((v,index)=>({v,index,score:seed.filter(k=>v.title.includes(k)).length*.5
      +learned.reduce((score,r)=>score+(r.keywords.some(k=>v.title.includes(k))?r.weight:0),0)}));
    // 每四次现有浏览机会探索一个较少匹配的候选，次数和时段由外层原预算控制。
    ranked.sort((a,b)=>(attempt%4===0?a.score-b.score:b.score-a.score)||a.index-b.index);
    return ranked[0]?.v;
  }
}
