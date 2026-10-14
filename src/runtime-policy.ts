import { z } from "zod";
export {runtimeDefaults} from "./review-settings";
export const runtimePolicySchema=z.object({enabled:z.boolean(),image:z.string().max(300),command:z.string().max(2000),timeout:z.number().int().min(1).max(600),requiredForApproval:z.boolean(),generatedTests:z.boolean().optional(),testCommand:z.string().max(500).optional()}).superRefine((p,c)=>{
 if(p.enabled&&(!/^[-a-zA-Z0-9_./:]+@sha256:[a-f0-9]{64}$/.test(p.image)||!p.command.trim()))c.addIssue({code:z.ZodIssueCode.custom,message:"Approve a digest-pinned image and nonempty command before enabling runtime checks"});
 if(p.generatedTests&&(!/^[-a-zA-Z0-9_./:]+@sha256:[a-f0-9]{64}$/.test(p.image)||(p.testCommand??"").split("{test}").length!==2))c.addIssue({code:z.ZodIssueCode.custom,message:"Generated tests need a digest-pinned image and a test command containing {test} exactly once"});
});
export function runtimePolicyKey(p:z.infer<typeof runtimePolicySchema>){return JSON.stringify([p.enabled,p.image,p.command,p.timeout,p.requiredForApproval]);}
// Generated-test jobs are bound to the approved image, test command template and timeout.
export function generatedTestsKey(p:z.infer<typeof runtimePolicySchema>){return JSON.stringify(["tests",!!p.generatedTests,p.image,p.testCommand??"",p.timeout]);}
