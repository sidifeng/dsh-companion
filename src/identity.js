import { createHash } from 'node:crypto';

export function requireId(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

// 官方群 @ 标记可能使用机器人 OpenID，而非 AppID。只在上游已确认 @ 后
// 清理命令两侧的标记；正文不能借标记绕过 mentionGate 或改变身份。
export function normalizeCommandMentions(text, message, wasMentioned) {
  if (message.kind !== 'group' || !wasMentioned) return text;
  const command = text.replace(/^(?:\s*<@!?[A-Za-z0-9_-]{1,256}>\s*)+/u, '')
    .replace(/(?:\s*<@!?[A-Za-z0-9_-]{1,256}>\s*)+$/u, '').trim();
  return /^(?:\/|记住[：:])/u.test(command) ? command : text;
}

// 不从正文/昵称提取身份；只接收 SDK 规范化后的结构化字段。
export function envelope(appId, message, now = Date.now()) {
  requireId(appId, 'appId');
  const scope = message.kind === 'group' ? 'group' : message.kind === 'c2c' ? 'c2c' : null;
  if (!scope) throw new Error('Unsupported QQ message scope');
  const senderId = requireId(message.senderId, 'senderId');
  const targetId = scope === 'group' ? requireId(message.groupOpenid, 'groupOpenid') : senderId;
  const eventId = requireId(message.messageId, 'messageId');
  const rawTime = message.timestamp;
  const parsed = typeof rawTime === 'number' ? (rawTime < 1e12 ? rawTime * 1000 : rawTime) : Date.parse(rawTime);
  const receivedAt = Number.isFinite(parsed) ? Math.min(parsed, now) : now;
  return Object.freeze({ appId, scope, targetId, senderId, eventId, receivedAt,
    text: typeof message.content === 'string' ? message.content : '',
    attachments: Array.isArray(message.attachments) ? message.attachments : [] });
}

export function partition(e) {
  return JSON.stringify([e.appId, e.scope, e.targetId, e.senderId]);
}

export function conversation(e) {
  return JSON.stringify([e.appId, e.scope, e.targetId]);
}

export function eventKey(e) {
  return JSON.stringify([e.appId, e.scope, e.targetId, e.eventId]);
}

export function opaqueId(value) {
  return createHash('sha256').update(value).digest('hex');
}
