import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

// 只报告文件名/规则名，绝不把匹配到的凭据打印到 CI 日志。
export function privateFindings(name,body,known=[]) {
  const rules=[];
  if (/(?:^|\/)(?:\.local|\.cache|node_modules|runtime|sessions)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:sqlite.*|log|tgz|wav|mp3|silk|mp4)$/iu.test(name) && !name.endsWith('.env.example')) rules.push('runtime-file');
  if (known.some(v=>typeof v==='string'&&v.length>=5&&body.includes(v))) rules.push('known-private-value');
  if (/(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/u.test(body)) rules.push('credential-pattern');
  if (/(?:SESSDATA|bili_jct|DedeUserID)\s*[=:]\s*["']?[A-Za-z0-9%_-]{8,}/iu.test(body)) rules.push('bilibili-cookie');
  return rules;
}

export function scanRepository({history=false,staged=false,known=[]}={}) {
  const git=args=>execFileSync('git',args,{encoding:'utf8',maxBuffer:64*1024*1024});
  const objects=history?git(['rev-list','--objects','--all']).trim().split('\n').flatMap(line=>{
    const i=line.indexOf(' ');return i<0?[]:[{ref:line.slice(0,i),name:line.slice(i+1)}];
  }):git(staged?['diff','--cached','--name-only','--diff-filter=ACMR','-z']:['ls-files','-z']).split('\0').filter(Boolean).map(name=>({name,ref:':'+name}));
  const findings=[];let checked=0;
  for (const {ref,name} of objects) {
    if (history&&git(['cat-file','-t',ref]).trim()!=='blob') continue;
    const body=git(['show',ref]);checked++;
    const rules=privateFindings(name,body,known);if(rules.length)findings.push({name,rules});
  }
  return {checked,findings};
}
if (process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const index=process.argv.indexOf('--known-values');
  const known=index>=0?JSON.parse(readFileSync(process.argv[index+1],'utf8')):[];
  const result=scanRepository({history:process.argv.includes('--history'),staged:process.argv.includes('--staged'),known});
  console.log(JSON.stringify(result));if(result.findings.length)process.exitCode=1;
}
