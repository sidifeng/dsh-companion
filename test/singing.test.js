import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWav, generateSong } from '../src/singing.js';

const wav = Buffer.alloc(52); wav.write('RIFF'); wav.writeUInt32LE(44, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24);
wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(8, 40);
Buffer.from([13, 10, 0, 255, 0, 128, 255, 127]).copy(wav, 44);
test('歌声 multipart 解析保留二进制 WAV，只提取音轨而非 latent', () => {
  const response = Buffer.concat([Buffer.from('--abc\r\nContent-Type: application/octet-stream\r\n\r\nlatent\r\n--abc\r\nContent-Type: audio/wav\r\n\r\n'), wav, Buffer.from('\r\n--abc--\r\n')]);
  assert.deepEqual(extractWav(response, 'multipart/mixed; boundary="abc"'), wav);
  assert.deepEqual(extractWav(wav, 'audio/wav'), wav);
  assert.throws(() => extractWav(Buffer.from('no audio'), 'multipart/mixed; boundary=abc'));
  assert.throws(() => extractWav(wav, 'application/octet-stream'));
});

test('歌曲任务取消会通知本地引擎，不能在 abort 后继续取结果', async () => {
  const controller = new AbortController(); const calls = [];
  const config = { enabled: true, baseUrl: 'http://127.0.0.1:8085', synthModel: 'fixture', maxSeconds: 20, timeoutMs: 5000 };
  const fetchImpl = async (url, options) => {
    calls.push(url.pathname + url.search);
    if (url.pathname === '/synth') return Response.json({ id: '9c9404f31a6be19e' });
    if (url.search.includes('cancel=1')) { assert.equal(options.signal.aborted, false); return Response.json({ status: 'cancelled' }); }
    controller.abort(); return Response.json({ status: 'running' });
  };
  await assert.rejects(generateSong({ caption: 'warm pop', lyrics: '清风吹过', seconds: 10 }, config, '.', 'ffmpeg', controller.signal, fetchImpl));
  assert.deepEqual(calls, ['/synth', '/job?id=9c9404f31a6be19e', '/job?id=9c9404f31a6be19e&cancel=1']);
});

test('歌声服务拒绝外网地址、非法 job ID 和未启用请求', async () => {
  const config = { enabled: true, baseUrl: 'https://evil.test', maxSeconds: 20, timeoutMs: 5000 };
  const args = { caption: 'pop', lyrics: '自己的歌词', seconds: 10 };
  await assert.rejects(generateSong(args, config, '.', 'ffmpeg'), /本机/u);
  await assert.rejects(generateSong(args, { ...config, enabled: false }, '.', 'ffmpeg'), /未启用/u);
  await assert.rejects(generateSong(args, { ...config, baseUrl: 'http://localhost:8085' }, '.', 'ffmpeg', undefined, async () => Response.json({ id: '../path' })), /任务编号/u);
  await assert.rejects(generateSong({ ...args, lyrics: '[Instrumental]' }, config, '.', 'ffmpeg'), /实际歌词/u);
});

test('音乐规划只传递音频编码，保留歌词和时长；取消针对当前合成任务', async () => {
  const controller = new AbortController(); const calls = []; let synth;
  const config = { enabled: true, baseUrl: 'http://127.0.0.1:8085', lmModel: 'lm.gguf', synthModel: 'synth.gguf', maxSeconds: 30, timeoutMs: 5000 };
  const fetchImpl = async (url, options) => {
    calls.push(url.pathname + url.search);
    if (url.pathname === '/lm') return Response.json({ id: 'abc1' });
    if (url.search === '?id=abc1') return Response.json({ status: 'done' });
    if (url.search === '?id=abc1&result=1') return Response.json([{ audio_codes: '<|audio_code_12|>', lyrics: '改写歌词', duration: 500, synth_model: 'other.gguf' }]);
    if (url.pathname === '/synth') { synth = JSON.parse(options.body); return Response.json({ id: 'abc2' }); }
    if (url.search.includes('cancel=1')) return Response.json({ status: 'cancelled' });
    controller.abort(); return Response.json({ status: 'running' });
  };
  await assert.rejects(generateSong({ caption: 'acoustic pop', lyrics: '晚风吹过我的窗', seconds: 30 }, config, '.', 'ffmpeg', controller.signal, fetchImpl));
  assert.equal(synth.lyrics, '晚风吹过我的窗'); assert.equal(synth.duration, 30);
  assert.equal(synth.synth_model, 'synth.gguf'); assert.equal(synth.audio_codes, '<|audio_code_12|>');
  assert.deepEqual(calls, ['/lm', '/job?id=abc1', '/job?id=abc1&result=1', '/synth', '/job?id=abc2', '/job?id=abc2&cancel=1']);
});

test('音乐规划取消或缺少编码时，不再提交声音合成', async () => {
  const config = { enabled: true, baseUrl: 'http://127.0.0.1:8085', lmModel: 'lm.gguf', maxSeconds: 30, timeoutMs: 5000 };
  for (const cancel of [true, false]) {
    const controller = new AbortController(); const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url.pathname + url.search);
      if (url.pathname === '/lm') return Response.json({ id: 'abc' });
      if (url.search.includes('cancel=1')) return Response.json({ status: 'cancelled' });
      if (url.search.includes('result=1')) return Response.json([{ lyrics: '没有编码' }]);
      if (cancel) controller.abort();
      return Response.json({ status: cancel ? 'running' : 'done' });
    };
    await assert.rejects(generateSong({ caption: 'pop', lyrics: '星光落在窗边' }, config, '.', 'ffmpeg', controller.signal, fetchImpl));
    assert.equal(calls.includes('/synth'), false);
    assert.equal(calls.includes('/job?id=abc&cancel=1'), cancel);
  }
});
