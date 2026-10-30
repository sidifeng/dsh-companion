import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildMarketIndex } from './market-index.mjs';
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? '') || !token) throw new Error('GitHub Actions repository/token required');
const root = `https://api.github.com/repos/${repository}`;
async function api(path, method = 'GET', body, missing = false) {
  const response = await fetch(root + path, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (missing && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
  return response.json();
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const head = await api('/git/ref/heads/market-index', 'GET', undefined, true);
let previous;
if (head) {
  const file = await api(`/contents/index.json?ref=${head.object.sha}`);
  previous = JSON.parse(Buffer.from(file.content, 'base64').toString());
}
if (previous?.plugins?.find(p => p.name === pkg.name)?.versions.some(v => v.version === pkg.version)) {
  console.log(`版本 ${pkg.version} 已发布；再次上传源码不会覆盖它。发布新代码请提高 package.json 版本。`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'created=false\n');
  process.exit(0);
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const index = parseMarketIndex(buildMarketIndex(pkg, { repository: `https://github.com/${repository}`, commit, previous,
  publishTimestamp: Math.floor(Date.now() / 1000) }), `https://raw.githubusercontent.com/${repository}/market-index/index.json`);
const content = JSON.stringify(index, null, 2) + '\n';
const tree = await api('/git/trees', 'POST', { tree: [{ path: 'index.json', mode: '100644', type: 'blob', content }] });
const next = await api('/git/commits', 'POST', { message: `Publish ${pkg.name} ${pkg.version}`, tree: tree.sha, parents: head ? [head.object.sha] : [] });
if (head) await api('/git/refs/heads/market-index', 'PATCH', { sha: next.sha, force: false });
else await api('/git/refs', 'POST', { ref: 'refs/heads/market-index', sha: next.sha });
mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/index.json', content);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `created=true\nversion=${pkg.version}\ncommit=${commit}\n`);
console.log(`已发布 ${pkg.name} ${pkg.version} 的固定提交索引。`);
