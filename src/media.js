import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const blocked = new BlockList();
const blockedV6 = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(ip, prefix, 'ipv4');
for (const [ip, prefix] of [['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blockedV6.addSubnet(ip, prefix, 'ipv6');

export function mediaKind(type = '') {
  if (type === 'image' || type.startsWith('image/')) return 'image';
  if (type === 'video' || type.startsWith('video/')) return 'video';
  if (type === 'voice' || type.startsWith('audio/')) return 'voice';
  return 'file';
}

export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && !blockedV6.check(address, 'ipv6');
}

// 使用系统解析器，兼容 Windows 的代理/DNS 环境；固定已校验地址，禁止重定向。
export async function fetchMedia(url, { maxBytes, signal, headers, resolveHost = lookup, request = get } = {}) {
  const target = new URL(url.startsWith('//') ? `https:${url}` : url);
  if (target.protocol !== 'https:' || target.username || target.password || (target.port && target.port !== '443')) throw new Error('MEDIA_URL_BLOCKED');
  const addresses = await resolveHost(target.hostname, { all: true });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('MEDIA_ADDRESS_BLOCKED');
  return new Promise((resolve, reject) => {
    const req = request(target, { signal, headers, lookup(_host, options, callback) {
      const selected = options.family ? addresses.filter(a => a.family === options.family) : addresses;
      if (!selected.length) return callback(new Error('MEDIA_ADDRESS_FAMILY'));
      callback(null, ...(options.all ? [selected] : [selected[0].address, selected[0].family]));
    } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`MEDIA_HTTP_${response.statusCode}`)); return; }
      if (Number(response.headers['content-length']) > maxBytes) { response.destroy(); reject(new Error('MEDIA_TOO_LARGE')); return; }
      let size = 0; const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { response.destroy(new Error('MEDIA_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
  });
}

export function attachmentMiddleware(config, runtime, directory) {
  return async (ctx, next) => {
    ctx.state.downloadedFiles = [];
    if (config.media.enabled) {
      for (const attachment of (ctx.message.attachments ?? []).slice(0, 4)) {
        const kind = mediaKind(attachment.content_type);
        if (!['image', 'video'].includes(kind) || !attachment.url) continue;
        const maxBytes = kind === 'image' ? Math.min(config.vision.maxBytes, config.media.maxMB * 1024 * 1024) : config.media.maxMB * 1024 * 1024;
        try {
          if (attachment.size > maxBytes) throw new Error('MEDIA_TOO_LARGE');
          const data = await fetchMedia(attachment.url, { maxBytes, signal: AbortSignal.any([ctx.state.signal ?? new AbortController().signal, AbortSignal.timeout(30000)]) });
          await mkdir(directory, { recursive: true });
          const localPath = join(directory, `${randomUUID()}.${kind === 'image' ? 'img' : 'video'}`);
          await writeFile(localPath, data);
          ctx.state.signal?.throwIfAborted();
          ctx.state.downloadedFiles.push({ filename: attachment.filename, contentType: kind, localPath });
          runtime.store.observe(ctx.message.kind, `download:${kind}`, 'verified');
        } catch {
          if (ctx.state.signal?.aborted) break;
          runtime.store.observe(ctx.message.kind, `download:${kind}`, 'failed');
        }
      }
    }
    ctx.state.signal?.throwIfAborted();
    await next();
  };
}
