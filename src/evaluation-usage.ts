import {ModelFailure} from './engine/model';
import type {ModelProvider,ModelRequest,ModelUsage,ToolRequest,ToolTurn} from './engine/types';
import type {z} from 'zod';
/** Retain billed calls even when review validation fails or a parallel call finishes later. */
export class EvaluationUsage implements ModelProvider {
 readonly usage:ModelUsage[]=[];
 private pending=new Set<Promise<unknown>>();
 private unknownFailures=0;
 /** Present only when the wrapped provider supports native tool calling, so engine selection matches it. */
 readonly runTools?:(request:ToolRequest)=>Promise<ToolTurn>;
 constructor(private source:ModelProvider){
  const runTools=source.runTools?.bind(source);
  if(runTools)this.runTools=request=>this.track(runTools(request));
 }
 async generate<T>(request:ModelRequest,schema:z.ZodType<T>){
  return this.track(this.source.generate(request,schema));
 }
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
