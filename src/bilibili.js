import { fetchMedia } from './media.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function bilibiliId(value) {
  const text = String(value).trim();
  if (/^BV[0-9A-Za-z]{10}$/u.test(text)) return text;
  let url; try { url = new URL(text); } catch { throw new Error('请提供完整的 B站 BV 号或视频链接。'); }
  if (url.protocol !== 'https:' || !['www.bilibili.com', 'm.bilibili.com', 'bilibili.com'].includes(url.hostname)) throw new Error('只支持 bilibili.com 的视频链接。');
  const match = /^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/u.exec(url.pathname);
  if (!match) throw new Error('没有找到 BV 视频号。');
  return match[1];
}

const headers = { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' };
async function api(path, signal) {
  const bytes = await fetchMedia(`https://api.bilibili.com${path}`, { maxBytes: 2 * 1024 * 1024, signal, headers });
  const result = JSON.parse(bytes.toString());
  if (result.code !== 0) throw new Error(`B站返回 ${result.code}，可能需要登录或稍后重试。`);
  return result.data;
}

export async function readBilibili(input, signal) {
  const bvid = bilibiliId(input);
  const info = await api(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, signal);
  const result = { bvid, url: `https://www.bilibili.com/video/${bvid}/`, title: info.title, author: info.owner?.name,
    description: String(info.desc ?? '').slice(0, 3000), durationSeconds: info.duration, evidence: '视频标题与简介，尚未观看画面或听取音轨', subtitles: [] };
  try {
    const player = await api(`/x/player/v2?aid=${info.aid}&cid=${info.cid}`, signal);
    const tracks = player?.subtitle?.subtitles ?? [];
    const track = tracks.find(s => String(s.lan).includes('zh')) ?? tracks[0];
    if (track?.subtitle_url) {
      const url = new URL(track.subtitle_url.startsWith('//') ? `https:${track.subtitle_url}` : track.subtitle_url);
      if (!/(?:^|\.)(?:hdslb\.com|bilibili\.com)$/u.test(url.hostname)) throw new Error('字幕来源未支持。');
      const bytes = await fetchMedia(url.href, { maxBytes: 2 * 1024 * 1024, signal, headers });
      result.subtitles = (JSON.parse(bytes.toString()).body ?? []).slice(0, 160).map(x => ({ from: x.from, to: x.to, text: String(x.content).slice(0, 300) }));
      if (result.subtitles.length) result.evidence = '标题、简介和带时间戳字幕；未观看画面，字幕最多保留前 160 段';
    }
  } catch { result.subtitleStatus = '未取得公开字幕；可能需要登录或该视频没有字幕。'; }
  return result;
}

export async function browseBilibili(signal) {
  const data = await api('/x/web-interface/popular?ps=5&pn=1', signal);
  return (data.list ?? []).slice(0, 5).map(v => ({ bvid: v.bvid, title: v.title, author: v.owner?.name, durationSeconds: v.duration, url: `https://www.bilibili.com/video/${v.bvid}/` }));
}

export async function downloadPublicBilibili(input, { directory, maxSeconds, maxBytes }, signal) {
  const bvid = bilibiliId(input);
  const info = await api(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, signal);
  if (info.rights?.pay || !(info.duration > 0 && info.duration <= maxSeconds)) throw new Error(`画面理解仅支持无需付费、时长不超过 ${maxSeconds} 秒的公开短视频。`);
  const player = await api(`/x/player/playurl?bvid=${bvid}&cid=${info.cid}&qn=16&fnval=1&platform=html5`, signal);
  const segments = player?.durl;
  if (player?.format !== 'mp4' || segments?.length !== 1) throw new Error('该视频没有可用的公开 MP4；可以尝试读取简介或字幕。');
  const source = segments[0]; const url = new URL(source.url);
  if (source.size > maxBytes || !/(?:^|\.)bilivideo\.(?:com|cn|net)$/u.test(url.hostname)) throw new Error('视频超过下载限制，或来自未支持的 CDN。');
  const data = await fetchMedia(url.href, { maxBytes, signal, headers });
  signal?.throwIfAborted(); await mkdir(directory, { recursive: true });
  const localPath = join(directory, `${randomUUID()}.video`); await writeFile(localPath, data);
  return { localPath, title: info.title, url: `https://www.bilibili.com/video/${bvid}/` };
}
