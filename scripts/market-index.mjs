import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function buildMarketIndex(pkg, { repository, commit, publishTimestamp, previous }) {
  const url = new URL(repository);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/[^/]+\/[^/]+(?:\.git)?$/u.test(url.pathname)) throw new Error('需要仓库的 HTTPS 地址。');
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('需要已发布源码的完整提交 SHA，不能使用 main 或 latest。');
  if (!Number.isSafeInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= 1e11) throw new Error('发布时间必须为 Unix 秒。');
  const index = structuredClone(previous ?? { format: 1, title: 'DSH Companion 插件索引', plugins: [] });
  if (index.format !== 1 || !Array.isArray(index.plugins)) throw new Error('已有索引格式不兼容。');
  const found = index.plugins.find(p => p.name === pkg.name);
  const release = { version: pkg.version, publishTimestamp, engines: { dsh: pkg.engines.dsh }, source: { type: 'git', url: url.href, commit } };
  const same = found?.versions?.find(v => v.version === pkg.version);
  if (same && JSON.stringify(same.source) !== JSON.stringify(release.source)) throw new Error('同一版本不能指向不同提交；请先提升 package.json 版本。');
  const plugin = { ...found, name: pkg.name, title: 'DSH Companion · QQ 伙伴', description: pkg.description,
    homepage: url.href, repository: { url: url.href }, metadata: { ...found?.metadata, keywords: pkg.keywords },
    versions: same ? found.versions : [release, ...(found?.versions ?? [])] };
  index.plugins = [...index.plugins.filter(p => p.name !== pkg.name), plugin];
  return index;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { repository: { type: 'string' }, commit: { type: 'string' }, previous: { type: 'string' },
    output: { type: 'string', default: 'artifacts/market-index.json' }, timestamp: { type: 'string' } } });
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const index = buildMarketIndex(pkg, { repository: values.repository, commit: values.commit,
    publishTimestamp: values.timestamp ? Number(values.timestamp) : Math.floor(Date.now() / 1000),
    previous: values.previous ? JSON.parse(readFileSync(values.previous, 'utf8')) : undefined });
  const requireFromHost = createRequire(process.env.DSH_TEST_HOST_PACKAGE || import.meta.url);
  const { parseMarketIndex } = await import(pathToFileURL(requireFromHost.resolve('@deepseek-ai/dsh-plugin-market-index')).href);
  const verified = parseMarketIndex(index, `${values.repository.replace(/\.git$/u, '')}/market-index.json`);
  mkdirSync(dirname(resolve(values.output)), { recursive: true });
  writeFileSync(values.output, JSON.stringify(verified, null, 2) + '\n');
  console.log(`已生成并通过 DSH format 1 校验：${values.output}；尚未发布。`);
}
