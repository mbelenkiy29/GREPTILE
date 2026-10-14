import {ModelFailure} from './engine/model';
import type {ModelProvider,ModelRequest,ModelUsage} from './engine/types';
import type {z} from 'zod';
/** Retain billed calls even when review validation fails or a parallel call finishes later. */
export class EvaluationUsage implements ModelProvider {
 readonly usage:ModelUsage[]=[];
 private pending=new Set<Promise<unknown>>();
 private unknownFailures=0;
 constructor(private source:ModelProvider){}
 async generate<T>(request:ModelRequest,schema:z.ZodType<T>){
  const call=this.source.generate(request,schema).then(result=>{this.usage.push(result.usage);return result;},error=>{if(error instanceof ModelFailure)this.usage.push(error.usage);else this.unknownFailures++;throw error;});
  this.pending.add(call);
  try{return await call;}finally{this.pending.delete(call);}
 }
 async totals(){
  await Promise.allSettled([...this.pending]);
  return {tokens:this.usage.reduce((sum,u)=>sum+u.inputTokens+u.outputTokens,0),estimatedCost:this.usage.reduce((sum,u)=>sum+u.estimatedCost,0),usageComplete:this.unknownFailures===0};
 }
}
