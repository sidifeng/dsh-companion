import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSilk } from 'silk-wasm';
import { synthesizeVoice, localServiceUrl } from '../src/voice.js';
import { bilibiliId } from '../src/bilibili.js';
import { CompanionRuntime } from '../src/runtime.js';

test('语音转为真正 SILK；拒绝远程服务、无效音频和取消后的落盘', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'companion-voice-'));
  t.after(() => { assert.ok(directory.startsWith(join(tmpdir(), 'companion-voice-'))); rmSync(directory, { recursive: true, force: true }); });
  const wav = Buffer.alloc(44 + 24000 * 2); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const config = { enabled: true, baseUrl: 'http://127.0.0.1:8765', maxChars: 120 };
  const audio = await synthesizeVoice('你好', config, directory, undefined, async () => new Response(wav));
  assert.ok(isSilk(readFileSync(audio.localPath))); assert.equal(audio.durationMs, 1000);
  for (const url of ['https://example.com', 'http://127.0.0.1.evil.test', 'http://user:pass@localhost']) assert.throws(() => localServiceUrl(url, '/v1/speak/file'));
  await assert.rejects(synthesizeVoice('你好', config, directory, undefined, async () => new Response('not audio')), /WAV/u);
  await assert.rejects(synthesizeVoice('你好', config, directory, AbortSignal.abort(), async () => new Response(wav)));
});

test('B站只接受 BV 号和官方视频页，不能被当成任意 URL 下载器', () => {
  assert.equal(bilibiliId('https://www.bilibili.com/video/BV1234567890/?x=y'), 'BV1234567890');
  for (const input of ['https://evil.test/video/BV1234567890', 'file:///etc/passwd', 'https://bilibili.com.evil.test/video/BV1234567890']) assert.throws(() => bilibiliId(input));
});

test('取消在上传后、发送前生效，不继续发送后续气泡', async () => {
  const runtime = new CompanionRuntime({ database: ':memory:', intervalMs: 0 });
  const controller = new AbortController(); let sent = 0;
  const e = { appId: 'bot', scope: 'c2c', targetId: 'A', senderId: 'A', eventId: 'cancel', receivedAt: Date.now(), text: '', signal: controller.signal };
  await runtime.queue.send(e, [{ kind: 'text', text: '一' }, { kind: 'text', text: '二' }], async () => { sent++; controller.abort(); });
  assert.equal(sent, 1); await runtime.close();
});
