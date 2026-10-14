import test from 'node:test';import assert from 'node:assert/strict';import {z} from 'zod';import {EvaluationUsage} from '../src/evaluation-usage';import {ModelFailure} from '../src/engine/model';import type {ModelProvider,ModelUsage,ReviewInput,ToolRequest,ToolTurn} from '../src/engine/types';import {reviewChange} from '../src/engine/review';import {memoryToolbox} from '../src/engine/agent';
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
