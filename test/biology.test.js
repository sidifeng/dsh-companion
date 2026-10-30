import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialBiology, updateBiology, advanceBiology, expressionState, HOUR } from '../src/biology.js';
import { validateAppraisal, appraiseInteraction, evidenceHash } from '../src/appraisal.js';
import { MemoryStore } from '../src/store.js';
import { CompanionRuntime } from '../src/runtime.js';

const now = Date.parse('2026-10-30T09:00:00+08:00');
const event = (id = 'a', extra = {}) => ({ appId: 'app', scope: 'c2c', senderId: 'A', targetId: 'A', eventId: id, receivedAt: now, text: '和你聊这些挺开心的', ...extra });
const a = (kind = 'warmth', extra = {}) => ({ kind, target: 'bot', subject: 'speaker', evidence: '挺开心的', hash: evidenceHash('挺开心的'), intensity: 0.8, confidence: 0.95, ...extra });
const s = t => { const store = new MemoryStore(':memory:'); t.after(() => store.close()); return store; };
const llm = (raw, before = () => {}) => ({ async *stream() { await before(); yield { type: 'text-delta', index: 0, text: JSON.stringify(raw) }; yield { type: 'finish', reason: { kind: 'stop' } }; } });

test('关系每天缓慢增长，连续消息和同日不同夸赞不能刷满', () => {
  let state = initialBiology({}, now);
  for (let i = 0; i < 1000; i++) state = updateBiology(state, a(), now + i * 1000).state;
  assert.equal(state.familiarity, 0.004); assert.ok(state.trust < 0.203); assert.ok(state.valence < 0.2);
  for (let i = 1; i <= 24; i++) state = updateBiology(state, a(), now + i * 30 * 60000).state;
  assert.ok(state.familiarity <= 0.0200001); assert.ok(state.trust <= 0.2120001); assert.ok(state.closeness <= 0.0160001);
  const next = updateBiology(state, a(), now + 24 * HOUR).state;
  assert.ok(next.familiarity > state.familiarity); assert.equal(next.activeDays, 2);
});

test('缺席不降信任亲近，短时情绪和压力可恢复，读状态不产生新互动', () => {
  let state = initialBiology({}, now);
  for (let i = 0; i < 30; i++) state = updateBiology(state, a('conflict'), now + i * 6 * 60000).state;
  const before = structuredClone(state); const later = advanceBiology(state, now + 365 * 24 * HOUR);
  assert.ok(later.stress < 0.001 && Math.abs(later.valence) < 0.001 && later.load < 0.001);
  assert.equal(later.trust, state.trust); assert.equal(later.closeness, state.closeness);
  assert.equal(later.encounters, state.encounters); assert.deepEqual(state, before);
  assert.deepEqual(advanceBiology(later, later.at), later);
});

test('低落、正常拒绝和边界不减信任；直接冲突有界且和解能降低冲突', () => {
  const start = initialBiology({ familiarity: 30 }, now);
  for (const kind of ['distress', 'boundary', 'neutral']) {
    const next = updateBiology(start, a(kind), now).state;
    assert.equal(next.trust, start.trust); assert.equal(next.conflict, 0);
  }
  const conflict = updateBiology(start, a('conflict'), now).state;
  assert.ok(conflict.trust >= start.trust - 0.003); assert.ok(conflict.conflict > 0);
  const repaired = updateBiology(conflict, a('repair'), now + HOUR).state;
  assert.ok(repaired.conflict < conflict.conflict); assert.ok(repaired.stress < conflict.stress);
});

test('多月强刺激保持数值有界，负荷不能形成无法恢复的正反馈', () => {
  let state = initialBiology({}, now);
  for (let i = 0; i < 90 * 24; i++) {
    state = updateBiology(state, a(i % 3 ? 'conflict' : 'repair', { intensity: 1, confidence: 1 }), now + i * HOUR).state;
    for (const key of ['trust', 'closeness', 'familiarity', 'conflict', 'stress', 'load']) assert.ok(Number.isFinite(state[key]) && state[key] >= 0 && state[key] <= 1, key);
    assert.ok(Math.abs(state.valence) <= 0.45);
  }
  const recovered = advanceBiology(state, state.at + 30 * 24 * HOUR);
  assert.ok(recovered.load < 0.001 && recovered.stress < 0.001);
});

test('自动调参默认冻结，有足够跨日明确反馈也只能小步有界变化', () => {
  const run = adaptive => {
    let state = updateBiology(initialBiology({}, now), a(), now).state;
    for (let i = 1; i <= 90; i++) state = updateBiology(state, a('feedback', { feedback: 'helpful' }), now + i * 12 * HOUR, { adaptive }).state;
    return state;
  };
  const off = run(false); assert.equal(off.warmth, 0.5); assert.equal(off.learningSteps, 0);
  const on = run(true); assert.ok(on.learningSteps > 0); assert.ok(on.warmth > 0.5 && on.warmth <= 0.65);
  let state = updateBiology(initialBiology({}, now), a(), now).state;
  for (let i = 1; i <= 7; i++) state = updateBiology(state, a('feedback', { feedback: 'helpful' }), now + i * 12 * HOUR, { adaptive: true }).state;
  assert.equal(state.learningSteps, 0);
  const mixed = initialBiology({}, now);
  mixed.lastEventAt = now - HOUR; mixed.feedbackDays = [mixed.day - 2, mixed.day - 1, mixed.day];
  mixed.strategies.natural = { good: 7, bad: 0, days: [mixed.day] };
  const guarded = updateBiology(mixed, a('feedback', { feedback: 'helpful' }), now, { adaptive: true }).state;
  assert.equal(guarded.learningSteps, 0, '别的策略的历史反馈日不能帮助当前策略越过跨日门槛');
});

test('评价必须有原文、归属、目标及置信度，模型不能直接写信任或兑现无依据约定', () => {
  const valid = { event: { ...a(), trust: 1 } };
  const parsed = validateAppraisal(valid, event().text); assert.equal(parsed.event.trust, undefined);
  for (const bad of [{ evidence: '没有原文' }, { subject: 'other' }, { target: 'self' }, { confidence: 0.3 }, { intensity: NaN }, { kind: 'love' }]) {
    assert.throws(() => validateAppraisal({ event: { ...a(), ...bad } }, event().text));
  }
  assert.throws(() => validateAppraisal({ event: a('reliability') }, event().text));
  assert.equal(validateAppraisal({ event: a('reliability', { planId: 'E1' }) }, event().text, [], [{ id: 'E1' }]).event.kind, 'reliability');
  assert.throws(() => validateAppraisal({ event: a('neutral', { evidence: '密码abc', target: 'situation' }) }, '密码abc'));
});

test('回忆情绪只能基于本轮候选原文，小幅临时影响表达且不反写长期状态', () => {
  const raw = { event: a(), recalls: [{ id: 'M1', evidence: '很开心', valence: 'positive', confidence: 0.95 }, { id: 'M2', evidence: '秘密', valence: 'negative', confidence: 1 }] };
  const parsed = validateAppraisal(raw, event().text, [{ id: 'M1', text: '那次旅行很开心' }]);
  assert.equal(parsed.recalls.length, 1); assert.equal(parsed.recalls[0].bias, 0.02);
  const state = initialBiology({}, now); const copy = structuredClone(state);
  assert.deepEqual(expressionState(state, 10), expressionState(state, 0.04)); assert.deepEqual(state, copy);
});

test('重复事件与重复原文不叠加，关系状态按应用、人物、群和私聊隔离', t => {
  const store = s(t); const e = event();
  assert.equal(store.applyAppraisal(e, a(), 0), true); const first = store.biologySnapshot(e, now);
  assert.equal(store.applyAppraisal(e, a(), 0), false);
  store.applyAppraisal(event('same-text', { receivedAt: now + HOUR }), a(), 0);
  assert.equal(store.biologySnapshot(e, now + HOUR).trust, first.trust);
  for (const extra of [{ senderId: 'B' }, { appId: 'other' }, { scope: 'group', targetId: 'G' }]) {
    assert.equal(store.biologySnapshot(event('other', extra), now).encounters, 0);
  }
});

test('关闭、重置和忘记阻止迟到评价；重置生物层保留记忆、忘记全部清除依据', t => {
  const store = s(t); const e = event(); store.remember(e, '喜欢猫'); store.applyAppraisal(e, a(), 0);
  store.setBiology(e, false); assert.equal(store.applyAppraisal(event('late'), a(), 0), false);
  assert.equal(store.applyAppraisal(event('off'), a(), store.profile(e).epoch), false);
  store.setBiology(e, true); const epoch = store.profile(e).epoch; store.resetBiology(e);
  assert.equal(store.applyAppraisal(event('reset-late'), a(), epoch), false);
  assert.equal(store.recall(e).length, 1); assert.equal(store.biologySnapshot(e, now).trust, 0.2);
  store.applyAppraisal(event('new'), a(), store.profile(e).epoch); store.forget(e);
  assert.equal(store.biologyHistory(e).length, 0); assert.equal(store.biologySnapshot(e, now).encounters, 0); assert.equal(store.recall(e).length, 0);
});

test('schema 3 升级和重启保留旧记忆及已积累关系，备份可读', t => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-biology-')); const file = join(dir, 'memory.sqlite');
  t.after(() => { assert.ok(dir.startsWith(join(tmpdir(), 'companion-biology-'))); rmSync(dir, { recursive: true, force: true }); });
  let store = new MemoryStore(file); store.remember(event(), '以前的记忆');
  store.db.exec('DROP TABLE biology; DROP TABLE biology_events; PRAGMA user_version=3;'); store.close();
  store = new MemoryStore(file); assert.equal(store.recall(event())[0].text, '以前的记忆'); store.applyAppraisal(event(), a(), 0); const trust = store.biologySnapshot(event(), now).trust; store.close();
  store = new MemoryStore(file); assert.equal(store.biologySnapshot(event(), now + HOUR).trust, trust); store.close();
  const backup = new DatabaseSync(join(dir, readdirSync(dir).find(f => f.includes('before-v4-'))), { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 3); backup.close();
});

test('真实结构化流贯通评价、状态、当前轮提示词；关闭后不继续装配', async t => {
  const runtime = new CompanionRuntime({ database: ':memory:', now: () => now, persona: '朋友' }); t.after(() => runtime.close());
  runtime.appraise = e => appraiseInteraction(runtime, e, llm({ event: a() }), {});
  const e = event(); await runtime.prepare(e); assert.equal(e.biologyStatus, 'ready');
  const agent = {}; runtime.bind(agent, e);
  const prompt = runtime.assemble({}, agent); assert.match(prompt.variables.companion_biology, /初识/u);
  assert.equal(runtime.store.biologySnapshot(e, now).encounters, 1);
  runtime.command(event('off', { text: '/生物层 关' }));
  assert.match(runtime.assemble({}, agent).variables.companion_biology, /\{\}$/u);
  assert.match(runtime.command(event('status', { text: '/关系' })), /暂停/u);
});

test('评价模型故障不中断聊天且不凭空改状态；取消或删除后迟到模型不生效', async t => {
  const runtime = new CompanionRuntime({ database: ':memory:', now: () => now }); t.after(() => runtime.close());
  const e = event(); const failing = { async *stream() { throw Error('offline'); } };
  await appraiseInteraction(runtime, e, failing, {}); assert.equal(e.biologyStatus, 'fallback'); assert.equal(runtime.store.biologyHistory(e).length, 0);
  await appraiseInteraction(runtime, event('late'), llm({ event: a() }, () => runtime.store.forget(e)), {});
  assert.equal(runtime.store.biologyHistory(e).length, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(appraiseInteraction(runtime, event('abort', { signal: controller.signal }), llm({ event: a() }), {}));
  assert.equal(runtime.store.biologyHistory(e).length, 0);
});

test('删除被召回的记忆后不会把迟到的回忆情绪带进下一次装配', async t => {
  const runtime = new CompanionRuntime({ database: ':memory:', now: () => now }); t.after(() => runtime.close()); const e = event();
  runtime.store.remember(e, '旅行很开心'); e.memoryEpoch = runtime.store.profile(e).epoch;
  e.recallAffect = [{ id: 'M1', text: '旅行很开心', bias: 0.04 }]; const agent = {}; runtime.bind(agent, e);
  runtime.store.editMemory(e, 'M1');
  const actual = JSON.parse(runtime.assemble({}, agent).variables.companion_biology.split('\n')[1]);
  assert.deepEqual(actual, expressionState(runtime.store.biologySnapshot(e, now)));
});
