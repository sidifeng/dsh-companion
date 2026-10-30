import { createHash } from 'node:crypto';

export function requireId(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
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
