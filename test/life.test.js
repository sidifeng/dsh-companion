import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MemoryStore} from '../src/store.js';
import {CompanionRuntime} from '../src/runtime.js';
import {validateAnalysis,consolidateMemory} from '../src/memory.js';
import {validateStories} from '../src/continuity.js';
import {AutonomyStore} from '../src/autonomy-store.js';
import {validateReflections} from '../src/interests.js';
import {SemanticMemory} from '../src/semantic.js';
import {AutonomyEngine} from '../src/autonomy.js';
import {Config} from '../src/config.js';

const start=Date.parse('2026-10-31T12:00:00+08:00'), DAY=86400000;
const e=(id='one', extra={})=>({appId:'bot',scope:'c2c',targetId:'A',senderId:'A',eventId:id,receivedAt:start,text:'今天修好了那把椅子',...extra});
const story=(extra={})=>({title:'修椅子',stage:'progress',text:'椅子已经拆开',evidence:'椅子已经拆开',subject:'speaker',confidence:.95,...extra});
const analysis=(extra={})=>({facts:[],summary:'',...extra});
const ownStore=t=>{const s=new MemoryStore(':memory:');t.after(()=>s.close());return s;};
const put=(s,event,raw)=>s.applyAnalysis(event,validateAnalysis(analysis(raw),event.text,{now:event.receivedAt,stories:s.life.list(event),plans:s.plans(event)}),s.profile(event).epoch);
const video=n=>({bvid:`BV${String(n).padStart(10,'0')}`,title:'猫玩纸箱',durationSeconds:20});
const evidence={frames:[{seconds:1,text:'一只猫钻进纸箱里，用爪子拨弄箱口。'}]};
const reflection=(extra={})=>({topic:'猫咪行为',keywords:['猫','纸箱'],evidence:'一只猫钻进纸箱里',opinion:'我喜欢这种猫自己找玩具的轻松画面。',action:'reinforce',affinity:1,...extra});
const watched=(s,n,at=start,r=reflection(),epoch=s.interests.epoch())=>{
  s.claimVideo(video(n).bvid,at);s.saveExperience(video(n),{summary:'猫钻纸箱',reaction:'很有趣',shareworthy:true,reflections:[r]},evidence,at,epoch);
};

test('经历抽取必须有本人原文和正确已有编号，假设/测试/敏感内容不能进时间线',()=>{
  assert.equal(validateStories([story()], '椅子已经拆开').length,1);
  for(const raw of [story({id:'S999'}),story({subject:'someone-else'}),story({confidence:.8}),story({evidence:'凭空编造的事'}),story({text:'我的银行卡号'})]) assert.equal(validateStories([raw],'椅子已经拆开').length,0);
  assert.equal(validateStories([story()],'这是测试，假设椅子已经拆开').length,0);
});

test('计划→进展→结果关联同一经历，已完成事件停止旧回访且不能被普通进展意外重开',t=>{
  const s=ownStore(t), event=e('plan',{text:'明天准备修椅子'});
  s.saveFollowup(event,{text:'修椅子',evidence:event.text,dueAt:start+DAY,expiresAt:start+8*DAY,audience:'person'},0);
  const id=s.life.list(event)[0].id, plan=s.plans(event)[0].id;
  put(s,e('progress',{text:'椅子已经拆开',receivedAt:start+DAY}),{stories:[story({id})]});
  put(s,e('done',{text:'今天修好了那把椅子',receivedAt:start+2*DAY}),{stories:[story({id,stage:'completed',text:'椅子修好了',evidence:'今天修好了那把椅子'})]});
  assert.equal(s.life.list(event).length,1);assert.deepEqual(s.life.detail(event,id).steps.map(s=>s.stage),['planned','progress','completed']);
  assert.equal(s.plans(event).find(p=>p.id===plan).status,'resolved');assert.equal(s.dueFollowup(event,start+3*DAY),undefined);
  put(s,e('late-progress',{text:'椅子已经拆开',receivedAt:start+3*DAY}),{stories:[story({id})]});assert.equal(s.life.detail(event,id).status,'completed');
  put(s,e('reopen',{text:'椅子又坏了重新开始修',receivedAt:start+4*DAY}),{stories:[story({id,stage:'reopened',text:'重新修椅子',evidence:'椅子又坏了重新开始修'})]});assert.equal(s.life.detail(event,id).status,'progress');
});

test('经历重放、跨身份/场景访问和删除后的迟到结果被隔离',t=>{
  const s=ownStore(t), event=e('progress',{text:'椅子已经拆开'});put(s,event,{stories:[story()]});
  assert.equal(put(s,event,{stories:[story()]}),false);const id=s.life.list(event)[0].id;
  for(const other of [{senderId:'B'},{targetId:'B'},{scope:'group'},{appId:'other'}]) assert.equal(s.life.detail({...event,...other},id),undefined);
  const epoch=s.profile(event).epoch;s.forget(event);assert.equal(s.applyAnalysis(e('late'),analysis({stories:[story()]}),epoch),false);assert.equal(s.life.list(event).length,0);
  s.setAutoMemory(event,false);assert.equal(s.applyAnalysis(e('off'),analysis({stories:[story()]}),s.profile(event).epoch),false);
});

test('同一句的两件不同经历分别保存；已结束后的同名新计划另建经历',t=>{
  const s=ownStore(t),event=e('two',{text:'今天修好了椅子，也整理好了书桌'});
  put(s,event,{stories:[story({stage:'completed',text:'椅子修好了',evidence:'今天修好了椅子'}),story({title:'整理书桌',stage:'completed',text:'书桌整理好了',evidence:'也整理好了书桌'})]});
  assert.equal(s.life.list(event).length,2);
  put(s,e('repeat',{text:'准备再修一次椅子',receivedAt:start+DAY}),{stories:[story({stage:'planned',text:'再次修椅子',evidence:'准备再修一次椅子'})]});
  assert.equal(s.life.list(event).length,3);
});

test('画像区分近期与跨日确认，偏好更新保留变化依据且不沿用旧稳定度',t=>{
  const s=ownStore(t);const fact={slot:'preference:饮品',value:'喜欢乌龙茶',evidence:'我平时喜欢喝乌龙茶',subject:'speaker',confidence:.95};
  for(let i=0;i<3;i++) put(s,e(String(i),{text:fact.evidence,receivedAt:start+i*DAY}),{facts:[fact]});
  let p=s.life.portrait(e())[0];assert.equal(p.confirmationDays,3);assert.equal(p.stability,'多日明确表达');
  put(s,e('new',{text:'我现在更喜欢喝红茶',receivedAt:start+3*DAY}),{facts:[{...fact,value:'更喜欢红茶',evidence:'我现在更喜欢喝红茶'}]});
  p=s.life.portrait(e())[0];assert.equal(p.value,'更喜欢红茶');assert.equal(p.confirmationDays,1);assert.equal(p.previous.value,'喜欢乌龙茶');
  assert.deepEqual(s.life.portrait(e('b',{senderId:'B'})),[]);
  s.editMemory(e('edit'),p.id,'喜欢白茶');p=s.life.portrait(e())[0];assert.equal(p.previous,undefined);assert.equal(p.confirmationDays,1);
});

test('更正或删除 S/E 同步清除关联旧文本、语义索引，不让旧计划复活',async t=>{
  const s=ownStore(t), event=e('p');s.saveFollowup(event,{text:'修椅子',evidence:'明天准备修椅子',dueAt:start+DAY,expiresAt:start+2*DAY,audience:'person'},0);
  const sid=s.life.list(event)[0].id,pid=s.plans(event)[0].id;
  const semantic=new SemanticMemory(s,{embed:async texts=>texts.map(()=>[1,0])});await semantic.index(event);
  assert.ok(s.db.prepare('SELECT count(*) n FROM semantic_vectors').get().n>0);
  s.editMemory(e('edit'),sid,'改为修桌子');assert.doesNotMatch(JSON.stringify(s.memoryRows(event)),/椅子/u);assert.equal(s.life.detail(event,sid).steps.length,1);
  s.editMemory(e('edit2'),pid,'实际修的是柜子');assert.doesNotMatch(JSON.stringify(s.memoryRows(event)),/桌子/u);
  s.editMemory(e('delete'),sid);assert.equal(s.plans(event).length,0);assert.equal(s.memoryRows(event).length,0);
  s.saveFollowup(e('again'),{text:'新计划',evidence:'明天准备新计划',dueAt:start+DAY,expiresAt:start+2*DAY,audience:'person'},s.profile(event).epoch);
  s.editMemory(e('deleteE'),s.plans(event)[0].id);assert.equal(s.life.list(event).length,0);
});

test('真实整理流包含已有经历与画像；事件语义检索、提示和命令贯通',async t=>{
  const runtime=new CompanionRuntime({database:':memory:',persona:'朋友'});t.after(()=>runtime.close());
  let prompt;const llm={async *stream(options){prompt=options.messages[0].content[0].text;yield {type:'text-delta',index:0,text:JSON.stringify(analysis({stories:[story({stage:'completed',text:'修好了椅子',evidence:'今天修好了那把椅子'})]}))};yield {type:'finish',reason:{kind:'stop'}};}};
  await consolidateMemory(runtime,e(),llm,{});assert.match(prompt,/knownStories/u);const id=runtime.store.life.list(e())[0].id;
  runtime.semantic=new SemanticMemory(runtime.store,{embed:async texts=>texts.map(()=>[1,0])});const current=e('recall',{text:'椅子后来怎么样了'});await runtime.prepare(current);
  const agent={};runtime.bind(agent,current);assert.match(runtime.assemble({},agent).variables.companion_continuity,/修好了椅子/u);
  assert.match(runtime.command(e('cmd',{text:`/经历 ${id}`})),/已完成/u);assert.match(runtime.command(e('portrait',{text:'/画像'})),/不.*标签/u);
});

test('schema4迁移备份保留旧事实与回访，历史关闭回访不伪造完成或取消',t=>{
  const dir=mkdtempSync(join(tmpdir(),'companion-life-')),file=join(dir,'memory.sqlite');t.after(()=>{assert.ok(dir.startsWith(join(tmpdir(),'companion-life-')));rmSync(dir,{recursive:true,force:true});});
  let s=new MemoryStore(file);s.remember(e(),'旧记忆');s.saveFollowup(e(),{text:'旧计划',evidence:'明天要办旧计划',dueAt:start+DAY,expiresAt:start+2*DAY,audience:'person'},0);s.closeFollowup(e(),s.plans(e())[0].id);
  s.db.exec('DROP TABLE stories; DROP TABLE story_steps; DROP TABLE fact_observations; PRAGMA user_version=4');s.close();
  s=new MemoryStore(file);assert.equal(s.life.list(e())[0].status,'recorded');assert.equal(s.life.detail(e(),s.life.list(e())[0].id).steps.length,1);assert.match(JSON.stringify(s.recall(e())),/旧记忆/u);s.close();
  const backup=new DatabaseSync(join(dir,readdirSync(dir).find(f=>f.includes('before-v5-'))),{readOnly:true});assert.equal(backup.prepare('PRAGMA user_version').get().user_version,4);backup.close();
});

test('兴趣只采纳实际画面连续证据，标题、伪造摘录和不在画面的关键词无效',()=>{
  assert.equal(validateReflections([reflection()],evidence).length,1);
  assert.equal(validateReflections([reflection()],{frames:[],title:'一只猫钻进纸箱里'}).length,0);
  assert.equal(validateReflections([reflection({evidence:'只从标题猜测出来'})],evidence).length,0);
  assert.equal(validateReflections([reflection({keywords:['钢琴']})],evidence).length,0);
});

test('兴趣每日有界，重复视频不增加；观点改动需要不同视频和跨日证据',t=>{
  const s=new AutonomyStore(':memory:','bot');t.after(()=>s.close());watched(s,1);const initial=s.interests.context()[0];assert.equal(initial.weight,.54);
  s.interests.apply(video(1),[reflection()],evidence,start,s.interests.epoch());assert.equal(s.interests.context()[0].weight,.54);
  const changed=reflection({action:'revise',opinion:'我更喜欢猫慢慢探索纸箱的安静画面。'});
  watched(s,2,start+1000,changed);watched(s,3,start+2000,changed);let row=s.interests.context()[0];assert.equal(row.opinion,initial.opinion);assert.ok(row.pending);assert.equal(row.weight,.54);
  watched(s,4,start+DAY,changed);row=s.interests.context()[0];assert.equal(row.opinion,changed.opinion);assert.equal(row.history[0].opinion,initial.opinion);assert.equal(row.pending,undefined);
  for(let i=5;i<30;i++)watched(s,i,start+i*DAY,reflection());assert.ok(s.interests.context()[0].weight<=.85);
});

test('重置阻止迟到兴趣写回，应用隔离且既有公开视频记录保留',t=>{
  const s=new AutonomyStore(':memory:','bot');t.after(()=>s.close());watched(s,1);const epoch=s.interests.epoch();s.interests.reset();watched(s,2,start+DAY,reflection(),epoch);
  assert.equal(s.interests.context().length,0);assert.equal(s.experiences().length,2);
  s.appId='other';assert.equal(s.experiences().length,0);s.appId='bot';watched(s,3,start+2*DAY);assert.equal(s.interests.context().length,1);
});

test('浏览选择参考积累关键词，第四次仍在原预算内探索不同候选',t=>{
  const s=new AutonomyStore(':memory:','bot');t.after(()=>s.close());watched(s,1);
  const choices=[{...video(2),title:'普通风景'},{...video(3),title:'纸箱小天地'}];
  assert.equal(s.interests.select(choices,'音乐',1).bvid,video(3).bvid);assert.equal(s.interests.select(choices,'音乐',4).bvid,video(2).bvid);
});

test('自主库升级与重启保留观察和预算，不从旧标题凭空创建观点',t=>{
  const dir=mkdtempSync(join(tmpdir(),'companion-interest-')),file=join(dir,'auto.sqlite');t.after(()=>{assert.ok(dir.startsWith(join(tmpdir(),'companion-interest-')));rmSync(dir,{recursive:true,force:true});});
  let s=new AutonomyStore(file,'bot');watched(s,1);s.reserve('browse','','2026-10-31',start,7,7200000);
  s.db.exec('DROP TABLE interests; DROP TABLE reflections; PRAGMA user_version=1');s.close();
  s=new AutonomyStore(file,'bot');assert.equal(s.experiences().length,1);assert.equal(s.interests.context().length,0);assert.equal(s.count('browse','','2026-10-31'),1);watched(s,2,start+DAY);s.close();
  s=new AutonomyStore(file,'bot');assert.equal(s.interests.context()[0].sources[0].bvid,video(2).bvid);s.close();
  s=new AutonomyStore(file,'other');assert.deepEqual(s.interests.context(),[]);s.close();assert.ok(readdirSync(dir).some(f=>f.includes('before-v2-')));
});

test('自主浏览→兴趣→群主动上下文贯通，仍受两小时与安静时段限制',async t=>{
  const config=Config({appId:'bot',autonomy:{enabled:true,browseEnabled:true,groupEnabled:true,operatorIds:['A']},access:{groupMode:'allowlist',groupAllow:['GROUP']}});
  const s=new AutonomyStore(':memory:','bot'),memory=ownStore(t);let now=start, drafts=[];const sent=[];
  const engine=new AutonomyEngine({config,store:s,memory,now:()=>now,busy:()=>false,permission:async()=>true,push:async data=>sent.push(data),tasks:{
    list:async()=>[video(1),video(2)],inspect:async()=>({analysis:{summary:'猫钻纸箱',reaction:'有趣',shareworthy:true,reflections:[reflection()]},evidence}),
    draft:async data=>{drafts.push(data);return {send:true,text:'纸箱探索的画面挺有趣。',topic:'纸箱探索',source:'video'};},
  }});t.after(async()=>{await engine.close();s.close();});
  await engine.run();assert.equal(s.interests.context().length,1);assert.equal(drafts[0].interests[0].topic,'猫咪行为');assert.equal(drafts[0].memories,undefined);assert.equal(sent.length,1);
  now+=3600000;assert.equal((await engine.run({chat:false})).browse.reason,'budget-or-interval');assert.equal(s.count('browse','','2026-10-31'),1);
  now=Date.parse('2026-10-31T23:30:00+08:00');assert.equal((await engine.run({chat:false})).browse.reason,'quiet');assert.equal(sent.length,1);
  assert.match(await engine.command(e('interest',{text:'/兴趣'})),/猫咪行为/u);assert.match(await engine.command(e('opinion',{text:'/观点 猫'})),/画面依据/u);
  assert.match(await engine.command(e('reset',{scope:'group',targetId:'GROUP',text:'/兴趣重置'})),/管理员私聊/u);
});
