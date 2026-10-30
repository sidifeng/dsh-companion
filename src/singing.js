import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { encode, isWav, isSilk } from 'silk-wasm';
import { localServiceUrl } from './voice.js';

const exec = promisify(execFile);
async function boundedBody(response, maximum) {
  if (!response.ok) throw new Error(`歌声服务 HTTP ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new Error('歌声服务响应超过限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function extractWav(bytes, contentType) {
  if (/^audio\/(?:wav|x-wav)/iu.test(contentType) && isWav(bytes)) return bytes;
  const boundary = /boundary=(?:"([^"\r\n]{1,100})"|([^;\s]{1,100}))/iu.exec(contentType);
  if (!/^multipart\/mixed/iu.test(contentType) || !boundary) throw new Error('歌声服务没有返回 WAV。');
  const marker = Buffer.from(`\r\n--${boundary[1] || boundary[2]}`);
  let position = 0;
  for (let count = 0; count < 8; count++) {
    const headersEnd = bytes.indexOf('\r\n\r\n', position);
    if (headersEnd < 0 || headersEnd - position > 4096) break;
    const end = bytes.indexOf(marker, headersEnd + 4);
    if (end < 0) break;
    const headers = bytes.subarray(position, headersEnd).toString();
    const body = bytes.subarray(headersEnd + 4, end);
    if (/content-type:\s*audio\/(?:wav|x-wav)/iu.test(headers) && isWav(body)) return body;
    position = end + marker.length;
  }
  throw new Error('歌声结果中没有有效 WAV 音轨。');
}

// ACE-Step.cpp 的异步 job API。只生成一段原创歌曲，不接收参考音频或任意文件路径。
export async function generateSong({ caption, lyrics, seconds }, config, directory, ffmpegPath, signal, fetchImpl = fetch) {
  if (!config.enabled) throw new Error('歌声合成尚未启用。');
  if (typeof caption !== 'string' || !caption.trim() || caption.length > 600 || typeof lyrics !== 'string' || !lyrics.trim() || lyrics.length > 500) throw new Error('歌曲需要简短风格说明与歌词。');
  const duration = Math.min(config.maxSeconds, Math.max(8, Number.isFinite(seconds) ? seconds : 20));
  const bounded = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(config.timeoutMs)]);
  const request = (path, options = {}) => fetchImpl(localServiceUrl(config.baseUrl, path), { redirect: 'error', signal: bounded, ...options });
  let id; let done = false;
  try {
    const queued = JSON.parse((await boundedBody(await request('/synth', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caption, lyrics, duration, synth_model: config.synthModel, vocal_language: 'zh',
        bpm: 90, keyscale: 'C major', timesignature: '4', inference_steps: 8, guidance_scale: 1, shift: 3,
        synth_batch_size: 1, output_format: 'wav16' }) }), 65536)).toString());
    if (!/^[a-f\d]{1,32}$/iu.test(String(queued.id))) throw new Error('歌声服务没有返回有效任务编号。');
    id = String(queued.id);
    while (true) {
      bounded.throwIfAborted();
      const status = JSON.parse((await boundedBody(await request(`/job?id=${id}`), 65536)).toString());
      if (status.status === 'done') { done = true; break; }
      if (!['queued', 'running'].includes(status.status)) throw new Error('歌声生成失败或已取消。');
      await sleep(1000, undefined, { signal: bounded });
    }
    const result = await request(`/job?id=${id}&result=1`);
    const wav = extractWav(await boundedBody(result, 16 * 1024 * 1024), result.headers.get('content-type') ?? '');
    bounded.throwIfAborted(); await mkdir(directory, { recursive: true });
    const raw = join(directory, `${randomUUID()}.wav`); const mono = join(directory, `${randomUUID()}.wav`);
    try {
      await writeFile(raw, wav);
      await exec(ffmpegPath || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
        '-format_whitelist', 'wav', '-i', raw, '-t', String(duration), '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-y', mono],
      { signal: bounded, timeout: 15000, windowsHide: true, maxBuffer: 65536 });
      const silk = await encode(await readFile(mono), 0);
      if (!isSilk(silk.data) || silk.duration > (config.maxSeconds + 1) * 1000) throw new Error('歌曲编码或时长异常。');
      bounded.throwIfAborted();
      const localPath = join(directory, `${randomUUID()}.silk`); await writeFile(localPath, silk.data);
      return { localPath, durationMs: silk.duration };
    } finally { await Promise.allSettled([unlink(raw), unlink(mono)]); }
  } finally {
    if (id && !done) await fetchImpl(localServiceUrl(config.baseUrl, `/job?id=${id}&cancel=1`), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  }
}
