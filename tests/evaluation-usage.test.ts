import test from 'node:test';import assert from 'node:assert/strict';import {z} from 'zod';import {EvaluationUsage} from '../src/evaluation-usage';import {ModelFailure} from '../src/engine/model';import type {ModelProvider,ModelUsage} from '../src/engine/types';
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
