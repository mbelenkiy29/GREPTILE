import {createHash} from "node:crypto";
import {z} from "zod";
import {p4DepotRecord,p4ProjectSchema,p4PathAllowed} from "./perforce";
export {p4SubmittedRevision} from "./p4-revision";

const submittedInventory=z.object({
 project:p4ProjectSchema,
 serverId:z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
 change:z.number().int().positive().safe(),
 manifest:z.array(p4DepotRecord).max(10000),
}).strict().superRefine((value,ctx)=>{
 const issue=(message:string)=>ctx.addIssue({code:z.ZodIssueCode.custom,message});
 if(value.project.deleted||!value.project.branches.length)issue("Active P4 project branches required");
 const paths=value.project.branches.flatMap(b=>b.paths);
 if(!paths.some(p=>!p.startsWith("-"))||new Set(paths.filter(p=>!p.startsWith("-")).map(p=>p.replace(/^\+/,""))).size>100||paths.some(p=>!/^[-+]?\/\/[^\0\r\n#@\\"]+$/.test(p)||p.replace(/^[-+]?\/\//,"").split("/").some(v=>!v||v==="."||v==="..")))issue("P4 project views exceed native indexing coverage");
 const seen=new Set<string>();
 for(const f of value.manifest){
  if(seen.has(f.depotFile))issue("Duplicate P4 inventory path");seen.add(f.depotFile);
  if(f.headChange>value.change||!value.project.branches.some(b=>p4PathAllowed(f.depotFile,b.paths)))issue("P4 inventory outside submitted revision or project views");
 }
});

/** Canonical operator-enumerated metadata. A hash establishes identity, not inventory completeness. */
export function p4SubmittedInventory(input:z.input<typeof submittedInventory>){
 const parsed=submittedInventory.parse(input),manifest=[...parsed.manifest].sort((a,b)=>a.depotFile.localeCompare(b.depotFile));
 const revision=`p4:${parsed.serverId}:submitted:${parsed.change}:`+createHash("sha256").update(JSON.stringify({project:parsed.project,manifest})).digest("hex");
 return {...parsed,manifest,revision};
}

/** Recompute every identity component when reading an artifact or receiving an upload. */
export function parseP4SubmittedInventory(input:unknown){
 const {revision,...metadata}=z.object({project:z.unknown(),serverId:z.unknown(),change:z.unknown(),manifest:z.unknown(),revision:z.string()}).strict().parse(input);
 const result=p4SubmittedInventory(submittedInventory.parse(metadata));
 if(revision!==result.revision)throw new Error("P4 submitted inventory revision mismatch");
 return result;
}
