import { QQBot, messageFilter, mentionGate, contentSanitizer } from '@tencent-connect/qqbot-nodejs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadUpstream } from './upstream.js';
import { CompanionRuntime } from './runtime.js';
import { admits, validateLiveConfig } from './config.js';
import { conversation, partition, opaqueId, envelope, normalizeCommandMentions } from './identity.js';
import { attachmentMiddleware } from './media.js';
import { consolidateMemory } from './memory.js';
import { registerFeatures } from './features.js';
import { cleanupMedia } from './video.js';
import { AutonomyStore } from './autonomy-store.js';
import { AutonomyEngine, createAutonomyTasks } from './autonomy.js';
import { DialogueStore, DialogueContext } from './dialogue.js';
import { LocalEmbedder, SemanticMemory } from './semantic.js';
import { appraiseInteraction } from './appraisal.js';
import { TurnScheduler } from './pacing.js';

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
  const runtime = new CompanionRuntime({ database: join(dataDir, 'memory.sqlite'), ...config.companion, biology: config.biology });
  const allowedFiles = new WeakMap();
  const fileKinds = new WeakMap();
  const active = new Map();
  const sentEvents = new WeakSet();
  const toolNames = [];
  const register = definition => {
    ctx.get('tools').register({ ...definition, async execute(args, exec) {
      const e = runtime.contexts.get(exec.agent);
      e?.signal?.throwIfAborted();
      if (e) e.toolStarted = true;
      return definition.execute(args, exec);
    } });
    toolNames.push(definition.name); runtime.toolNames.add(definition.name);
  };
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
  let observeVideo = () => {};
  const features = registerFeatures({ ctx, runtime, config, directory: mediaDir, transport, files: fileKinds, vision, register, observeVideo: (...args) => observeVideo(...args) });
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
  runtime.appraise = e => appraiseInteraction(runtime, e, ctx.get('llm'), manager.getEffectiveModel(e.scope, peerKey(e)));
  const dialogueStore = new DialogueStore(join(dataDir, 'dialogue.sqlite'), config.dialogue);
  const dialogue = new DialogueContext(dialogueStore, () => ctx.get('llm'), () => manager.getEffectiveModel('group', 'dialogue'), Date.now, runtime.store);
  if (config.dialogue.enabled) runtime.dialogue = dialogue;
  const embedder = config.semantic.enabled ? (dependencies.embedder ?? new LocalEmbedder(config.semantic.modelDir || join(dataDir, 'models'))) : undefined;
  if (embedder) { runtime.semantic = new SemanticMemory(runtime.store, embedder, config.semantic); void embedder.start?.().catch(() => logger.warn('companion: 本机语义模型尚未就绪，暂用文字匹配；可查看 /记忆状态。')); }
  const indexingStop = new AbortController(); let indexing; let ownerCursor = 0;
  const indexTick = () => {
    if (!runtime.semantic || indexing || stopping || pacing.size || embedder.status === 'unavailable') return;
    const owners = runtime.store.memoryOwners().filter(([app, scope, target]) => app === config.appId && config.access[`${scope}Allow`]?.includes(target));
    if (!owners.length) return;
    const [appId, scope, targetId, senderId] = owners[ownerCursor++ % owners.length];
    indexing = runtime.semantic.index({ appId, scope, targetId, senderId, signal: indexingStop.signal }).catch(() => {}).finally(() => { indexing = undefined; });
  };
  const indexingTimer = setInterval(indexTick, 60000); indexingTimer.unref?.();
  const indexingStart = setTimeout(indexTick, 10000); indexingStart.unref?.();
  const autonomyStore = new AutonomyStore(join(dataDir, 'autonomy.sqlite'), config.appId);
  observeVideo = (video, evidence) => {
    try {
      if (!autonomyStore.claimVideo(video.bvid, Date.now())) return;
      autonomyStore.saveExperience(video, { summary: evidence.frames.map(f => `${f.seconds}秒：${f.text}`).join('\n').slice(0, 450), reaction: '', shareworthy: false }, { ...evidence, origin: 'requested' }, Date.now());
    } catch { logger.warn('companion: 本次点播浏览记录未保存。'); }
  };
  const autonomy = new AutonomyEngine({ config, store: autonomyStore, memory: runtime.store,
    dialogue: config.dialogue.enabled ? dialogue : undefined,
    tasks: dependencies.autonomyTasks ?? createAutonomyTasks({ ctx, config, vision, directory: mediaDir, route: () => manager.getEffectiveModel('group', 'autonomy') }),
    busy: (scope, targetId) => pacing.busy({ appId: config.appId, scope, targetId }),
    permission: async (target, signal) => {
      try {
        const token = await bot.tokenManager.getAccessToken(config.appId, config.appSecret); signal.throwIfAborted();
        const result = await bot.apiClient.request(token, 'GET', `/v2/groups/${encodeURIComponent(target)}/bot_state`, undefined, { timeoutMs: 10000 });
        return typeof result.allow_proactive_msg === 'boolean' ? result.allow_proactive_msg : undefined;
      } catch { signal.throwIfAborted(); return undefined; }
    },
    push: async ({ scope, targetId, text, sequence, signal }) => {
      signal.throwIfAborted();
      // 独立主动消息，绝不复用/伪造入站 msg_id，也不占用被动回复序号。
      await bot.send({ target: { scope, targetId }, msgType: 0, content: text, extra: { msg_seq: sequence } });
      runtime.store.observe(scope, 'send:proactive', 'verified');
    },
  });
  runtime.autonomyContext = e => ({ experiences: autonomyStore.experiences(3),
    recentProactive: autonomyStore.history(`chat:${e.scope}`, e.targetId, 3).filter(r => r.state === 'sent') });
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
      void runtime.sendText(e, text, transport, { generated: true }).catch(() => logger.warn('companion: 回复已阻止或发送失败。'));
    }
  }, { global: true });

  // 空白名单拒绝所有消息；不沿用上游空列表回退为 '*' 的行为。
  bot.use(async (mCtx, next) => { if (!stopping && admits(config, mCtx.message)) await next(); });
  bot.use(messageFilter({ skipSelfEcho: true }));
  bot.use(async (mCtx, next) => {
    const m = mCtx.message;
    pacing.noteSpeaker(envelope(config.appId, m));
    autonomy.noteActivity(m.kind, m.kind === 'group' ? m.groupOpenid : m.senderId);
    if (config.dialogue.enabled && m.kind === 'group' && !m.senderIsBot) {
      try { const e = envelope(config.appId, m); if (runtime.store.profile(e).auto_memory) dialogueStore.observe(e); } catch { /* 格式不完整的群消息不进入上下文。 */ }
    }
    await next();
  });
  bot.use(mentionGate({ requireMentionInGroup: config.requireMention }));
  bot.use(contentSanitizer({ parseFaceTags: true, transform: (text, mCtx) => normalizeCommandMentions(text, mCtx.message, mCtx.state.mention?.wasMentioned) }));
  const pacing = new TurnScheduler({
    windowMs: config.companion.burstWindowMs, maxQueue: config.maxQueue,
    finish: (e, state) => runtime.store.finish(e, state),
    canReplace: e => !e.toolStarted && !runtime.store.used(e) && !e.responseComplete,
    run: async ({ mCtx, next }, e, controller) => {
      if (stopping) return 'stopped';
      const turn = { controller, agent: undefined };
      active.set(partition(e), turn);
      mCtx.message = { ...mCtx.message, content: e.text };
      mCtx.state.signal = e.signal; mCtx.state.companionEnvelope = e;
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
      try { await Promise.race([next(), aborted]); return e.modelFailed ? 'model-failed' : 'handled'; }
      catch (error) {
        if (e.signal.aborted) runtime.store.resetContext(e);
        else logger.error('companion: 本轮处理失败，未自动重放。');
        if (!stopping && !['USER_CANCELLED', 'SUPERSEDED'].includes(e.signal.reason?.message)) await runtime.sendText({ ...e, signal: undefined }, '这次处理没有完成，请稍后再试。', transport);
        throw error;
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
    },
  });
  bot.use(async (mCtx, next) => {
    const e = runtime.receive(config.appId, mCtx.message);
    if (!e) return;
    if (e.text.trim() === '/取消') {
      const count = pacing.cancel(e);
      await runtime.sendText(e, count ? '已取消你正在处理和排队的任务。已经发出的消息无法撤回。' : '你当前没有正在处理的任务。', transport);
      runtime.store.finish(e); return;
    }
    await pacing.enqueue({ e, mCtx, next });
  });
  bot.use(attachmentMiddleware(config, runtime, mediaDir));
  bot.on('message', async mCtx => {
    const e = mCtx.state.companionEnvelope;
    e.signal.throwIfAborted();
    const autonomyCommand = await autonomy.command(e);
    if (autonomyCommand !== null) { await runtime.sendText(e, autonomyCommand, transport); return; }
    if (/^\/找记忆\s+/u.test(e.text)) {
      const query = e.text.replace(/^\/找记忆\s+/u, '');
      const rows = runtime.semantic ? await runtime.semantic.recall(e, query) : runtime.store.recall(e, query).filter(r => r.score > 0);
      await runtime.sendText(e, rows.length ? rows.map(r => `${r.id}：${r.text}`).join('\n') : '没有找到足够相关的已保存记忆。', transport); return;
    }
    if (e.text.trim() === '/记忆状态') {
      await runtime.sendText(e, `语义检索：${embedder?.status === 'ready' && runtime.semantic?.mode !== 'fallback' ? '本机模型已就绪' : config.semantic.enabled ? '暂用文字匹配，本机模型需检查' : '未启用'}。当前聊天有 ${runtime.store.memoryRows(e).length} 条已保存资料。`, transport); return;
    }
    if (/^\/群话题(?:\s|$)/u.test(e.text)) {
      const administrator = e.scope === 'c2c' && config.autonomy.operatorIds.includes(e.senderId);
      if (!config.dialogue.enabled) { await runtime.sendText(e, '群话题理解未启用。', transport); return; }
      const target = e.scope === 'group' ? e : administrator && config.access.groupAllow.length === 1 ? { ...e, scope: 'group', targetId: config.access.groupAllow[0] } : undefined;
      if (!target) { await runtime.sendText(e, '请在目标群 @我 查看话题；只有管理员可在私聊中调整。', transport); return; }
      const action = e.text.trim().split(/\s/u)[1];
      if (['开', '关', '清空'].includes(action)) {
        if (!administrator) { await runtime.sendText(e, '群话题设置由管理员在私聊调整。', transport); return; }
        if (action === '清空') dialogueStore.clear(target); else dialogueStore.setEnabled(target, action === '开');
        await runtime.sendText(e, action === '清空' ? '已清空测试群的近期话题上下文。' : `群话题理解已${action === '开' ? '开启' : '关闭并清空' }。`, transport); return;
      }
      const context = await dialogue.prepare(target);
      let summary; try { summary = JSON.parse(context?.summary || '{}').summary; } catch { /* 无摘要 */ }
      await runtime.sendText(e, summary || (context?.messages.length ? '已收到近期群消息，话题摘要暂未整理好。正常聊天仍会参考这些消息。' : '还没有收到可用的近期群话题。'), transport); return;
    }
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
    await runtime.prepare(e);
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
      e.responseComplete = true;
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
  bot.on('rawEvent', raw => {
    const names = { GROUP_MSG_REJECT: ['group', true], GROUP_DEL_ROBOT: ['group', true], GROUP_MSG_RECEIVE: ['group', false], C2C_MSG_REJECT: ['c2c', true], FRIEND_DEL: ['c2c', true], C2C_MSG_RECEIVE: ['c2c', false] };
    const entry = names[raw.eventType]; if (!entry) return;
    const [scope, blocked] = entry; const target = scope === 'group' ? raw.data?.group_openid : raw.data?.openid;
    if (!config.access[`${scope}Allow`].includes(target)) return;
    autonomyStore.block(scope, target, blocked ? 'PLATFORM_REJECTED' : '');
    if (blocked) autonomy.operation?.abort(new Error('PLATFORM_REJECTED'));
  });
  let closing;
  const close = () => closing ??= (async () => {
    stopping = true; bot.stop();
    clearInterval(autonomyTimer); clearTimeout(autonomyStart);
    clearInterval(indexingTimer); clearTimeout(indexingStart); indexingStop.abort(); await indexing;
    const turnsClosed = pacing.close();
    await autonomy.close();
    await manager.disposeAll();
    await turnsClosed;
    await runtime.close();
    await Promise.allSettled([...dialogue.pending.values()]); dialogueStore.close(); await embedder?.close();
    autonomyStore.close();
  })();
  ctx.effect(() => {
    const clean = () => void cleanupMedia(mediaDir).catch(() => {});
    clean(); const timer = setInterval(() => { clean(); dialogueStore.prune(); }, 3600000); timer.unref?.();
    return () => clearInterval(timer);
  }, 'companion.media-cleanup');
  const autoTick = () => { if (!stopping) void autonomy.run().catch(() => logger.warn('companion: 自主活动本轮失败，未自动重试发送。')); };
  const autonomyTimer = setInterval(autoTick, 60000); autonomyTimer.unref?.();
  const autonomyStart = setTimeout(autoTick, 20000); autonomyStart.unref?.();
  ctx.effect(() => { void bot.start().catch(() => logger.error('companion: QQ 启动失败。')); return close; }, 'companion.gateway');
  return { runtime, bot, manager, autonomy, dialogue, close };
}
