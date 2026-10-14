import {z} from 'zod';
import {reviewSummarySchema} from './engine/review';
export function conversationAnswerSchema(sources:{path:string;content:string}[]){
 return z.object({answer:z.string().min(20).max(12000),citations:z.array(z.object({filePath:z.string(),startLine:z.number().int().positive(),quote:z.string().min(1).max(2000)})).max(10)}).superRefine((value,ctx)=>{
  const execution=reviewSummarySchema(undefined,[]).safeParse({summary:value.answer});
  if(!execution.success)for(const issue of execution.error.issues)ctx.addIssue({code:z.ZodIssueCode.custom,message:issue.message});
  if(sources.length&&!value.citations.length)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Cite at least one fetched source; describe unavailable context explicitly.'});
  for(const citation of value.citations){
   const source=sources.find(s=>s.path===citation.filePath);
   if(!source||source.content.split('\n').slice(citation.startLine-1,citation.startLine-1+citation.quote.split('\n').length).join('\n').trim()!==citation.quote.trim())ctx.addIssue({code:z.ZodIssueCode.custom,message:'Citation must match fetched current source at its recorded line: '+citation.filePath});
  }
 });
}
