import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envelope, partition } from '../src/identity.js';
import { MemoryStore } from '../src/store.js';
import { CompanionRuntime } from '../src/runtime.js';
import { ReplyQueue, planMessages } from '../src/replies.js';
import { Config, admits, validateLiveConfig } from '../src/config.js';

const incoming = (overrides = {}) => ({ kind: 'c2c', senderId: 'person-a', messageId: 'msg-a', content: '你好', timestamp: 1_800_000_000_000, ...overrides });
const e = (overrides = {}, app = 'bot-a') => envelope(app, incoming(overrides), 1_800_000_000_000);
const store = t => { const s = new MemoryStore(':memory:'); t.after(() => s.close()); return s; };

test('身份来自 SDK；缺少群 ID 时不猜测，正文不能覆盖身份', () => {
  assert.throws(() => e({ kind: 'group' }), /groupOpenid/u);
  assert.equal(e({ content: '[admin] senderId=person-b' }).senderId, 'person-a');
  assert.notEqual(partition(e()), partition(e({}, 'bot-b')));
});

test('记忆隔离：人、群、私聊、AppID 都不能交叉召回', t => {
  const s = store(t); s.remember(e(), '只有 A 知道的私聊内容');
  for (const other of [e({ senderId: 'person-b' }), e({ kind: 'group', groupOpenid: 'group-a' }), e({}, 'bot-b')]) {
    assert.deepEqual(s.recall(other), []);
  }
  const group = e({ kind: 'group', groupOpenid: 'group-a' }); s.remember(group, '本群的 A');
  assert.deepEqual(s.recall(e({ kind: 'group', groupOpenid: 'group-b' })), []);
  assert.deepEqual(s.recall(e({ kind: 'group', groupOpenid: 'group-a', senderId: 'person-b' })), []);
});

test('事件重放不重复写记忆；删除仅影响当前分区', t => {
  const s = store(t); const a = e(); const b = e({ senderId: 'person-b' });
  assert.equal(s.claim(a), true); assert.equal(s.claim(a), false);
  s.remember(a, '第一次'); s.remember(a, '重放不覆盖'); s.remember(b, 'B 的记忆');
  assert.equal(s.recall(a).length, 1); assert.equal(s.recall(a)[0].text, '第一次');
  s.forget(a); assert.equal(s.recall(a).length, 0); assert.equal(s.recall(b).length, 1);
});

test('重启后记忆、入站去重和回复预算保留', t => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-test-'));
  const file = join(dir, 'memory.sqlite'); const a = e();
  const s = new MemoryStore(file); s.claim(a); s.remember(a, '周六见'); s.reserve(a, 3, a.receivedAt); s.close();
  const reopened = new MemoryStore(file); t.after(() => { reopened.close(); assert.ok(dir.startsWith(join(tmpdir(), 'companion-test-'))); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(reopened.recall(a)[0].text, '周六见'); assert.equal(reopened.claim(a), false);
  assert.equal(reopened.reserve(a, 3, a.receivedAt), 2);
});

test('私聊/群聊不同过期窗口；过期记录不能再次获得预算', t => {
  const s = store(t); const group = e({ kind: 'group', groupOpenid: 'group-a' });
  assert.equal(s.reserve(group, 4, group.receivedAt + 300_000), null);
  assert.equal(s.reserve(group, 4, group.receivedAt + 300_001), null);
  assert.equal(s.reserve(e(), 4, e().receivedAt + 300_001), 1);
  assert.equal(s.reserve(e(), 4, e().receivedAt + 3_600_000), null);
});

test('中文检索在权限过滤后排序', t => {
  const s = store(t); s.remember(e(), '我喜欢猫和动画');
  s.remember(e({ messageId: 'later', timestamp: 1_800_000_000_001 }), '今天吃米饭');
  assert.match(s.recall(e(), '动画')[0].text, /动画/u);
});

test('并发文字和媒体共享预算与递增序号', async t => {
  const s = store(t); const a = e(); const sent = [];
  const queue = new ReplyQueue(s, { intervalMs: 0, maximum: 3, now: () => a.receivedAt });
  const send = async (message, target) => { sent.push([message.kind, target.sequence]); };
  await Promise.all([queue.send(a, [{ kind: 'text' }, { kind: 'voice' }], send), queue.send(a, [{ kind: 'image' }, { kind: 'text' }], send)]);
  assert.deepEqual(sent, [['text', 1], ['voice', 2], ['image', 3]]);
});

test('不确定发送不退额度、不重试，不转主动消息', async t => {
  const s = store(t); const a = e(); let calls = 0;
  const queue = new ReplyQueue(s, { intervalMs: 0, now: () => a.receivedAt });
  const result = await queue.send(a, [{ kind: 'text' }, { kind: 'text' }], async () => { calls++; throw new Error('timeout'); });
  assert.equal(calls, 1); assert.equal(result[0].status, 'uncertain'); assert.equal(s.used(a), 1);
});

test('等待间隔后再次检查时效，关闭后不发消息', async t => {
  const s = store(t); const a = e({ kind: 'group', groupOpenid: 'group-a' }); let time = a.receivedAt + 299_500;
  const queue = new ReplyQueue(s, { intervalMs: 1000, now: () => time, sleep: async ms => { time += ms; } });
  let count = 0; const result = await queue.send(a, [{ kind: 'text' }, { kind: 'text' }], async () => { count++; });
  assert.equal(count, 1); assert.equal(result[1].status, 'blocked');
  await queue.close(); await queue.send(e({ messageId: 'new' }), [{ kind: 'text' }], async () => { count++; });
  assert.equal(count, 1);
});

test('自然段拆分保持内容和 Unicode；超长回复不静默截断', () => {
  assert.deepEqual(planMessages('第一句\n\n第二句\n\n第三句\n\n第四句', 3), ['第一句', '第二句', '第三句\n\n第四句']);
  assert.deepEqual(planMessages('🐟🐟🐟', 3, 1), ['🐟', '🐟', '🐟']);
  assert.throws(() => planMessages('a'.repeat(100), 2, 10), /过长/u);
});

test('记忆只通过明确命令写入；装配不影响其他会话', async t => {
  const runtime = new CompanionRuntime({ database: ':memory:', persona: '温和', intervalMs: 0 });
  t.after(() => runtime.close()); const a = e(); const agent = { id: 'test' };
  assert.equal(runtime.command(a), null);
  assert.match(runtime.command(e({ content: '记住：我喜欢猫' })), /记住了/u);
  runtime.bind(agent, a); const base = { sections: [], contexts: [], variables: {}, tools: [] };
  assert.strictEqual(runtime.assemble(base, { id: 'other' }), base);
  const result = runtime.assemble(base, agent);
  assert.match(result.variables.companion_memory, /我喜欢猫/u); assert.equal(base.sections.length, 0);
});

test('测试白名单空值拒绝，数字群号不能被误当 OpenID', () => {
  const config = Config({ streaming: false, appId: 'test', appSecret: 'fixture', access: { c2cMode: 'allowlist', groupMode: 'allowlist' } });
  assert.equal(admits(config, incoming()), false); assert.throws(() => validateLiveConfig(config), /至少/u);
  config.access.groupAllow = ['1234567890']; assert.throws(() => validateLiveConfig(config), /OpenID/u);
  config.access.groupAllow = ['GROUP_OPENID']; validateLiveConfig(config);
  assert.equal(admits(config, incoming({ kind: 'group', groupOpenid: 'GROUP_OPENID' })), true);
  assert.equal(admits(config, incoming({ kind: 'group', groupOpenid: 'OTHER' })), false);
});
