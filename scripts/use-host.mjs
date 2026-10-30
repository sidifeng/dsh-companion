import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// 仅测试使用：让测试和腾讯适配器共享用户宿主的核心模块实例。
// 不写宿主文件；不是产品运行时补丁。
if (!process.env.DSH_TEST_HOST_PACKAGE) throw new Error('Set DSH_TEST_HOST_PACKAGE to the installed DSH package.json');
const hostUrl = pathToFileURL(resolve(process.env.DSH_TEST_HOST_PACKAGE)).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) {
    return nextResolve(specifier, { ...context, parentURL: hostUrl });
  }
  return nextResolve(specifier, context);
} });
