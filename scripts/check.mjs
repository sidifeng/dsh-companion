import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { Config } from '../src/config.js';
import { loadUpstream } from '../src/upstream.js';

for (const directory of ['src', 'scripts', 'test']) {
  for (const file of readdirSync(directory).filter(f => /\.(?:mjs|js)$/u.test(f))) {
    const check = spawnSync(process.execPath, ['--check', join(directory, file)], { encoding: 'utf8' });
    if (check.status !== 0) throw new Error(check.stderr || `Syntax check failed: ${file}`);
  }
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const patch = yaml.load(readFileSync(pkg.dsh.bundle.patch, 'utf8'));
const config = Config(patch[0].insert[0].config);
if (config.enabled || config.access.c2cMode !== 'allowlist' || config.streaming) throw new Error('Unsafe package defaults');
await loadUpstream();
console.log(`OK: ${pkg.name}@${pkg.version}; syntax, bundle config, pinned QQ interface`);
