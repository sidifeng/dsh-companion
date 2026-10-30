import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeViewing,AutonomyEngine} from '../src/autonomy.js';
import {AutonomyStore} from '../src/autonomy-store.js';
import {CompanionRuntime} from '../src/runtime.js';
import {consolidateMemory} from '../src/memory.js';
import {Config} from '../src/config.js';
import {privateFindings} from '../scripts/privacy-check.mjs';

const evidence={frames:[{text:'一只橘猫在纸箱里面探出头。',seconds:1}]};
const reflection={topic:'猫咪行为',keywords:['橘猫','纸箱'],evidence:'橘猫在纸箱里面探出头',opinion:'我喜欢这种好奇探头的轻松画面。',action:'reinforce',affinity:.6};
const base={summary:'猫从纸箱探头',reaction:'很有趣',shareworthy:true};
const data={...base,reflections:[reflection],reflectionReason:''};
const mock=(responses,calls=[])=>({async *stream(o){calls.push(o);const value=responses[Math.min(calls.length-1,responses.length-1)];if(value instanceof Error)throw value;yield {type:'text-delta',index:0,text:JSON.stringify(value)};yield {type:'finish',reason:{kind:'stop'}};}});
const at=Date.parse('2026-11-01T23:30:00+08:00');
const e=(text,id=text)=>({appId:'test',scope:'c2c',senderId:'owner',targetId:'owner',eventId:id,text,receivedAt:at});
const full=stories=>({facts:[],stories,followups:[],resolutions:[]});

test('真实模型出现的兴趣字段缺失会触发一次修正，不再静默成功',async()=>{
 const calls=[];const result=await summarizeViewing(mock([base,data],calls),{},evidence);
 assert.equal(calls.length,2);assert.equal(result.reflectionStatus,'saved');assert.equal(result.reflections.length,1);
 assert.match(calls[1].messages[0].content[0].text,/上次输出/u);
});
test('无效证据持续失败时保留浏览摘要并明确标记待修复；允许有理由的空观点',async()=>{
 const bad={...data,reflections:[{...reflection,evidence:'猫做了没有看见的事情'}]};
 const result=await summarizeViewing(mock([bad]),{},evidence);
 assert.equal(result.summary,base.summary);assert.equal(result.reflectionStatus,'failed');assert.deepEqual(result.reflections,[]);
 const empty=await summarizeViewing(mock([{...base,reflections:[],reflectionReason:'no-interest'}]),{},evidence);
 assert.equal(empty.reflectionStatus,'empty');
});
test('补齐已有浏览不增加浏览预算或主动发送，非管理员无权执行，重置不复活旧观点',async t=>{
 const s=new AutonomyStore(':memory:','test');t.after(()=>s.close());
 const video={bvid:'BV0000000001',title:'猫咪日常'};
 s.claimVideo(video.bvid,at);s.saveExperience(video,base,evidence,at);
 const before=s.db.prepare('SELECT count(*) n FROM attempts').get().n;
 let review=0;const engine=new AutonomyEngine({config:Config({autonomy:{operatorIds:['owner']}}),store:s,now:()=>at,tasks:{review:async actual=>{assert.deepEqual(actual,evidence);review++;return {...data,reflectionStatus:'saved'};}}});
 assert.match(await engine.command({...e('/整理兴趣'),senderId:'other'}),/管理员/u);assert.equal(review,0);
 assert.match(await engine.command(e('/整理兴趣')),/1 条记录形成/u);assert.equal(review,1);
 assert.equal(s.db.prepare('SELECT count(*) n FROM attempts').get().n,before);assert.equal(s.experiences().length,1);assert.equal(s.pendingReviews().length,0);
 s.interests.reset();assert.equal(s.pendingReviews().length,0);assert.match(await engine.command(e('/整理兴趣')),/不会重新恢复/u);
 await engine.close();
});
test('整理期间重置丢弃迟到结果，取消和关闭不中途落库',async t=>{
 const s=new AutonomyStore(':memory:','test');t.after(()=>s.close());
 const video={bvid:'BV0000000002',title:'猫'};s.claimVideo(video.bvid,at);s.saveExperience(video,base,evidence,at);
 let finish;const engine=new AutonomyEngine({config:Config({autonomy:{operatorIds:['owner']}}),store:s,tasks:{review:()=>new Promise(r=>{finish=r;})}});
 const work=engine.command(e('/整理兴趣'));s.interests.reset();finish(data);assert.match(await work,/丢弃/u);assert.deepEqual(s.interests.context(),[]);await engine.close();
});
test('普通活动与简短进展归到同一事件；无长期偏好不应禁止经历',async t=>{
 const runtime=new CompanionRuntime({database:':memory:'});t.after(()=>runtime.close());
 const first=e('最近在追一部动画','first');const second={...e('今天大结局播出了','second'),receivedAt:at+10000};
 const item={title:'追动画',stage:'progress',text:'最近在追一部动画',evidence:first.text,subject:'speaker',confidence:.95};
 const calls=[];
 await consolidateMemory(runtime,first,mock([{facts:[]},full([item])],calls),{});
 assert.equal(calls.length,2);
 const id=runtime.store.life.list(first)[0].id;
 const next={...item,id,text:'大结局播出，尚未说明是否看完',evidence:second.text};
 const secondCalls=[];await consolidateMemory(runtime,second,mock([full([next])],secondCalls),{});
 assert.equal(runtime.store.life.list(second).length,1);assert.equal(runtime.store.life.detail(second,id).steps.length,2);
 assert.equal(runtime.store.life.detail(second,id).status,'progress');assert.match(secondCalls[0].messages[0].content[0].text,/recentTopic/u);
});
test('经历整理失败可见且忘记全部清除诊断；故障不增加经历或计数',async t=>{
 const runtime=new CompanionRuntime({database:':memory:'});t.after(()=>runtime.close());
 await assert.rejects(consolidateMemory(runtime,e('最近做了一个书架'),mock([new Error('MODEL_AUXILIARY_FAILED')]),{}));
 assert.match(runtime.command(e('/经历')),/整理未完成/u);assert.equal(runtime.store.profile(e('')).interactions,0);
 runtime.command(e('/忘记全部'));assert.doesNotMatch(runtime.command(e('/经历')),/整理未完成/u);
});
test('发布扫描检查已知私有值、凭据模式和运行数据，输出不含命中值',()=>{
 const value='private-fixture-value';
 const findings=privateFindings('test/example.js','value='+value,[value]);
 assert.deepEqual(findings,['known-private-value']);assert.ok(!JSON.stringify(findings).includes(value));
 assert.ok(privateFindings('.local/runtime.sqlite','').includes('runtime-file'));
 assert.ok(privateFindings('example.js','SESSDATA='+'a'.repeat(20)).includes('bilibili-cookie'));
 assert.deepEqual(privateFindings('cordis.patch.yml','appSecret: ""'),[]);
});
