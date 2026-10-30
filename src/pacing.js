import { conversation, partition } from './identity.js';

const correction = /^(?:\s*<@!?[A-Za-z0-9_-]{1,256}>\s*)*(?:不对[，,：:、\s]|说错了|更正[一下：:，,\s]|纠正一下|改成|补充一下|等等[，,：:、\s]|先别回答)/u;
const plainText = e => Boolean(e.text.trim()) && e.text.length <= 2000 && !e.attachments.length
  && !/^(?:\s*<@!?[A-Za-z0-9_-]{1,256}>\s*)*(?:\/|记住[：:])/u.test(e.text);

// 只合并已通过官方 @ / 白名单检查的同一人文本。每个群仍严格串行。
// 一次合并只有最新真实消息的回复额度，不虚构 msg_id，不合并附件或命令。
export class TurnScheduler {
  constructor({ run, finish, canReplace, windowMs = 800, maxQueue = 10, now = Date.now }) {
    Object.assign(this, { run, finish, canReplace, windowMs, maxQueue, now });
    this.lanes = new Map(); this.closed = false;
  }
  get size() { return this.lanes.size; }
  busy(e) { return this.lanes.has(conversation(e)); }
  seal(job) { job.sealed = true; job.wake?.(); }
  noteSpeaker(e) {
    // 非 @ 群消息也能形成说话人边界，但不能借此触发机器人回复。
    const tail = this.lanes.get(conversation(e))?.jobs.at(-1);
    if (tail && tail.owner !== partition(e)) this.seal(tail);
  }
  enqueue(item) {
    if (this.closed) { this.finish(item.e, 'stopped'); return Promise.resolve(); }
    const key = conversation(item.e), owner = partition(item.e), now = this.now();
    let lane = this.lanes.get(key);
    const tail = lane?.jobs.at(-1);
    const eligible = this.windowMs > 0 && plainText(item.e) && !item.mCtx.state.quote;
    const fits = tail && tail.parts.length < 6 && tail.parts.join('\n').length + item.e.text.length < 2400;
    if (eligible && tail?.eligible && tail.owner === owner && !tail.sealed && fits && !tail.controller.signal.aborted) {
      if (!tail.running && now < tail.readyAt && now - tail.firstAt < 2000) {
        tail.items.push(item); tail.parts.push(item.e.text); tail.item = item;
        tail.readyAt = Math.min(now + this.windowMs, tail.firstAt + 2000); tail.wake?.();
        return tail.done;
      }
      if (tail.running && lane.jobs.length < this.maxQueue && now - tail.firstAt < 30000 && this.canReplace(tail.e)
        && (now - tail.firstAt < 2000 || correction.test(item.e.text))) {
        // 已应用的关系事件不因重算重复积累；已发出的内容在表达上下文中保留。
        item.carry = { parts: tail.parts, skipAppraisal: tail.e.skipAppraisal || tail.e.biologyStatus === 'ready', followup: tail.e.followup };
        tail.controller.abort(new Error('SUPERSEDED'));
      }
    }
    if (tail && !tail.running) this.seal(tail);
    if ((lane?.jobs.length ?? 0) >= this.maxQueue) { this.finish(item.e, 'queue-full'); return Promise.resolve(); }
    if (!lane) { lane = { jobs: [] }; this.lanes.set(key, lane); }
    const job = { owner, item, items: [item], carry: item.carry, parts: [...(item.carry?.parts ?? []), item.e.text], eligible,
      firstAt: now, readyAt: now + (eligible ? this.windowMs : 0), controller: new AbortController() };
    job.done = new Promise(resolve => { job.resolve = resolve; });
    lane.jobs.push(job);
    if (!lane.draining) lane.draining = this.drain(key, lane);
    return job.done;
  }
  async wait(job) {
    while (!job.sealed && !job.controller.signal.aborted && this.now() < job.readyAt) {
      await new Promise(resolve => {
        const wake = () => { clearTimeout(timer); job.controller.signal.removeEventListener('abort', wake); job.wake = undefined; resolve(); };
        const timer = setTimeout(wake, job.readyAt - this.now());
        job.wake = wake; job.controller.signal.addEventListener('abort', wake, { once: true });
      });
    }
  }
  async drain(key, lane) {
    try {
      while (lane.jobs.length) {
        const job = lane.jobs[0]; let state = 'handled';
        try {
          await this.wait(job); job.controller.signal.throwIfAborted();
          job.running = true;
          job.e = { ...job.item.e, text: job.parts.join('\n'), burstCount: job.parts.length,
            skipAppraisal: job.carry?.skipAppraisal, followup: job.carry?.followup, signal: job.controller.signal };
          state = await this.run(job.item, job.e, job.controller) ?? state;
        } catch {
          const reason = job.controller.signal.reason?.message;
          state = reason === 'SUPERSEDED' ? 'superseded' : reason === 'SHUTDOWN' ? 'stopped' : job.controller.signal.aborted ? 'cancelled' : 'failed';
        } finally {
          job.items.forEach((item, i) => this.finish(item.e, state === 'handled' && i < job.items.length - 1 ? 'merged' : state));
          lane.jobs.shift(); job.resolve();
        }
      }
    } finally { if (this.lanes.get(key) === lane) this.lanes.delete(key); }
  }
  cancel(e) {
    let count = 0;
    for (const job of this.lanes.get(conversation(e))?.jobs ?? []) if (job.owner === partition(e) && !job.controller.signal.aborted) {
      job.controller.abort(new Error('USER_CANCELLED')); count++;
    }
    return count;
  }
  async close() {
    this.closed = true;
    for (const lane of this.lanes.values()) for (const job of lane.jobs) job.controller.abort(new Error('SHUTDOWN'));
    await Promise.allSettled([...this.lanes.values()].map(lane => lane.draining));
  }
}

// 短期表达反馈仅在内存中保留，按人、场景和记忆 epoch 隔离。
// 不改写模型事实答案，只把实际成功发送过的表达模式供下一轮参考。
export class ExpressionContext {
  constructor(now = Date.now) { this.now = now; this.owners = new Map(); }
  key(e, epoch) { return `${partition(e)}:${epoch}`; }
  record(e, epoch, text) {
    const key = this.key(e, epoch), at = this.now();
    const rows = (this.owners.get(key) ?? []).filter(r => at - r.at < 1800000);
    rows.push({ at, text: text.slice(0, 600) }); this.owners.delete(key); this.owners.set(key, rows.slice(-6));
    while (this.owners.size > 128) this.owners.delete(this.owners.keys().next().value);
  }
  context(e, epoch) {
    const rows = (this.owners.get(this.key(e, epoch)) ?? []).filter(r => this.now() - r.at < 1800000);
    const last = rows.at(-1)?.text ?? '';
    return { combinedMessages: e.burstCount ?? 1, recentReplies: rows.slice(-3).map(r => r.text),
      recentQuestionCount: rows.filter(r => /[？?][”」』]?$/u.test(r.text.trim())).length,
      previousWasQuestion: /[？?][”」』]?$/u.test(last.trim()) };
  }
  forget(e) { for (const key of this.owners.keys()) if (key.startsWith(`${partition(e)}:`)) this.owners.delete(key); }
}
