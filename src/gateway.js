import { QQBot, messageFilter, mentionGate, contentSanitizer } from '@tencent-connect/qqbot-nodejs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadUpstream } from './upstream.js';
import { CompanionRuntime } from './runtime.js';
import { admits, validateLiveConfig } from './config.js';
import { conversation, partition, opaqueId } from './identity.js';
import { attachmentMiddleware } from './media.js';
import { consolidateMemory } from './memory.js';
import { registerFeatures } from './features.js';
import { cleanupMedia } from './video.js';

export function createTransport(bot, store) {
  return async (message, target) => {
    target.signal?.throwIfAborted();
    const replyTarget = { scope: target.scope, targetId: target.targetId, msgId: target.msgId };
    let media;
    if (message.kind !== 'text') {
      const fileType = { image: 1, video: 2, voice: 3 }[message.kind];
      if (!fileType || !message.localPath) throw new Error('Unsupported media');
      const uploaded = await bot.uploadMedia({ target: replyTarget, fileType, localPath: message.localPath, srvSendMsg: false });
      if (!uploaded.file_info) throw new Error('Missing file_info');
      media = { file_info: uploaded.file_info };
    }
    target.signal?.throwIfAborted();
    if (target.expiresAt !== undefined && Date.now() >= target.expiresAt) throw new Error('Reply expired during upload');
    // 显式使用持久化序号，避免 SDK 的内存序号在重启后归零。
    await bot.send({ target: replyTarget, msgType: media ? 7 : 0,
      ...(media ? { media } : { content: message.text }), extra: { msg_seq: target.sequence } });
    store.observe(target.scope, `send:${message.kind}`, 'verified');
  };
}

export function wrapVisionDefinition(definition, runtime, allowedFiles) {
  return { ...definition, name: 'companion_describe_image',
    description: '理解当前 QQ 消息中已下载的图片。image 必须是本轮附件的本地路径。',
    async execute(args, exec) {
      const e = runtime.contexts.get(exec.agent);
      if (!e || typeof args.image !== 'string' || /^https?:/iu.test(args.image)) throw new Error('只能读取当前消息的图片附件。');
      const file = realpathSync(args.image);
      if (!allowedFiles.get(exec.agent)?.has(file)) throw new Error('图片不属于当前消息。');
      const signal = AbortSignal.any([e.signal, exec.signal].filter(Boolean));
      signal.throwIfAborted();
      const result = await definition.execute({ ...args, image: file }, { ...exec, signal });
      signal.throwIfAborted();
      runtime.store.observe(e.scope, 'understand:image', 'verified');
      return result;
    } };
}

export async function startGateway(ctx, config, dependencies = {}) {
  validateLiveConfig(config);
  const upstream = dependencies.upstream ?? await loadUpstream();
  const logger = ctx.logger ?? console;
  const dataDir = config.companion.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'companion', opaqueId(config.appId));
  const runtime = new CompanionRuntime({ database: join(dataDir, 'memory.sqlite'), ...config.companion });
  const allowedFiles = new WeakMap();
  const fileKinds = new WeakMap();
  const active = new Map();
  const pending = new Map();
  const queued = new Map();
  const sentEvents = new WeakSet();
  const toolNames = [];
  const register = definition => { ctx.get('tools').register(definition); toolNames.push(definition.name); runtime.toolNames.add(definition.name); };
  runtime.toolNames.clear();
  let stopping = false;
  const bot = dependencies.bot ?? new QQBot({ appId: config.appId, appSecret: config.appSecret,
    transport: 'websocket', baseUrl: 'https://api.bot.qq.com', tokenBaseUrl: 'https://bots.qq.com', logger });
  const transport = createTransport(bot, runtime.store);
  const safeLogger = { info() {}, debug() {}, warn() { logger.warn('companion: 上游处理出现警告，请运行本地诊断。'); }, error() { logger.error('companion: 上游处理失败。'); } };

  // 复用视觉实现，但把图片路径权限收窄到本轮附件。
  let vision;
  const visionCtx = { get(service) {
    if (service !== 'tools') return ctx.get(service);
    return { register(definition) {
      vision = definition;
      register(wrapVisionDefinition(definition, runtime, allowedFiles));
    } };
  } };
  upstream.registerDescribeImageTool(visionCtx, config.vision, safeLogger);
  const mediaDir = join(dataDir, 'media');
  const features = registerFeatures({ ctx, runtime, config, directory: mediaDir, transport, files: fileKinds, vision, register });
  const peerKey = e => {
    const profile = runtime.store.profile(e);
    // 每 24 次已整理交流换一段上下文；跨段资料从长期记忆召回，限制上下文增长。
    return JSON.stringify([e.targetId, e.senderId, profile.epoch, Math.floor(profile.interactions / 24)]);
  };

  class CompanionSessions extends upstream.SessionManager {
    sessionKey(scope, peerId) { return `companion:v2:${config.appId}:${scope}:${peerId}`; }
    async composePreset() {
      return { setup: async agentCtx => {
        const tools = agentCtx.get('tools');
        if (!tools?.restrict || !tools?.guard) throw new Error('宿主缺少按会话限制工具的接口。');
        tools.restrict({ allow: toolNames });
        tools.guard(exec => toolNames.includes(exec.name) ? undefined : 'QQ 聊天未启用这个工具。');
      } };
    }
  }
  const manager = new CompanionSessions(ctx, ctx.agents, { ...config, preset: undefined }, safeLogger);
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => runtime.assemble(await next(), context.agent), { global: true });
  ctx.on('session/event', (session, event) => {
    const e = runtime.sessions.get(session.header.id);
    if (e?.signal?.aborted) return;
    if (e && event.type === 'turn/end' && event.data?.reason?.kind === 'error') {
      e.modelFailed = true;
      runtime.store.observe(e.scope, 'model:reply', 'failed');
      const code = event.data.reason.error?.code ?? event.data.reason.failure?.code ?? 'UNKNOWN';
      logger.warn(`companion: 模型轮次失败 (${String(code).replace(/[^A-Z0-9_]/gu, '').slice(0, 60)})`);
      void runtime.sendText(e, '这次没能回复成功，请稍后再试一下。', transport).catch(() => {});
      return;
    }
    if (!e || event.type !== 'assistant/message' || sentEvents.has(event)) return;
    sentEvents.add(event);
    const text = event.data?.message?.content?.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (text) {
      runtime.store.observe(e.scope, 'model:reply', 'verified');
      void runtime.sendText(e, text, transport).catch(() => logger.warn('companion: 回复已阻止或发送失败。'));
    }
  }, { global: true });

  // 空白名单拒绝所有消息；不沿用上游空列表回退为 '*' 的行为。
  bot.use(async (mCtx, next) => { if (!stopping && admits(config, mCtx.message)) await next(); });
  bot.use(messageFilter({ skipSelfEcho: true }));
  bot.use(mentionGate({ requireMentionInGroup: config.requireMention }));
  bot.use(contentSanitizer({ parseFaceTags: true }));
  // 同群不同人的事件逐条处理，禁止 merge 后丢失真正的发送者。
  bot.use(async (mCtx, next) => {
    const received = runtime.receive(config.appId, mCtx.message);
    if (!received) return;
    const e = { ...received };
    if (e.text.trim() === '/取消') {
      const running = active.get(partition(e));
      running?.controller.abort(new Error('USER_CANCELLED'));
      await runtime.sendText(e, running ? '已取消你当前的任务。已经发出的消息无法撤回。' : '你当前没有正在处理的任务。', transport);
      runtime.store.finish(e); return;
    }
    const key = conversation(e);
    if ((queued.get(key) ?? 0) >= config.maxQueue) { runtime.store.finish(e, 'queue-full'); return; }
    queued.set(key, (queued.get(key) ?? 0) + 1);
    const task = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (stopping) { runtime.store.finish(e, 'stopped'); return; }
      const controller = new AbortController();
      const turn = { controller, agent: undefined };
      active.set(partition(e), turn);
      e.signal = controller.signal; mCtx.state.signal = e.signal;
      mCtx.state.companionEnvelope = e;
      let abortListener;
      const aborted = new Promise((_, reject) => {
        abortListener = () => {
          turn.agent?.cancel({ kind: 'user' });
          if (turn.agent) runtime.unbind(turn.agent);
          reject(controller.signal.reason);
        };
        controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      const timer = setTimeout(() => controller.abort(new Error('TURN_TIMEOUT')), config.companion.turnTimeoutMs);
      try { await Promise.race([next(), aborted]); runtime.store.finish(e, e.modelFailed ? 'model-failed' : 'handled'); }
      catch {
        runtime.store.finish(e, e.signal.aborted ? 'cancelled' : 'failed');
        if (e.signal.aborted) runtime.store.resetContext(e);
        else logger.error('companion: 本轮处理失败，未自动重放。');
        if (!stopping && e.signal.reason?.message !== 'USER_CANCELLED') await runtime.sendText({ ...e, signal: undefined }, '这次处理没有完成，请稍后再试。', transport);
      } finally {
        clearTimeout(timer); controller.signal.removeEventListener('abort', abortListener);
        if (active.get(partition(e)) === turn) active.delete(partition(e));
        if (turn.agent) {
          runtime.unbind(turn.agent); allowedFiles.delete(turn.agent); fileKinds.delete(turn.agent);
          if (e.signal.aborted) {
            const record = manager.findByAgent(turn.agent);
            if (record) { manager.sessions.delete(record.sessionKey); void record.handle.dispose().catch(() => {}); }
          }
        }
      }
    });
    pending.set(key, task);
    try { await task; } finally {
      const remaining = (queued.get(key) ?? 1) - 1;
      if (remaining) queued.set(key, remaining); else queued.delete(key);
      if (pending.get(key) === task) pending.delete(key);
    }
  });
  bot.use(attachmentMiddleware(config, runtime, mediaDir));
  bot.on('message', async mCtx => {
    const e = mCtx.state.companionEnvelope;
    e.signal.throwIfAborted();
    if (/^\/语音(?:\s|$)/u.test(e.text)) {
      try { await features.speak(e, e.text.replace(/^\/语音\s*/u, ''), e.signal); }
      catch { if (!e.signal.aborted) await runtime.sendText(e, `语音未发送成功，请检查本机语音服务；单次请控制在 ${config.voice.maxChars} 字内。`, transport); }
      return;
    }
    if (e.text.trim() === '/唱歌' && !config.singing.enabled) { await runtime.sendText(e, '我还没有启用歌声合成引擎，目前能发普通语音。', transport); return; }
    if (e.text.trim() === '/回传附件') {
      const media = (mCtx.state.downloadedFiles ?? []).flatMap(file => {
        const kind = file.contentType;
        return kind ? [{ kind, localPath: file.localPath }] : [];
      });
      if (media.length) await runtime.queue.send(e, media, transport);
      else await runtime.sendText(e, '没有可回传的已下载图片或视频；语音附件需要另行验证下载格式。', transport);
      return;
    }
    let command;
    try { command = runtime.command(e); } catch { command = '记忆内容需要 1～2000 字，请缩短后重试。'; }
    if (command !== null) { await runtime.sendText(e, command, transport); return; }
    let currentAgent;
    const facade = { async getOrCreate(...args) {
      e.signal.throwIfAborted(); args[1] = peerKey(e);
      const record = await manager.getOrCreate(...args);
      if (e.signal.aborted) {
        manager.sessions.delete(record.sessionKey); void record.handle.dispose().catch(() => {});
        e.signal.throwIfAborted();
      }
      currentAgent = record.agent;
      active.get(partition(e)).agent = record.agent;
      runtime.bind(record.agent, e);
      const files = new Set();
      const kinds = new Map();
      for (const file of mCtx.state.downloadedFiles ?? []) {
        try { const path = realpathSync(file.localPath); kinds.set(path, file.contentType); if (file.contentType === 'image') files.add(path); } catch { /* 下载失败不授权路径。 */ }
      }
      allowedFiles.set(record.agent, files);
      fileKinds.set(record.agent, kinds);
      return record;
    } };
    try {
      await upstream.handleInbound({ ...mCtx, bot: { sendMarkdown: (_target, text) => runtime.sendText(e, text, transport) } }, facade, config, safeLogger);
      await runtime.queue.tails.get(conversation(e));
      e.signal.throwIfAborted();
      const llm = ctx.get('llm');
      if (!e.modelFailed && llm?.stream) {
        try { await consolidateMemory(runtime, e, llm, manager.getEffectiveModel(e.scope, peerKey(e)), e.signal); }
        catch { if (!e.signal.aborted) logger.warn('companion: 本轮自动记忆整理未完成，原有记忆保留。'); }
      }
    } finally {
      if (currentAgent) { runtime.unbind(currentAgent); allowedFiles.delete(currentAgent); fileKinds.delete(currentAgent); }
    }
  });
  bot.on('ready', () => { runtime.store.observe('bot', 'connection', 'verified'); logger.info('companion: 官方 QQ 连接已就绪。'); });
  bot.on('error', () => { logger.error('companion: QQ 连接或 API 出错，请运行本地诊断。'); });
  let closing;
  const close = () => closing ??= (async () => {
    stopping = true; bot.stop();
    for (const turn of active.values()) turn.controller.abort(new Error('SHUTDOWN'));
    await manager.disposeAll();
    await Promise.allSettled([...pending.values()]);
    await runtime.close();
  })();
  ctx.effect(() => {
    const clean = () => void cleanupMedia(mediaDir).catch(() => {});
    clean(); const timer = setInterval(clean, 3600000); timer.unref?.();
    return () => clearInterval(timer);
  }, 'companion.media-cleanup');
  ctx.effect(() => { void bot.start().catch(() => logger.error('companion: QQ 启动失败。')); return close; }, 'companion.gateway');
  return { runtime, bot, manager, close };
}
