import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
export async function videoFrames(file, config, directory, signal) {
  await mkdir(directory, { recursive: true });
  const common = ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,mpegts,mpegvideo', '-threads', '1'];
  const { stderr } = await exec(config.ffmpegPath || 'ffmpeg', [...common, '-i', file, '-t', '0', '-f', 'null', '-'], { signal, timeout: 15000, windowsHide: true, maxBuffer: 256000 });
  const match = /Duration:\s*(\d+):(\d+):([\d.]+)/u.exec(stderr);
  if (!match) throw new Error('无法确定视频时长。');
  const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  if (duration <= 0) throw new Error('视频为空。');
  const covered = Math.min(duration, config.maxSeconds);
  const count = Math.min(config.frames, Math.max(1, Math.ceil(covered / 2)));
  const frames = [];
  for (let i = 0; i < count; i++) {
    signal?.throwIfAborted();
    const seconds = Math.min(duration - 0.05, covered * (i + 0.5) / count);
    const path = join(directory, `${randomUUID()}.jpg`);
    await exec(config.ffmpegPath || 'ffmpeg', [...common, '-loglevel', 'error', '-ss', String(Math.max(0, seconds)), '-i', file,
      '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', '-an', '-y', path], { signal, timeout: 20000, windowsHide: true, maxBuffer: 256000 });
    frames.push({ seconds: Math.round(seconds * 10) / 10, path });
  }
  return { duration, covered, frames };
}

export async function cleanupMedia(directory, ttlHours = 24, now = Date.now()) {
  if (ttlHours <= 0) return;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    // 只处理本插件创建的 UUID 文件，不跟随目录、符号链接或用户放入的其他文件。
    if (!entry.isFile() || !/^[a-f0-9-]{36}\.(?:jpg|img|video|silk|wav)$/u.test(entry.name)) continue;
    const file = join(directory, entry.name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > ttlHours * 3600000) await unlink(file).catch(() => {});
  }
}
