import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { DatabaseSync } from 'node:sqlite';
import { upstreamRoot, UPSTREAM_VERSION } from '../src/upstream.js';

const profile = resolve(process.argv[2] || join(homedir(), '.dsh', 'profiles', 'web'));
const read = (path, fallback) => { try { return readFileSync(path, 'utf8'); } catch { return fallback; } };
const pkg = JSON.parse(read(join(profile, 'package.json'), '{}'));
const overrides = yaml.load(read(join(profile, 'cordis.patch.yml'), '[]'));
const rows = [];
let companion;
function scan(value) {
  if (!value || typeof value !== 'object') return;
  if (value.id === 'im-qqbot' || value.name === '@tencent-connect/dsh-qqbot') {
    const c = value.config ?? {};
    rows.push({ configuredAppId: Boolean(c.appId && c.appId !== '__FROM_ENV__'),
      configuredSecret: Boolean(c.appSecret && c.appSecret !== '__FROM_ENV__'), disabled: value.disabled === true });
  }
  if (value.id === 'dsh-companion') companion = value;
  Object.values(value).forEach(scan);
}
scan(overrides);
let observations = [];
const database = companion?.config?.companion?.dataDir && join(companion.config.companion.dataDir, 'memory.sqlite');
if (database && existsSync(database)) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { observations = db.prepare('SELECT scope,capability,status,observed_at FROM capabilities ORDER BY scope,capability').all(); }
  finally { db.close(); }
}
const report = {
  checkedAt: new Date().toISOString(), node: process.version,
  localUpstream: { version: UPSTREAM_VERSION, loadable: existsSync(upstreamRoot()) },
  installed: Object.keys(pkg.dependencies ?? {}), officialConfig: rows,
  companion: companion ? { enabled: companion.disabled !== true && companion.config?.enabled === true,
    provider: companion.config?.provider, model: companion.config?.model,
    c2cAllowCount: companion.config?.access?.c2cAllow?.length ?? 0, groupAllowCount: companion.config?.access?.groupAllow?.length ?? 0 } : null,
  observations,
  note: '能力记录仅代表 observed_at 时发生过的结果；未列出的能力尚未验证，连接记录不是实时心跳。',
};
mkdirSync('.local', { recursive: true });
writeFileSync('.local/doctor.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
