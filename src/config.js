import Schema from '@deepseek-ai/schemastery';
import { loadUpstream } from './upstream.js';

const { ConfigSchema } = await loadUpstream();
export const Config = Schema.intersect([
  ConfigSchema,
  Schema.object({
    enabled: Schema.boolean().default(false).description('启用前停用原 QQ 接入并填写测试 OpenID 白名单'),
    companion: Schema.object({
      dataDir: Schema.string().default('').description('独立运行数据目录，升级时保留'),
      persona: Schema.string().default('自然、温和、有自己的兴趣。根据共同经历交流；没有依据时不假装记得。'),
      maxMessages: Schema.number().min(1).max(4).step(1).default(3),
      intervalMs: Schema.number().min(0).max(10000).default(1200),
      autoMemory: Schema.boolean().default(true).description('自动整理有原文证据的兴趣、偏好与约定，可在聊天中关闭'),
      turnTimeoutMs: Schema.number().min(1000).max(300000).default(120000),
    }).default({}),
    voice: Schema.object({
      enabled: Schema.boolean().default(false),
      baseUrl: Schema.string().default('http://127.0.0.1:8765'),
      voice: Schema.string().default('huayan'),
      maxChars: Schema.number().min(1).max(300).default(120),
    }).default({}),
    video: Schema.object({
      enabled: Schema.boolean().default(true),
      ffmpegPath: Schema.string().default('ffmpeg'),
      frames: Schema.number().min(1).max(6).step(1).default(3),
      maxSeconds: Schema.number().min(1).max(600).default(180),
    }).default({}),
    bilibili: Schema.object({ enabled: Schema.boolean().default(true) }).default({}),
  }),
]);

export function validateLiveConfig(config) {
  if (!config.appId || !config.appSecret || config.appId === '__FROM_ENV__' || config.appSecret === '__FROM_ENV__') {
    throw new Error('请在本机设置中填写官方机器人 AppID 和 AppSecret。');
  }
  for (const scope of ['c2c', 'group']) {
    if (config.access[`${scope}Mode`] === 'open') throw new Error('P0 仅允许测试白名单；请填写官方 OpenID。');
    const list = config.access[`${scope}Allow`];
    if (list.some(id => !id || id === '*' || /^[0-9]+$/u.test(id))) throw new Error('白名单必须填写官方 OpenID，不能使用群号/QQ号或通配符。');
  }
  if (!['c2c', 'group'].some(scope => config.access[`${scope}Mode`] === 'allowlist' && config.access[`${scope}Allow`].length)) {
    throw new Error('至少需要一个测试 OpenID。');
  }
  if (config.streaming) throw new Error('P0 使用离散短消息，请关闭 streaming。');
}

export function admits(config, message) {
  const scope = message.kind === 'group' ? 'group' : message.kind === 'c2c' ? 'c2c' : null;
  if (!scope || config.access[`${scope}Mode`] !== 'allowlist') return false;
  const target = scope === 'group' ? message.groupOpenid : message.senderId;
  return config.access[`${scope}Allow`].includes(target);
}
