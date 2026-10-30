import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../src/config.js';
import { startGateway, wrapVisionDefinition } from '../src/gateway.js';
import { CompanionRuntime } from '../src/runtime.js';

class FakeQQ {
  appId = 'fixture-bot'; middlewares = []; handlers = new Map(); sent = [];
  use(fn) { this.middlewares.push(fn); }
  on(name, fn) { this.handlers.set(name, fn); }
  async start() { this.handlers.get('ready')?.(); }
  stop() {}
  async send(data) { this.sent.push(data); return { id: `sent-${this.sent.length}` }; }
  async receive(message) {
    const context = { bot: this, log: { debug() {}, warn() {}, info() {}, error() {} }, stop() {}, message, state: {}, replyTarget: { scope: message.kind, targetId: message.groupOpenid ?? message.senderId, msgId: message.messageId } };
    const walk = index => index === this.middlewares.length ? this.handlers.get('message')(context) : this.middlewares[index](context, () => walk(index + 1));
    await walk(0);
  }
}

test('真实腾讯 SessionManager/入站处理 + 模拟 QQ 与模型，群内不同人不合并', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-gateway-'));
  const bot = new FakeQQ(); const callbacks = new Map(); const agents = new Map(); const prompts = [];
  let auxiliary;
  const tools = { restrict() {}, guard() {}, register() {} };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: name => name === 'tools' ? tools : name === 'llm' ? auxiliary : undefined,
    on(name, fn) { callbacks.set(name, [...(callbacks.get(name) ?? []), fn]); return () => {}; },
    effect(fn) { fn(); },
    agents: {
      get: id => agents.get(id),
      resume: async () => { throw new Error('fixture new session'); },
      async create(options) {
        const agent = { id: options.sessionId, session: { header: { id: options.sessionId }, events: [] }, cancel() {},
          followup(message) {
            this.pending = (async () => {
              let prompt = { sections: [], contexts: [], tools: [], variables: {} };
              for (const fn of callbacks.get('system-prompt/assemble') ?? []) { const prev = prompt; prompt = await fn(prev, { agent }, async () => prev); }
              prompts.push({ message, prompt });
              const event = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一句\n\n第二句' }] } } };
              for (const fn of callbacks.get('session/event') ?? []) fn(agent.session, event);
            })();
          }, whenIdle() { return this.pending; } };
        await options.setup({ get: () => tools }, agent);
        agents.set(agent.id, agent);
        return { agent, dispose: async () => agents.delete(agent.id) };
      },
    },
  };
  const config = Config({ enabled: true, streaming: false, appId: 'fixture-bot', appSecret: 'fixture-not-a-secret', provider: 'fixture', model: 'fixture',
    access: { c2cMode: 'allowlist', c2cAllow: ['A'], groupMode: 'allowlist', groupAllow: ['GROUP'] },
    companion: { dataDir: dir, intervalMs: 0 } });
  const gateway = await startGateway(ctx, config, { bot, autonomyTasks: {
    draft: async data => { assert.equal(data.memories, undefined); return { send: true, text: '突然好奇大家更喜欢猫还是狗。', topic: '猫狗' }; },
  } });
  t.after(async () => { await gateway.close(); assert.ok(dir.startsWith(join(tmpdir(), 'companion-gateway-'))); rmSync(dir, { recursive: true, force: true }); });
  const message = (id, text, extra = {}) => ({ kind: 'c2c', senderId: 'A', messageId: id, content: text, timestamp: Date.now(), ...extra });
  await bot.receive(message('remember', '记住：我喜欢橘猫'));
  await bot.receive(message('ask', '你记得我喜欢什么吗'));
  assert.match(prompts[0].prompt.variables.companion_memory, /橘猫/u);
  assert.equal(bot.sent.length, 3); assert.deepEqual(bot.sent.slice(1).map(x => x.extra.msg_seq), [1, 2]);
  await bot.receive(message('ask', '重放')); assert.equal(bot.sent.length, 3);
  await bot.receive(message('other', '你好', { senderId: 'UNLISTED' })); assert.equal(bot.sent.length, 3);
  const group = { kind: 'group', groupOpenid: 'GROUP', rawEventType: 'GROUP_AT_MESSAGE_CREATE' };
  const beforeListen = bot.sent.length;
  await bot.receive(message('group-talk1', '北门那条路正在维修', { ...group, rawEventType: 'GROUP_MESSAGE_CREATE' }));
  await bot.receive(message('group-talk2', '那我们改从南门进去', { ...group, rawEventType: 'GROUP_MESSAGE_CREATE', senderId: 'B' }));
  assert.equal(bot.sent.length, beforeListen, '理解非@消息不立即插话');
  await Promise.all([bot.receive(message('g1', 'A 的问题', group)), bot.receive(message('g2', 'B 的问题', { ...group, senderId: 'B' }))]);
  assert.equal(prompts.length, 3);
  assert.doesNotMatch(JSON.stringify(prompts.slice(1)), /橘猫/u);
  assert.match(prompts[1].prompt.variables.companion_group, /南门/u);
  assert.deepEqual(bot.sent.slice(3).map(x => x.target.msgId), ['g1', 'g1', 'g2', 'g2']);
  assert.equal(gateway.manager.size, 3, '同群不同人的模型历史也隔离');
  const privateRecord = [...gateway.manager.sessions.values()].find(r => r.scope === 'c2c');
  const oldSession = privateRecord.agent.session;
  let entered; const started = new Promise(resolve => { entered = resolve; });
  privateRecord.agent.followup = function () { this.pending = new Promise(() => {}); entered(); };
  const waiting = bot.receive(message('wait', '慢任务'));
  await started;
  await bot.receive(message('cancel-other', '/取消', { ...group, senderId: 'B' }));
  assert.match(bot.sent.at(-1).content, /没有/u);
  await bot.receive(message('cancel-own', '/取消')); await waiting;
  assert.match(bot.sent.at(-1).content, /已取消/u);
  const beforeLate = bot.sent.length;
  for (const fn of callbacks.get('session/event') ?? []) fn(oldSession, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '迟到结果' }] } } });
  await Promise.resolve(); assert.equal(bot.sent.length, beforeLate);
  await bot.receive(message('new-after-cancel', '继续聊'));
  assert.notEqual([...gateway.manager.sessions.values()].find(r => r.scope === 'c2c').sessionId, oldSession.header.id);
  config.autonomy.enabled = true; config.autonomy.groupEnabled = true;
  // 这里只验证发送链路；夜间禁发由 autonomy.test 单独验证，不能依赖运行测试时的时钟。
  gateway.autonomy.now = () => Date.parse('2026-10-30T12:00:00+08:00');
  await gateway.autonomy.run({ browse: false, manual: true });
  assert.deepEqual(bot.sent.at(-1).target, { scope: 'group', targetId: 'GROUP' });
  assert.equal(bot.sent.at(-1).msgType, 0);
  auxiliary = { async *stream() {
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ event: { kind: 'warmth', target: 'bot', subject: 'speaker', evidence: '和你聊天很开心', intensity: 0.6, confidence: 0.95 } }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  await bot.receive(message('bio', '和你聊天很开心'));
  assert.match(prompts.at(-1).prompt.variables.companion_biology, /初识/u);
  assert.equal(gateway.runtime.store.db.prepare('SELECT count(*) n FROM biology_events').get().n, 1);
});

test('图片工具不能读其他人附件或任意本地/远程文件', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-vision-'));
  const own = join(dir, 'own.png'); const other = join(dir, 'other.png'); writeFileSync(own, 'fixture'); writeFileSync(other, 'fixture');
  const runtime = new CompanionRuntime({ database: ':memory:', persona: 'fixture' });
  t.after(async () => { await runtime.close(); assert.ok(dir.startsWith(join(tmpdir(), 'companion-vision-'))); rmSync(dir, { recursive: true, force: true }); });
  const agent = {}; runtime.contexts.set(agent, { scope: 'c2c' }); const files = new WeakMap([[agent, new Set([realpathSync(own)])]]);
  let calls = 0; const tool = wrapVisionDefinition({ execute: async () => { calls++; return { text: 'cat' }; } }, runtime, files);
  assert.equal((await tool.execute({ image: own }, { agent })).text, 'cat');
  await assert.rejects(tool.execute({ image: other }, { agent }), /不属于/u);
  await assert.rejects(tool.execute({ image: 'https://example.com/a.png' }, { agent }), /当前消息/u);
  await assert.rejects(tool.execute({ image: own }, { agent: {} }), /当前消息/u);
  assert.equal(calls, 1);
});
