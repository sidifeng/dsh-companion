import { conversation } from './identity.js';
import { setTimeout as delay } from 'node:timers/promises';

export function requestedParts(text) {
  const match = /(?:分(?:成|为)?|用)\s*([一二两三四1-4])\s*(?:条|句|段)/u.exec(text);
  return match ? ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4 }[match[1]] ?? Number(match[1])) : undefined;
}

export function planMessages(text, maximum = 3, maxChars = 1800, desiredParts) {
  const value = String(text).trim();
  if (!value) return [];
  // 只在自然段边界拆分；长段落先按完整 Unicode 字符切片。
  let paragraphs = value.split(/\n\s*\n/u);
  const wanted = Math.min(desiredParts ?? 1, maximum);
  if (wanted > paragraphs.length && !value.includes('```')) {
    const sentences = value.match(/[^。！？!?\n]+[。！？!?]+[”’」』]?|[^。！？!?\n]+(?:\n|$)/gu) ?? [value];
    if (sentences.length >= wanted) {
      paragraphs = Array.from({ length: wanted }, (_, i) => sentences.slice(Math.floor(i * sentences.length / wanted), Math.floor((i + 1) * sentences.length / wanted)).join(''));
    }
  }
  const chunks = paragraphs.flatMap(part => {
    const chars = Array.from(part.trim());
    return Array.from({ length: Math.ceil(chars.length / maxChars) }, (_, i) => chars.slice(i * maxChars, (i + 1) * maxChars).join(''));
  }).filter(Boolean);
  if (chunks.length <= maximum) return chunks;
  const head = chunks.slice(0, maximum - 1);
  const tail = chunks.slice(maximum - 1).join('\n\n');
  // 预算不足不悄悄丢掉尾文：明确要求上层缩短回复，不发送半段答案。
  if (Array.from(tail).length > maxChars) throw new Error('回复过长，请缩短后重试。');
  return [...head, tail];
}

export class ReplyQueue {
  constructor(store, { maximum = 3, intervalMs = 1200, now = Date.now, sleep = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
    this.store = store; this.maximum = maximum; this.intervalMs = intervalMs;
    this.now = now; this.sleep = sleep; this.tails = new Map(); this.lastSent = new Map(); this.closed = false;
  }
  send(e, messages, transport) {
    const key = conversation(e);
    const task = (this.tails.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const outcomes = [];
      for (const message of messages) {
        if (this.closed || e.signal?.aborted) break;
        const gap = this.intervalMs - (this.now() - (this.lastSent.get(key) ?? -Infinity));
        if (gap > 0) {
          try { await this.sleep(gap, e.signal); } catch (error) { if (e.signal?.aborted) break; throw error; }
        }
        if (this.closed || e.signal?.aborted) break;
        const sequence = this.store.reserve(e, Math.min(4, this.maximum), this.now());
        if (sequence === null) { outcomes.push({ status: 'blocked', reason: 'budget-or-expired' }); break; }
        this.lastSent.set(key, this.now());
        try {
          await transport(message, { scope: e.scope, targetId: e.targetId, msgId: e.eventId, sequence, signal: e.signal,
            expiresAt: e.receivedAt + (e.scope === 'group' ? 300_000 : 3_600_000) });
          outcomes.push({ status: 'sent', sequence });
        } catch {
          // 已扣额度不退回：超时可能已经送达，不能换序号自动重发。
          outcomes.push({ status: 'uncertain', sequence });
          break;
        }
      }
      return outcomes;
    });
    this.tails.set(key, task);
    task.finally(() => { if (this.tails.get(key) === task) this.tails.delete(key); }).catch(() => {});
    return task;
  }
  async close() { this.closed = true; await Promise.allSettled([...this.tails.values()]); }
}
