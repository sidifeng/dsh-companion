import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
export const UPSTREAM_VERSION = '0.5.3';

export function upstreamRoot() {
  const file = require.resolve('@tencent-connect/dsh-qqbot/package.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.version !== UPSTREAM_VERSION) throw new Error(`QQ 适配层需要 ${UPSTREAM_VERSION}，实际为 ${manifest.version}。请先做兼容验收。`);
  return dirname(file);
}

// 上游暂无公开入站扩展 API。将内部依赖集中在此，升级必须重新做契约测试。
export async function loadUpstream() {
  const root = upstreamRoot();
  const load = p => import(pathToFileURL(join(root, 'dist', p)).href);
  const [session, inbound, config, attachment, vision] = await Promise.all([
    load('session/session-manager.js'), load('transport/inbound.js'), load('config.js'),
    load('middleware/attachment.js'), load('media/vision-tool.js'),
  ]);
  return { ...session, ...inbound, ...config, ...attachment, ...vision };
}
