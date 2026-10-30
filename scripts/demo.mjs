import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionRuntime } from '../src/runtime.js';

const dir = mkdtempSync(join(tmpdir(), 'companion-demo-'));
const runtime = new CompanionRuntime({ database: join(dir, 'memory.sqlite'), persona: '自然、温和。', intervalMs: 0 });
try {
  const a = runtime.receive('demo-bot', { kind: 'c2c', senderId: 'A', messageId: 'one', content: '记住：我周六要去看电影' });
  console.log('A:', runtime.command(a));
  const b = runtime.receive('demo-bot', { kind: 'c2c', senderId: 'B', messageId: 'two', content: '/记忆' });
  console.log('B:', runtime.command(b));
  await runtime.sendText(a, '记住了。\n\n周六看完可以聊聊感想。', async (message, target) => console.log(`模拟发送 ${target.sequence}: ${message.text}`));
  console.log('离线演示完成；没有连接 QQ、调用模型或发送真实消息。');
} finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
