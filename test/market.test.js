import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketIndex } from '../scripts/market-index.mjs';

test('发布索引保留旧版本，强制版本号与固定提交对应', () => {
  const pkg = { name: 'dsh-companion', version: '0.1.0', description: 'QQ companion', keywords: ['qq'], engines: { dsh: '>=0.2.1-rc.2 <0.2.2' } };
  const opts = { repository: 'https://github.com/example/fixture', commit: 'a'.repeat(40), publishTimestamp: 1793280000 };
  const first = buildMarketIndex(pkg, opts);
  const next = buildMarketIndex({ ...pkg, version: '0.1.1' }, { ...opts, commit: 'b'.repeat(40), previous: first });
  assert.deepEqual(next.plugins[0].versions.map(v => v.version), ['0.1.1', '0.1.0']);
  assert.equal(first.plugins[0].versions.length, 1);
  assert.throws(() => buildMarketIndex(pkg, { ...opts, commit: 'b'.repeat(40), previous: first }), /提升/u);
  assert.throws(() => buildMarketIndex(pkg, { ...opts, commit: 'main' }), /SHA/u);
});

test('官方 format 1 解析器接受发布索引并产生固定提交安装地址', async () => {
  const { parseMarketIndex, marketInstallTarget } = await import('@deepseek-ai/dsh-plugin-market-index');
  const index = buildMarketIndex({ name: 'dsh-companion', version: '0.1.0-alpha.1', description: 'QQ companion', keywords: ['qq'], engines: { dsh: '>=0.2.1-rc.2 <0.2.2' } },
    { repository: 'https://github.com/example/fixture', commit: 'a'.repeat(40), publishTimestamp: 1793280000 });
  const parsed = parseMarketIndex(index, 'https://example.github.io/fixture/index.json');
  const plugin = parsed.plugins[0];
  assert.equal(marketInstallTarget(plugin.name, plugin.versions[0]).spec, `git+https://github.com/example/fixture.git#${'a'.repeat(40)}`);
});
