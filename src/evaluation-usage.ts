import {ModelFailure} from './engine/model';
import type {ModelProvider,ModelRequest,ModelUsage,ToolMessage,ToolRequest,ToolTurn} from './engine/types';
import type {z} from 'zod';
export type TranscriptEntry=
 |{role:'user';content:string}
 |{role:'assistant';text:string;toolCalls:{id:string;name:string;input:unknown}[]}
 |{role:'tool';results:{id:string;name:string;isError:boolean;content:string}[]};
export const transcriptResultLimit=2000;
const clip=(text:string,limit:number)=>text.length>limit?`${text.slice(0,limit)}…[${text.length-limit} more characters]`:text;
/** Readable agent transcript for evaluation reports: provider-native payloads (e.g. thinking blocks) are dropped and long text is clipped. */
export function compactTranscript(messages:ToolMessage[],limit=transcriptResultLimit):TranscriptEntry[]{
 const names=new Map<string,string>();
 return messages.map(m=>{
  if(m.role==='user')return {role:'user',content:clip(m.content,limit)};
  if(m.role==='assistant'){for(const c of m.toolCalls)names.set(c.id,c.name);return {role:'assistant',text:clip(m.content,limit),toolCalls:m.toolCalls.map(c=>({id:c.id,name:c.name,input:c.input}))};}
  return {role:'tool',results:m.results.map(r=>({id:r.id,name:names.get(r.id)??'unknown',isError:!!r.isError,content:clip(r.content,limit)}))};
 });
}
/** One line per tool call, e.g. `read_file {"path":"src/cart.ts"}`, with rejected calls marked. */
export function transcriptTrace(entries:TranscriptEntry[]):string[]{
 const errors=new Map(entries.flatMap(e=>e.role==='tool'?e.results.filter(r=>r.isError).map(r=>[r.id,r.content] as const):[]));
 return entries.flatMap(e=>e.role==='assistant'?e.toolCalls.map(c=>`${c.name} ${clip(JSON.stringify(c.input??{}),100)}${errors.has(c.id)?` → error: ${clip(errors.get(c.id)!,80)}`:''}`):[]);
}
/** Retain billed calls even when review validation fails or a parallel call finishes later. */
export class EvaluationUsage implements ModelProvider {
 readonly usage:ModelUsage[]=[];
 private pending=new Set<Promise<unknown>>();
 private unknownFailures=0;
 private toolMessages:ToolMessage[]=[];
 /** Present only when the wrapped provider supports native tool calling, so engine selection matches it. */
 readonly runTools?:(request:ToolRequest)=>Promise<ToolTurn>;
 constructor(private source:ModelProvider){
  const runTools=source.runTools?.bind(source);
  // Each tool turn resends the whole conversation, so the latest request plus its reply is the full transcript.
  if(runTools)this.runTools=async request=>{this.toolMessages=[...request.messages];const turn=await this.track(runTools(request));this.toolMessages.push(turn.message);return turn;};
 }
 async generate<T>(request:ModelRequest,schema:z.ZodType<T>){
  return this.track(this.source.generate(request,schema));
 }
 /** The tool-calling transcript so far (empty when no tool turn ran). */
 transcript(){return compactTranscript(this.toolMessages);}
 private async track<R extends {usage:ModelUsage}>(started:Promise<R>){
  const call=started.then(result=>{this.usage.push(result.usage);return result;},error=>{if(error instanceof ModelFailure)this.usage.push(error.usage);else this.unknownFailures++;throw error;});
  this.pending.add(call);
  try{return await call;}finally{this.pending.delete(call);}
 }
 async totals(){
  await Promise.allSettled([...this.pending]);
  return {tokens:this.usage.reduce((sum,u)=>sum+u.inputTokens+u.outputTokens,0),estimatedCost:this.usage.reduce((sum,u)=>sum+u.estimatedCost,0),usageComplete:this.unknownFailures===0};
 }
}
