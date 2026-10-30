export { Config } from './config.js';
export const name = 'dsh-companion';
export const inject = ['agents', 'tools'];

export async function apply(ctx, config) {
  if (!config.enabled) { (ctx.logger ?? console).info('companion: P0 已安装但未启用。请先完成白名单和单连接检查。'); return; }
  const { startGateway } = await import('./gateway.js');
  await startGateway(ctx, config);
}
