import type {MutationCtx} from "./_generated/server";
import type {Doc} from "./_generated/dataModel";

export function requireP4Worker(review:Doc<"reviews">,leaseId?:string){
  if(!review.nativeP4)return;
  const lease=review.nativeP4.lease;
  if(!leaseId||!lease||lease.id!==leaseId||lease.expiresAt<=Date.now())throw new Error("P4 review worker lease expired or replaced");
}

export async function cancelReview(ctx:MutationCtx,review:Doc<"reviews">) {
  if(review.retryScheduledId){
    const scheduled=await ctx.db.system.get(review.retryScheduledId);
    if(scheduled?.state.kind==="pending")await ctx.scheduler.cancel(scheduled._id);
  }
  const now=Date.now();
  await ctx.db.patch(review._id,{status:"cancelled",updatedAt:now,finishedAt:now,retryScheduledId:undefined,retryAt:undefined});
}
