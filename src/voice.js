import { encode, isWav, isSilk } from 'silk-wasm';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function localServiceUrl(baseUrl, path) {
  const url = new URL(baseUrl);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('语音服务必须使用本机地址。');
  return new URL(path, url);
}

export async function synthesizeVoice(text, config, directory, signal, fetchImpl = fetch) {
  if (!config.enabled) throw new Error('语音尚未启用。');
  const value = String(text).trim();
  if (!value || value.length > config.maxChars) throw new Error(`单次语音需要 1～${config.maxChars} 字。`);
  const response = await fetchImpl(localServiceUrl(config.baseUrl, '/v1/speak/file'), {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: value, voice: config.voice || undefined, format: 'wav', sr: 24000, cache: true }),
    signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(45000)]),
  });
  if (!response.ok) throw new Error(`本地语音合成失败（HTTP ${response.status}）。`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error('语音超过大小限制。'); chunks.push(chunk); }
  const wav = Buffer.concat(chunks);
  if (!isWav(wav)) throw new Error('语音服务没有返回有效 WAV 音频。');
  const silk = await encode(wav, 0);
  if (!isSilk(silk.data) || silk.duration > 60000) throw new Error('语音需要控制在一分钟内。');
  signal?.throwIfAborted();
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${randomUUID()}.silk`); await writeFile(file, silk.data);
  return { localPath: file, durationMs: silk.duration };
}
