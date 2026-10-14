import {test,expect,vi,afterEach} from 'vitest';
import {convexTest} from 'convex-test';
import schema from '../convex/schema';
import type {Id} from '../convex/_generated/dataModel';
import {internal} from '../convex/_generated/api';
import {HttpModel,ModelFailure} from '../src/engine/model';
import {InferenceBudgetError} from '../src/inference-billing';
const modules=import.meta.glob('../convex/**/*.ts');
const quote={provider:'openai',model:'gpt-4.1',baseUrl:'https://api.openai.com/v1',inputTokenCeiling:1000,outputTokenCeiling:1000};
afterEach(()=>vi.restoreAllMocks());
test('concurrent inference reservations share a durable global cap and receipts settle once',async()=>{
 const t=convexTest(schema,modules);await t.mutation(internal.inferenceBudget.initialize,{limitMicros:15000,baselineMicros:0,source:'native fixture'});
 const reservations=await Promise.allSettled([t.mutation(internal.inferenceBudget.reserve,quote),t.mutation(internal.inferenceBudget.reserve,quote)]);
 expect(reservations.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(reservations.filter(r=>r.status==='rejected')).toHaveLength(1);
 const id=(reservations.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<Id<"inferenceReservations"> | null>).value;
 expect((await t.query(internal.inferenceBudget.status,{}))?.reservedMicros).toBe(10000);
 if(!id)throw Error("Reservation missing");
 await t.mutation(internal.inferenceBudget.settle,{id,inputTokens:100,outputTokens:10});await t.mutation(internal.inferenceBudget.settle,{id,inputTokens:100,outputTokens:10});
 expect((await t.query(internal.inferenceBudget.status,{}))?.committedMicros).toBe(280);
 await expect(t.mutation(internal.inferenceBudget.settle,{id,inputTokens:101,outputTokens:10})).rejects.toThrow('differently');
 expect(await t.mutation(internal.inferenceBudget.reserve,quote)).toBeTruthy();
});
test('missing, malformed and oversized receipts retain capacity; baseline cannot be reset',async()=>{
 const t=convexTest(schema,modules),args={limitMicros:20000,baselineMicros:10000,source:'native fixture'};const first=await t.mutation(internal.inferenceBudget.initialize,args);expect(await t.mutation(internal.inferenceBudget.initialize,args)).toBe(first);
 const id=await t.mutation(internal.inferenceBudget.reserve,quote);if(!id)throw Error();
 for(const inputTokens of [-1,NaN,Infinity,1001])await expect(t.mutation(internal.inferenceBudget.settle,{id,inputTokens,outputTokens:10})).rejects.toThrow();
 expect((await t.query(internal.inferenceBudget.status,{}))?.reservedMicros).toBe(10000);
 await expect(t.mutation(internal.inferenceBudget.reserve,quote)).rejects.toThrow('exhausted');
 await expect(t.mutation(internal.inferenceBudget.initialize,{...args,baselineMicros:0})).rejects.toThrow('cannot reset');
});
test('active budgets deny unknown model/provider/endpoint prices and preserve unconfigured self-hosting',async()=>{
 const t=convexTest(schema,modules);expect(await t.mutation(internal.inferenceBudget.reserve,quote)).toBeNull();await t.mutation(internal.inferenceBudget.initialize,{limitMicros:20000,baselineMicros:0,source:'native fixture'});
 for(const q of [{...quote,model:'unknown'},{...quote,provider:'compatible'},{...quote,baseUrl:'https://different.example/v1'}])await expect(t.mutation(internal.inferenceBudget.reserve,q)).rejects.toThrow('verified price');
 const embedding=await t.mutation(internal.inferenceBudget.reserve,{...quote,model:'text-embedding-3-small',outputTokenCeiling:0});expect(embedding).toBeTruthy();expect((await t.query(internal.inferenceBudget.status,{}))?.reservedMicros).toBe(20);
});
test('all inner and outer generation retries reserve before transmission and exhausted budget sends nothing',async()=>{
 const t=convexTest(schema,modules);await t.mutation(internal.inferenceBudget.initialize,{limitMicros:120000,baselineMicros:0,source:'retry fixture'});
 const billing={async reserve(q:typeof quote){try{return await t.mutation(internal.inferenceBudget.reserve,q);}catch{throw new InferenceBudgetError('cap exhausted');}},async settle(id:string,usage:{inputTokens:number;outputTokens:number}){await t.mutation(internal.inferenceBudget.settle,{id:id as Id<"inferenceReservations">,...usage});}};
 let sends=0;vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{sends++;return Response.json({choices:[{message:{content:'{"answer":42}'}}]});});
 for(let worker=0;worker<3;worker++)await expect(new HttpModel({provider:'openai',apiKey:'fixture',model:'gpt-4.1'},undefined,billing).generate({task:'conversation',system:'fixture',input:{}},(await import('zod')).z.object({answer:(await import('zod')).z.string()}))).rejects.toBeInstanceOf(ModelFailure);
 expect(sends).toBe(2);const state=await t.query(internal.inferenceBudget.status,{});expect(state!.reservedMicros).toBeGreaterThan(96000);expect(state!.reservedMicros+state!.committedMicros).toBeLessThanOrEqual(120000);
});
test('cached Anthropic receipts reserve at the cache-write premium and settle cache reads/writes idempotently',async()=>{
 const t=convexTest(schema,modules);await t.mutation(internal.inferenceBudget.initialize,{limitMicros:100000,baselineMicros:0,source:'cache fixture'});
 const sonnet={provider:'anthropic',model:'claude-sonnet-5-5',baseUrl:'https://api.anthropic.com/v1',inputTokenCeiling:10000,outputTokenCeiling:1000};
 const id=await t.mutation(internal.inferenceBudget.reserve,sonnet);if(!id)throw Error();
 expect((await t.query(internal.inferenceBudget.status,{}))?.reservedMicros).toBe(10000*2.5+1000*10);
 const receipt={id,inputTokens:9000,outputTokens:500,cacheReadTokens:8000,cacheWriteTokens:900};
 await t.mutation(internal.inferenceBudget.settle,receipt);await t.mutation(internal.inferenceBudget.settle,receipt);
 expect((await t.query(internal.inferenceBudget.status,{}))?.committedMicros).toBe(Math.ceil(100*2+8000*0.1+900*2.5+500*10));
 await expect(t.mutation(internal.inferenceBudget.settle,{...receipt,cacheReadTokens:7000})).rejects.toThrow('differently');
 const next=await t.mutation(internal.inferenceBudget.reserve,sonnet);if(!next)throw Error();
 await expect(t.mutation(internal.inferenceBudget.settle,{id:next,inputTokens:10,outputTokens:1,cacheReadTokens:8,cacheWriteTokens:8})).rejects.toThrow('Invalid');
});
