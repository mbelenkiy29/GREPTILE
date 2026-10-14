import test from 'node:test';import assert from 'node:assert/strict';import {z} from 'zod';import {EvaluationUsage,compactTranscript,transcriptTrace,transcriptResultLimit} from '../src/evaluation-usage';import {ModelFailure} from '../src/engine/model';import type {ModelProvider,ModelUsage,ReviewInput,ToolRequest,ToolTurn} from '../src/engine/types';import {reviewChange} from '../src/engine/review';import {memoryToolbox,reportReminder} from '../src/engine/agent';
const usage:ModelUsage={provider:'fixture',model:'fixture',task:'verify',inputTokens:10,outputTokens:5,latencyMs:1,estimatedCost:.01,cached:false};
test('evaluation retains failed billed attempts and awaits parallel usage',async()=>{
 let finish!:()=>void;const waiting=new Promise<void>(resolve=>{finish=resolve;});
 const source:ModelProvider={async generate(request,schema){if(request.task==='fail')throw new ModelFailure('Validation rejected output',usage);await waiting;return {value:schema.parse({ok:true}),usage:{...usage,estimatedCost:.02}};}};
 const tracked=new EvaluationUsage(source),pending=tracked.generate({task:'parallel',system:'',input:{}},z.object({ok:z.boolean()}));
 await assert.rejects(tracked.generate({task:'fail',system:'',input:{}},z.unknown()),/Validation rejected/);
 const totals=tracked.totals();finish();await pending;assert.deepEqual(await totals,{tokens:30,estimatedCost:.03,usageComplete:true});
});
test('unaccounted provider errors are explicit instead of silently reported as zero cost',async()=>{
 const tracked=new EvaluationUsage({async generate(){throw Error('Provider response unavailable');}});
 await assert.rejects(tracked.generate({task:'fail',system:'',input:{}},z.unknown()));assert.deepEqual(await tracked.totals(),{tokens:0,estimatedCost:0,usageComplete:false});
});
test('tool calling passes through with usage tracked, so evaluations can run the agentic engine',async()=>{
 const plain:ModelProvider={async generate(){throw Error('unused');}};
 assert.equal(new EvaluationUsage(plain).runTools,undefined,'providers without tool calling keep falling back to the pipeline');
 const head='b'.repeat(40),turns:ToolRequest[]=[];
 const source:ModelProvider={
  async runTools(request):Promise<ToolTurn>{turns.push(request);if(request.task==='fail')throw new ModelFailure('Tool turn rejected',{...usage,task:'fail'});return {content:'Done.',toolCalls:[],stopReason:'end_turn',message:{role:'assistant',content:'Done.',toolCalls:[]},usage:{...usage,task:request.task,estimatedCost:.02}};},
  async generate(request,schema){return {value:schema.parse({summary:'The change was investigated and no verified defects were found.',reviewScore:{value:5,reason:'The investigation found no verified defects.'}}),usage:{...usage,task:request.task}};},
 };
 const tracked=new EvaluationUsage(source);
 const input:ReviewInput={repository:'acme/shop',baseSha:'a'.repeat(40),headSha:head,title:'Totals',description:'',rules:[],mode:'standard',diff:[{path:'src/change.ts',status:'modified',patch:'@@ -1 +1 @@\n-export const total = (c: number) => c;\n+export const total = (c: number) => c / 100;'}],files:[{path:'src/change.ts',sha:head,content:'export const total = (c: number) => c / 100;'}]};
 const result=await reviewChange(input,tracked,async()=>{},undefined,{engine:'agentic',tools:memoryToolbox(input.files,head)});
 assert.equal(result.metadata.engine,'agentic');
 assert.ok(turns.length>=1&&tracked.usage.some(u=>u.estimatedCost===.02),'tool turns are billed in the evaluation totals');
 await assert.rejects(tracked.runTools!({task:'fail',system:'',messages:[],tools:[]}),/Tool turn rejected/);
 assert.ok(tracked.usage.some(u=>u.task==='fail'),'a rejected tool turn still records its billed usage');
 assert.equal((await tracked.totals()).usageComplete,true);
});
test('transcripts drop provider payloads, name tool results, clip long output and mark rejected calls',()=>{
 const entries=compactTranscript([
  {role:'user',content:'Review this pull request.'},
  {role:'assistant',content:'',toolCalls:[{id:'a',name:'read_file',input:{path:'src/cart.ts'}},{id:'b',name:'approve_pr',input:{}}],providerContent:[{type:'thinking',thinking:'private reasoning',signature:'sig'}],provider:'anthropic'},
  {role:'tool',results:[{id:'a',content:'x'.repeat(transcriptResultLimit+50)},{id:'b',content:'Unknown tool approve_pr',isError:true}]},
 ]);
 assert.ok(!JSON.stringify(entries).includes('private reasoning'),'provider-native content is not copied into reports');
 const tool=entries[2];assert.ok(tool.role==='tool');
 assert.deepEqual(tool.results.map(r=>[r.name,r.isError]),[['read_file',false],['approve_pr',true]]);
 assert.ok(tool.results[0].content.endsWith('…[50 more characters]')&&tool.results[0].content.length<transcriptResultLimit+30);
 assert.deepEqual(transcriptTrace(entries),['read_file {"path":"src/cart.ts"}','approve_pr {} → error: Unknown tool approve_pr']);
});
test('an agentic evaluation captures the full transcript, including the reminder turn',async()=>{
 const head='b'.repeat(40);let turn=0;
 const source:ModelProvider={
  async runTools(request):Promise<ToolTurn>{turn++;const toolCalls=turn===1?[{id:'r1',name:'read_file',input:{path:'src/change.ts'}}]:[];return {content:toolCalls.length?'':'No findings.',toolCalls,stopReason:toolCalls.length?'tool_use':'end_turn',message:{role:'assistant',content:toolCalls.length?'':'No findings.',toolCalls},usage:{...usage,task:request.task}};},
  async generate(request,schema){return {value:schema.parse({summary:'The change was investigated and no verified defects were found.',reviewScore:{value:5,reason:'The investigation found no verified defects.'}}),usage:{...usage,task:request.task}};},
 };
 const tracked=new EvaluationUsage(source);
 const input:ReviewInput={repository:'acme/shop',baseSha:'a'.repeat(40),headSha:head,title:'Totals',description:'',rules:[],mode:'standard',diff:[{path:'src/change.ts',status:'modified',patch:'@@ -1 +1 @@\n-export const total = (c: number) => c;\n+export const total = (c: number) => c / 100;'}],files:[{path:'src/change.ts',sha:head,content:'export const total = (c: number) => c / 100;'}]};
 assert.deepEqual(tracked.transcript(),[]);
 await reviewChange(input,tracked,async()=>{},undefined,{engine:'agentic',tools:memoryToolbox(input.files,head)});
 const entries=tracked.transcript();
 assert.deepEqual(entries.map(e=>e.role),['user','assistant','tool','assistant','user','assistant']);
 const read=entries[2];assert.ok(read.role==='tool'&&read.results[0].name==='read_file'&&read.results[0].content.includes('export const total'));
 assert.deepEqual(entries[4],{role:'user',content:reportReminder});
 assert.deepEqual(transcriptTrace(entries),['read_file {"path":"src/change.ts"}']);
});
