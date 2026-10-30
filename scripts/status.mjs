import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve('.local/runtime/memory.sqlite');
if (!existsSync(file)) { console.log('尚未创建运行数据库；插件可能未启动。'); process.exit(0); }
const db = new DatabaseSync(file, { readOnly: true });
try {
  console.log(JSON.stringify({
    capabilities: db.prepare('SELECT scope,capability,status,observed_at FROM capabilities ORDER BY scope,capability').all(),
    inbound: db.prepare('SELECT state,count(*) AS count FROM inbound GROUP BY state').all(),
    schema: db.prepare('PRAGMA user_version').get().user_version,
    memories: db.prepare('SELECT count(*) AS count FROM memories').get().count,
    facts: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='facts'").get() ? db.prepare('SELECT count(*) AS count FROM facts').get().count : 0,
    repliesReserved: db.prepare('SELECT coalesce(sum(used),0) AS count FROM replies').get().count,
  }, null, 2));
} finally { db.close(); }
