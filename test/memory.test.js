import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store.js';
import { validateAnalysis } from '../src/memory.js';

const event = (id = 'one', extra = {}) => ({ appId: 'bot', scope: 'c2c', targetId: 'A', senderId: 'A', eventId: id, receivedAt: 1800000000000, ...extra });
const fact = (value = '喜欢茶') => ({ slot: 'preference:饮料', value, evidence: value, confidence: 0.95 });
const analysis = (value, tone = 'positive') => ({ facts: [fact(value)], summary: '聊饮料', tone });
const store = t => { const s = new MemoryStore(':memory:'); t.after(() => s.close()); return s; };

test('自动记忆按事实槽纠正、拒绝重放，旧 tone 不再直接改变关系情绪', t => {
  const s = store(t); const e = event();
  assert.equal(s.applyAnalysis(e, analysis('喜欢茶'), 0), true);
  assert.equal(s.applyAnalysis(e, analysis('喜欢咖啡'), 0), false);
  s.applyAnalysis(event('two', { receivedAt: e.receivedAt + 1000 }), analysis('喜欢咖啡'), 0);
  assert.equal(s.recall(e).length, 1); assert.equal(s.recall(e)[0].text, '喜欢咖啡');
  assert.equal(s.profile(e).interactions, 2); assert.equal(s.profile(e).familiarity, 0);
  s.applyAnalysis(event('three', { receivedAt: e.receivedAt + 14400000 }), { facts: [], summary: '', tone: 'neutral' }, 0);
  assert.equal(s.profile(e).mood, 0);
  assert.equal(s.profile(e).familiarity, 0);
  assert.deepEqual(s.recall(event('b', { senderId: 'B' })), []);
});

test('退出自动记忆、纠正和删除使迟到的整理结果失效', t => {
  const s = store(t); const e = event(); s.applyAnalysis(e, analysis('喜欢茶'), 0);
  const id = s.recall(e)[0].id;
  assert.equal(s.editMemory(event('b', { senderId: 'B' }), id, '别人的'), false);
  assert.equal(s.editMemory(e, id, '喜欢水'), true);
  assert.equal(s.applyAnalysis(event('late'), analysis('喜欢茶'), 0), false);
  assert.equal(s.profile(e).summary, ''); assert.equal(s.recall(e)[0].text, '喜欢水');
  s.setAutoMemory(e, false); const epoch = s.profile(e).epoch;
  assert.equal(s.applyAnalysis(event('off'), analysis('喜欢茶'), epoch), false);
  s.forget(e); assert.deepEqual(s.recall(e), []); assert.equal(s.profile(e).auto_memory, 0);
  assert.equal(s.db.prepare('SELECT count(*) n FROM fact_history').get().n, 0);
});

test('自动抽取要求原文证据、本人归属和置信度；拒绝敏感资料和伪造证据', () => {
  const valid = { ...fact(), subject: 'speaker' };
  const response = validateAnalysis({ facts: [valid, { ...valid, evidence: '没有出现' }, { ...valid, subject: 'other' },
    { ...valid, confidence: 0.6 }, { ...valid, value: '密码 abc123' }], topic: { text: '幻觉话题', evidence: '没有出现' } }, '我喜欢茶');
  assert.deepEqual(response.facts, [fact()]); assert.equal(response.summary, '');
  assert.throws(() => validateAnalysis('null', 'hello'));
});

test('schema 1 升级保留旧记忆，并产生可单独打开的升级前备份', t => {
  const directory = mkdtempSync(join(tmpdir(), 'companion-migration-')); const file = join(directory, 'memory.sqlite');
  t.after(() => { assert.ok(directory.startsWith(join(tmpdir(), 'companion-migration-'))); rmSync(directory, { recursive: true, force: true }); });
  const first = new MemoryStore(file); first.remember(event(), '旧记忆');
  first.db.exec('DROP TABLE facts; DROP TABLE fact_history; DROP TABLE profiles; DROP TABLE analyzed; DROP TABLE episodes; DROP TABLE semantic_vectors; DROP TABLE biology; DROP TABLE biology_events; PRAGMA user_version=1;'); first.close();
  const upgraded = new MemoryStore(file); assert.equal(upgraded.recall(event())[0].text, '旧记忆');
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 5); upgraded.close();
  const backup = new DatabaseSync(join(directory, readdirSync(directory).find(x => x.includes('.before-v2-'))), { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(backup.prepare('SELECT text FROM memories').get().text, '旧记忆'); backup.close();
});
