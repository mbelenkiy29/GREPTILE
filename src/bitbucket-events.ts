import {z} from "zod";

const uuid=z.string().transform(s=>s.replace(/^\{(.+)\}$/, "$1")).pipe(z.string().uuid());
const id=z.number().int().positive().safe();
const ref=z.object({branch:z.string().min(1).max(300),commit:z.object({hash:z.string().regex(/^[a-f0-9]{7,40}$/)})});
// Parse only the documented native event fields; comment text is retrieved through the API.
export const bitbucketEvent=z.object({
 eventType:z.enum(["avi:bitbucket:push:repository","avi:bitbucket:created:pullrequest","avi:bitbucket:updated:pullrequest","avi:bitbucket:fulfilled:pullrequest","avi:bitbucket:rejected:pullrequest","avi:bitbucket:created:pullrequest-comment","avi:bitbucket:updated:pullrequest-reviewer-status"]),
 timestamp:z.string().datetime({offset:true}),selfGenerated:z.boolean().optional(),
 actor:z.object({type:z.string().min(1).max(100),accountId:z.string().min(1).max(200).optional(),uuid:uuid.optional()}),
 repository:z.object({uuid}),workspace:z.object({uuid}),
 pullrequest:z.object({id,state:z.string().min(1).max(100),source:ref,destination:ref}).optional(),
 comment:z.object({id}).optional(),
 push:z.object({ref:z.string().min(1).max(300),mainbranch:z.boolean().optional(),closed:z.boolean(),after:z.string().regex(/^[a-f0-9]{7,40}$/).optional()}).optional(),
}).superRefine((e,ctx)=>{
 if(e.eventType.endsWith(":pullrequest-comment")&&(!e.actor.uuid||!e.actor.accountId))ctx.addIssue({code:"custom",message:"Native comment actor identity required"});
 if(e.eventType==="avi:bitbucket:push:repository"?!e.push:!e.pullrequest)ctx.addIssue({code:"custom",message:"Native event change context required"});
 if(e.eventType.endsWith(":pullrequest-comment")&&!e.comment)ctx.addIssue({code:"custom",message:"Native comment ID required"});
});
