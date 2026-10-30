import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt, { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { createScope } from '@deepseek-ai/dsh-scope';
import { CompanionRuntime } from '../src/runtime.js';
import { envelope } from '../src/identity.js';
import { createTransport } from '../src/gateway.js';
import { loadUpstream } from '../src/upstream.js';

test('真实 Cordis + DSH 提示词 waterfall 可以逐轮注入，普通会话不受影响', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  const runtime = new CompanionRuntime({ database: ':memory:', persona: '你好，保持自然。' }); t.after(() => runtime.close());
  const agent = { id: 'qq-test' };
  const e = envelope('bot', { kind: 'c2c', senderId: 'a', messageId: 'm', content: '记住：周六一起看电影 {{not_a_prompt_variable}}' });
  runtime.command(e); runtime.bind(agent, e);
  ctx.on('system-prompt/assemble', async (_a, context, next) => runtime.assemble(await next(), context.agent), { global: true });
  const result = await ctx.systemPrompt.assemble({ agent });
  assert.match(renderPrompt(result), /保持自然/u);
  assert.match(renderContextSnapshot(result), /周六/u);
  assert.match(renderContextSnapshot(result), /\{\{not_a_prompt_variable\}\}/u);
  assert.doesNotMatch(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: {} })), /周六/u);
  const restricted = runtime.assemble({ sections: [{ name: 'host:coding', text: 'Run terminal' }], contexts: [{ name: 'host:cwd', text: 'Private path' }], tools: [{ name: 'ops_discover_tools' }, { name: 'companion_describe_image' }] }, agent);
  assert.deepEqual(restricted.tools.map(tool => tool.name), ['companion_describe_image']);
  assert.equal(restricted.sections.some(section => section.name === 'host:coding'), false);
  assert.equal(restricted.contexts.some(context => context.name === 'host:cwd'), false);
});

test('实际上游包的接口与版本可加载', async () => {
  const upstream = await loadUpstream();
  for (const key of ['SessionManager', 'handleInbound', 'ConfigSchema', 'attachmentProcessor', 'registerDescribeImageTool']) assert.equal(typeof upstream[key], 'function', key);
  assert.equal(typeof upstream.SessionManager.prototype.composePreset, 'function');
});

test('QQ transport 保留原消息 ID 和持久化序号，不走主动发送', async () => {
  let sent; const seen = [];
  const send = createTransport({ send: async data => { sent = data; } }, { observe: (...args) => seen.push(args) });
  await send({ kind: 'text', text: '你好' }, { scope: 'c2c', targetId: 'A', msgId: 'M', sequence: 3 });
  assert.equal(sent.target.msgId, 'M'); assert.equal(sent.extra.msg_seq, 3); assert.equal(sent.msgType, 0);
  assert.deepEqual(seen[0], ['c2c', 'send:text', 'verified']);
});

test('媒体先上传不自动投递，再带同一被动消息 ID 与序号发送', async () => {
  const calls = [];
  const bot = { uploadMedia: async data => { calls.push(['upload', data]); return { file_info: 'fixture' }; }, send: async data => calls.push(['send', data]) };
  await createTransport(bot, { observe() {} })({ kind: 'voice', localPath: 'fixture.wav' }, { scope: 'c2c', targetId: 'A', msgId: 'M', sequence: 2 });
  assert.equal(calls[0][1].srvSendMsg, false); assert.equal(calls[0][1].fileType, 3);
  assert.equal(calls[1][1].msgType, 7); assert.equal(calls[1][1].target.msgId, 'M'); assert.equal(calls[1][1].extra.msg_seq, 2);
});

test('上传期间回复过期，不发媒体消息', async () => {
  let sends = 0;
  const send = createTransport({ uploadMedia: async () => ({ file_info: 'fixture' }), send: async () => sends++ }, { observe() {} });
  await assert.rejects(send({ kind: 'image', localPath: 'fixture.png' }, { scope: 'group', targetId: 'G', msgId: 'M', sequence: 1, expiresAt: Date.now() - 1 }), /expired/u);
  assert.equal(sends, 0);
});

test('真实 DSH 工具注册表按会话限制，不影响管理员会话', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Tools, {});
  for (const name of ['fixture_shell', 'companion_describe_image']) ctx.tools.register({ name, description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, render: () => [{ type: 'text', text: 'OK' }] },
    execute: async () => ({ ok: true }) });
  const agent = {};
  await ctx.plugin({ name: 'test-tool-scope', inject: ['tools'], apply(pluginCtx) {
    const scope = createScope(pluginCtx, agent);
    scope.ctx.tools.restrict({ allow: ['companion_describe_image'] });
    scope.ctx.tools.guard(exec => exec.name === 'companion_describe_image' ? undefined : 'denied');
  } });
  assert.equal(ctx.tools.schemas(agent).some(t => t.name === 'fixture_shell'), false);
  assert.equal(ctx.tools.schemas().some(t => t.name === 'fixture_shell'), true);
  assert.equal(ctx.tools.guardReason({ agent, name: 'fixture_shell' }), 'denied');
});
