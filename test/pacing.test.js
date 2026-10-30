import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnScheduler, ExpressionContext } from '../src/pacing.js';
import { CompanionRuntime } from '../src/runtime.js';
import { envelope } from '../src/identity.js';

const item = (id, text, extra = {}) => ({ e: { appId: 'bot', scope: 'group', targetId: 'group', senderId: 'A', eventId: id, text, receivedAt: Date.now(), attachments: [], ...extra }, mCtx: { state: {} } });
function setup(t, options = {}) {
  const runs = [], finished = [];
  const queue = new TurnScheduler({ windowMs: 10, run: async (_item, e) => { runs.push(e); },
    finish: (e, state) => finished.push([e.eventId, state]), canReplace: () => true, ...options });
  t.after(() => queue.close()); return { queue, runs, finished };
}

test('同人碎片综合一轮，用最后真实消息 ID；每条原始事件都有终态', async t => {
  const { queue, runs, finished } = setup(t);
  await Promise.all([queue.enqueue(item('one', '今晚想吃面')), queue.enqueue(item('two', '不要太辣')), queue.enqueue(item('three', '有什么搭配'))]);
  assert.equal(runs.length, 1); assert.equal(runs[0].text, '今晚想吃面\n不要太辣\n有什么搭配');
  assert.equal(runs[0].eventId, 'three'); assert.equal(runs[0].burstCount, 3);
  assert.deepEqual(finished, [['one', 'merged'], ['two', 'merged'], ['three', 'handled']]);
});

test('不同人/场景、命令、附件、引用均形成边界，群内顺序不变', async t => {
  const { queue, runs } = setup(t);
  const entries = [item('a', '你好'), item('b', '我的问题', { senderId: 'B' }), item('c', '补充', {}),
    item('command', '/关系'), item('media', '看图', { attachments: [{ content_type: 'image/png' }] }),
    item('quote', '引用')]; entries.at(-1).mCtx.state.quote = { text: '别人的话' };
  await Promise.all(entries.map(e => queue.enqueue(e)));
  assert.deepEqual(runs.map(e => e.eventId), entries.map(e => e.e.eventId));
  await Promise.all([queue.enqueue(item('group', '本群')), queue.enqueue(item('private', '私事', { scope: 'c2c', targetId: 'A' }))]);
  assert.equal(runs.length, 8);
});

test('群里另一人非 @ 发言只结束合并边界，不产生新回复', async t => {
  const { queue, runs } = setup(t);
  const first = queue.enqueue(item('a', '第一个问题'));
  queue.noteSpeaker(item('unmentioned', '别人插话', { senderId: 'B' }).e);
  await Promise.all([first, queue.enqueue(item('b', '我的第二个问题'))]);
  assert.deepEqual(runs.map(e => e.eventId), ['a', 'b']);
});

test('明确更正取消未发送的旧轮次，沿用原文且不重复关系累加', async t => {
  let enter; const entered = new Promise(r => { enter = r; }); const runs = [];
  const { queue, finished } = setup(t, { run: async (_item, e) => {
    runs.push(e);
    if (e.eventId === 'old') {
      e.biologyStatus = 'ready'; e.followup = { id: 'E1' }; enter();
      await new Promise((_, reject) => e.signal.addEventListener('abort', () => reject(e.signal.reason), { once: true }));
    }
  } });
  const old = queue.enqueue(item('old', '周六下午碰面')); await entered;
  await Promise.all([old, queue.enqueue(item('new', '说错了，是周日下午'))]);
  assert.equal(runs[0].signal.reason.message, 'SUPERSEDED');
  assert.equal(runs[1].text, '周六下午碰面\n说错了，是周日下午');
  assert.equal(runs[1].skipAppraisal, true); assert.equal(runs[1].followup.id, 'E1');
  assert.deepEqual(finished, [['old', 'superseded'], ['new', 'handled']]);
});

test('已发送/工具任务不被普通补充取消，排队容量耗尽也不能丢掉原任务', async t => {
  for (const maxQueue of [1, 10]) {
    let enter, release; const entered = new Promise(r => { enter = r; }); const held = new Promise(r => { release = r; }); const runs = [];
    const { queue, finished } = setup(t, { maxQueue, canReplace: () => maxQueue === 1,
      run: async (_item, e) => { runs.push(e); if (e.eventId === 'old') { enter(); await held; } } });
    const old = queue.enqueue(item('old', '唱一首歌')); await entered;
    const next = queue.enqueue(item('new', '补充一下，换个主题'));
    assert.equal(runs[0].signal.aborted, false); release(); await Promise.all([old, next]);
    assert.equal(runs.length, maxQueue === 1 ? 1 : 2);
    if (maxQueue === 1) assert.ok(finished.some(([id, state]) => id === 'new' && state === 'queue-full'));
  }
});

test('取消可清除本人等待合并和排队任务，其他人仍正常处理；关闭不残留任务', async t => {
  const { queue, runs, finished } = setup(t, { windowMs: 800 });
  const a = queue.enqueue(item('a', '等待')), b = queue.enqueue(item('b', '别人', { senderId: 'B' }));
  assert.equal(queue.cancel(item('cancel', '/取消').e), 1);
  await Promise.all([a, b]); assert.deepEqual(runs.map(e => e.eventId), ['b']);
  const last = queue.enqueue(item('last', '关闭前等待')); await queue.close(); await last;
  assert.ok(finished.some(([id, state]) => id === 'last' && state === 'stopped')); assert.equal(queue.size, 0);
});

test('合并数量和总文本有界；关闭合并时每条独立', async t => {
  const { queue, runs } = setup(t);
  await Promise.all(Array.from({ length: 9 }, (_, i) => queue.enqueue(item(String(i), '一段话'))));
  assert.deepEqual(runs.map(e => e.burstCount), [6, 3]);
  await Promise.all([queue.enqueue(item('long1', '甲'.repeat(1500))), queue.enqueue(item('long2', '乙'.repeat(1500)))]);
  assert.equal(runs.length, 4);
  const off = setup(t, { windowMs: 0 });
  await Promise.all([off.queue.enqueue(item('off1', '一')), off.queue.enqueue(item('off2', '二'))]);
  assert.equal(off.runs.length, 2);
});

test('持续输入的等待有 2 秒上限，不无限延长', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { queue, runs } = setup(t, { windowMs: 800 });
  const pending = [queue.enqueue(item('a', '开头'))];
  for (let i = 1; i <= 3; i++) { t.mock.timers.tick(500); pending.push(queue.enqueue(item(String(i), '接着说'))); }
  t.mock.timers.tick(500); await Promise.all(pending);
  assert.equal(runs.length, 1); assert.equal(runs[0].burstCount, 4);
});

test('表达参考仅限本人与场景、半小时、当前记忆版本，容量有界', () => {
  let now = 0; const context = new ExpressionContext(() => now), e = item('a', '内容').e;
  context.record(e, 0, '今天怎么样？'); context.record(e, 0, '后来呢？');
  assert.equal(context.context(e, 0).recentQuestionCount, 2);
  assert.equal(context.context(e, 1).recentReplies.length, 0);
  assert.equal(context.context({ ...e, senderId: 'B' }, 0).recentReplies.length, 0);
  assert.equal(context.context({ ...e, scope: 'c2c' }, 0).recentReplies.length, 0);
  now = 1800001; assert.equal(context.context(e, 0).recentReplies.length, 0);
  for (let i = 0; i < 150; i++) context.record({ ...e, senderId: String(i) }, 0, '回复');
  assert.equal(context.owners.size, 128); context.record(e, 0, '清除'); context.forget(e); assert.equal(context.context(e, 0).recentReplies.length, 0);
});

test('只记录成功发出的模型回复；不确定发送不进入表达参考；忘记后清理', async t => {
  const runtime = new CompanionRuntime({ database: ':memory:', intervalMs: 0 }); t.after(() => runtime.close());
  const e = envelope('bot', { kind: 'c2c', senderId: 'A', messageId: 'm', content: '聊天' });
  await runtime.sendText(e, '你呢？', async () => {}, { generated: true });
  await runtime.sendText(e, '失败消息', async () => { throw Error('uncertain'); }, { generated: true });
  await runtime.sendText({ ...e, eventId: 'cmd' }, '指令返回', async () => {});
  assert.deepEqual(runtime.expression.context(e, 0).recentReplies, ['你呢？']);
  runtime.command({ ...e, text: '/忘记全部' }); assert.equal(runtime.expression.owners.size, 0);
});
