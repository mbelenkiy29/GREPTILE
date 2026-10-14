/** Native submitted revision identity; usable in both Convex mutations and Node workers. */
export function p4SubmittedRevision(value:string){
 const match=/^p4:([a-zA-Z0-9_.-]{1,100}):submitted:([1-9][0-9]*):([a-f0-9]{64})$/.exec(value);
 if(!match||!Number.isSafeInteger(Number(match[2])))throw new Error("Invalid P4 submitted revision identity");
 return {serverId:match[1],change:Number(match[2]),digest:match[3]};
}
