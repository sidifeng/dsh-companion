import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../src/config.js';
import { AutonomyStore } from '../src/autonomy-store.js';
import { AutonomyEngine, isQuiet, localClock, proactiveDraft, analyzeExperience, structuredAutonomy } from '../src/autonomy.js';

const at = text => Date.parse(`2026-10-30T${text}+08:00`);
const cfg = () => Config({ appId: 'BOT', access: { groupMode: 'allowlist', groupAllow: ['GROUP'], c2cMode: 'allowlist', c2cAllow: ['OWNER'] },
  autonomy: { enabled: true, groupEnabled: true, privateEnabled: false, browseEnabled: true, operatorIds: ['OWNER'] } });
const video = n => ({ bvid: `BV${String(n).padStart(10, '0')}`, title: `猫的日常 ${n}`, durationSeconds: 45 });
const inspected = { analysis: { summary: '猫钻进纸箱。', reaction: '这个小动作很好笑。', shareworthy: true }, evidence: { frames: [{ seconds: 10, text: '猫在纸箱中' }], limitation: '抽帧，没有音轨' } };
test('真实整理结果截断或 JSON 不完整时只重试一次，完整结构才接受', async () => {
  for (const first of ['max-tokens', 'stop']) {
    const budgets = [];
    const llm = { async *stream(options) {
      budgets.push(options.maxTokens);
      yield { type: 'text-delta', index: 0, text: budgets.length === 1 ? '{"summary":"未完成' : JSON.stringify(inspected.analysis) };
      yield { type: 'finish', reason: { kind: budgets.length === 1 ? first : 'stop' } };
    } };
    assert.deepEqual(await structuredAutonomy(llm, {}, '整理实际画面', { validate: analyzeExperience }), inspected.analysis);
    assert.deepEqual(budgets, [2400, 4800]);
  }
  let calls = 0;
  const broken = { async *stream() { calls++; yield { type: 'text-delta', index: 0, text: '{}' }; yield { type: 'finish', reason: { kind: 'max-tokens' } }; } };
  await assert.rejects(structuredAutonomy(broken, {}, 'test'), /TRUNCATED/u); assert.equal(calls, 2);
  const controller = new AbortController();
  const cancelled = { async *stream() { controller.abort(); yield { type: 'text-delta', index: 0, text: '{' }; } };
  await assert.rejects(structuredAutonomy(cancelled, {}, 'test', { signal: controller.signal }));
});
function setup(t, changes = {}) {
  const store = new AutonomyStore(':memory:', 'BOT'); const sent = []; let now = at('10:00:00');
  const engine = new AutonomyEngine({ config: cfg(), store,
    memory: { recall() { throw Error('群主动不能读取私人记忆'); }, profile() { throw Error('群主动不能读取私人关系'); } },
    tasks: { list: async () => [video(1)], inspect: async () => inspected,
      draft: async data => { assert.equal(data.memories, undefined); return { send: true, text: '抽看了猫钻纸箱的几个画面，看它认真找角度还挺好笑。', topic: '猫钻纸箱' }; } },
    push: async data => sent.push(data), permission: async () => true, now: () => now, ...changes });
  t.after(async () => { await engine.close(); store.close(); });
  return { engine, store, sent, setTime: value => { now = value; } };
}

test('北京时间安静时段跨午夜，09:00 开始、23:00 停止', () => {
  const c = cfg().autonomy;
  for (const time of ['23:00:00', '23:59:59', '00:00:00', '08:59:59']) assert.equal(isQuiet(at(time), c), true);
  for (const time of ['09:00:00', '22:59:59']) assert.equal(isQuiet(at(time), c), false);
  assert.equal(localClock(Date.parse('2026-10-30T17:00:00Z')).day, '2026-10-31');
});

test('自主浏览有抽帧证据才入库；仅向配置的群分享，不主动私聊或读取私人记忆', async t => {
  const { engine, store, sent } = setup(t);
  const result = await engine.run();
  assert.equal(result.browse.state, 'viewed'); assert.equal(store.experiences().length, 1);
  assert.equal(sent.length, 1); assert.equal(sent[0].scope, 'group'); assert.equal(sent[0].targetId, 'GROUP');
  assert.match(sent[0].text, /BV0000000001/u); assert.equal(sent[0].msgId, undefined);
  assert.equal(store.shareable('chat:group', 'GROUP', at('10:01:00')), undefined);
});

test('半小时预算和投递记录持久化，重启不重发 reserved/sending，不补发离线积压', t => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-autonomy-')); const file = join(dir, 'db.sqlite');
  let store = new AutonomyStore(file, 'BOT');
  const id = store.reserve('chat:group', 'GROUP', '2026-10-30', at('10:00:00'), 28, 1800000);
  store.finish(id, 'sending', { text: '已经提交网络的消息', bvid: video(1).bvid }); store.close();
  store = new AutonomyStore(file, 'BOT');
  assert.equal(store.reserve('chat:group', 'GROUP', '2026-10-30', at('10:29:59'), 28, 1800000), null);
  assert.ok(store.reserve('chat:group', 'GROUP', '2026-10-30', at('14:00:00'), 28, 1800000));
  assert.equal(store.count('chat:group', 'GROUP', '2026-10-30'), 2);
  const otherApp = new AutonomyStore(file, 'OTHER'); assert.equal(otherApp.count('chat:group', 'GROUP', '2026-10-30'), 0); otherApp.close();
  t.after(() => { store.close(); assert.ok(dir.startsWith(join(tmpdir(), 'companion-autonomy-'))); rmSync(dir, { recursive: true, force: true }); });
});

test('安静时段不主动发，生成期间跨入安静时段也不发', async t => {
  const { engine, setTime, sent } = setup(t);
  setTime(at('23:05:00')); await engine.run(); assert.equal(sent.length, 0);
  setTime(at('22:59:00'));
  engine.tasks.draft = async () => { setTime(at('23:00:01')); return { send: true, text: '新的话题', topic: '新话题' }; };
  await engine.run({ browse: false }); assert.equal(sent.length, 0);
});

test('生成期间群里来了消息则让位；关闭开关可阻止迟到结果', async t => {
  const { engine, sent, store, setTime } = setup(t);
  engine.tasks.draft = async () => { engine.noteActivity('group', 'GROUP', at('10:00:01')); return { send: true, text: '新话题', topic: '新话题' }; };
  await engine.run({ browse: false }); assert.equal(sent.length, 0);
  setTime(at('11:00:00'));
  engine.tasks.draft = async () => { engine.pause('groupEnabled', false); return { send: true, text: '迟到内容', topic: '迟到' }; };
  await engine.run({ browse: false }); assert.equal(sent.length, 0); assert.equal(store.flag('groupEnabled', true), false);
});

test('平台关闭主动推送后封锁目标；不把失败主动消息转成被动回复', async t => {
  const { engine, sent, store, setTime } = setup(t, { permission: async () => false });
  await engine.run({ browse: false }); assert.equal(sent.length, 0); assert.equal(store.peer('group', 'GROUP').blocked, 'PLATFORM_DISABLED');
  setTime(at('12:00:00')); engine.permission = async () => true;
  await engine.run({ browse: false }); assert.equal(sent.length, 0);
});

test('主动投递超时视为不确定，扣次数且不自动重发', async t => {
  let calls = 0;
  const { engine, store } = setup(t, { push: async () => { calls++; throw Error('timeout'); } });
  await engine.run({ browse: false }); await engine.run({ browse: false, manual: true });
  assert.equal(calls, 1); assert.equal(store.latest('chat:group', 'GROUP').state, 'uncertain');
});

test('视频去重和每日七次上限，失败不能被记录为看过', async t => {
  const { engine, store } = setup(t); let count = 0;
  engine.tasks.list = async () => [video(++count)];
  for (let i = 0; i < 8; i++) await engine.run({ browse: true, chat: false, manual: true });
  assert.equal(store.experiences(20).length, 7); assert.equal(count, 7);
  const second = setup(t);
  second.engine.tasks.inspect = async () => { throw Error('no media'); };
  await second.engine.run({ chat: false }); assert.deepEqual(second.store.experiences(), []);
  assert.equal(second.store.latest('browse', '').state, 'failed');
});

test('每两小时才自主浏览一次；运行中不重叠', async t => {
  const { engine, store, setTime } = setup(t); let count = 0;
  engine.tasks.list = async () => [video(++count)];
  await engine.run({ chat: false }); setTime(at('11:59:59')); await engine.run({ chat: false }); assert.equal(count, 1);
  setTime(at('12:00:00')); await engine.run({ chat: false }); assert.equal(count, 2);
  let release; const pending = new Promise(r => { release = r; }); setTime(at('14:00:00'));
  engine.tasks.list = async () => { await pending; return [video(9)]; };
  const running = engine.run({ chat: false }); assert.equal((await engine.run({ chat: false })).reason, 'busy-or-stopped');
  release(); await running; assert.equal(store.count('browse', '', '2026-10-30'), 3);
});

test('自主设置只接受配置管理员的真实私聊身份，正文不能伪造权限', async t => {
  const { engine } = setup(t);
  assert.match(await engine.command({ scope: 'group', senderId: 'OWNER', text: '/群主动 关' }), /私聊/u);
  assert.match(await engine.command({ scope: 'c2c', senderId: 'STRANGER', text: '/群主动 关' }), /管理员/u);
  assert.equal(engine.enabled('groupEnabled'), true);
  assert.match(await engine.command({ scope: 'c2c', senderId: 'OWNER', text: '/群主动 关' }), /关闭/u);
  assert.equal(engine.enabled('groupEnabled'), false); assert.equal(engine.enabled('privateEnabled'), false);
});

test('分享只接受严格结构，重复话题跳过，链接和群@由程序限制', () => {
  assert.throws(() => analyzeExperience({ summary: '内容', reaction: '感想', shareworthy: 'yes' }));
  assert.throws(() => proactiveDraft({ send: true, text: 'https://bad.test', topic: 'x' }, [], null));
  assert.equal(proactiveDraft({ send: false }, [], null), null);
  assert.equal(proactiveDraft({ send: true, text: '换句话重复说', topic: '旧话题' }, [{ text: '旧内容', topic: '旧话题' }]), null);
  assert.equal(proactiveDraft({ send: true, text: '接着聊刚才的路线', topic: '路线', source: 'group' }, [], video(1)).bvid, '');
});

test('群主动接续公开话题或共同计划，回访占用原预算且取消后不发', async t => {
  let claimed = 0;
  const { engine, sent, setTime } = setup(t, {
    dialogue: { async prepare() { return { summary: '大家聊周末骑行路线' }; } },
    memory: { dueGroupFollowup() { return { id: 'E1', text: '大家周末骑行', evidence: '我们周末去骑行', owner: { scope: 'group' } }; },
      claimFollowup(_owner, id) { assert.equal(id, 'E1'); return ++claimed === 1; } },
  });
  engine.tasks.draft = async data => {
    assert.match(data.groupContext.summary, /骑行/u); assert.equal(data.memories, undefined);
    return { send: true, text: `之前讨论的骑行后来定下来了吗${claimed || ''}？`, topic: `骑行${claimed}`, source: 'followup', followupId: 'E1' };
  };
  await engine.run({ browse: false }); assert.equal(sent.length, 1);
  await engine.run({ browse: false }); assert.equal(sent.length, 1);
  setTime(at('11:00:00')); await engine.run({ browse: false }); assert.equal(sent.length, 1);
});

test('手动浏览继承本轮取消信号，取消后不保存迟到经历，也不接着主动发言', async t => {
  const { engine, store, sent } = setup(t); const controller = new AbortController();
  engine.tasks.inspect = async (_video, signal) => { controller.abort(); assert.equal(signal.aborted, true); return inspected; };
  await engine.run({ manual: true, signal: controller.signal });
  assert.equal(store.experiences().length, 0); assert.equal(sent.length, 0);
  assert.equal(store.latest('browse', '').code, 'CANCELLED');
});
