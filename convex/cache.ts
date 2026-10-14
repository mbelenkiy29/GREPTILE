import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import {internal} from "./_generated/api";
import {integrationScope,validateIntegrationScopes} from "./integrations";
import { repositoryContextValidator,validateRepositoryContext } from "./repositoryContext";
const context={repositoryContext:v.optional(repositoryContextValidator),repositoryId:v.id("repositories"),scopes:v.array(integrationScope)};
export const get = internalQuery({
  args: { organizationId: v.id("organizations"), key: v.string(),context:v.optional(v.object(context)) },
  handler: async (ctx, args) => {
    if(args.context?.repositoryContext){if(args.context.repositoryContext.repositoryId!==args.context.repositoryId)throw new Error("Cache context repository mismatch");await validateRepositoryContext(ctx,args.context.repositoryContext);}
    if(args.context)await validateIntegrationScopes(ctx,args.context.repositoryId,args.context.scopes);
    const item = await ctx.db
      .query("modelCache")
      .withIndex("by_key", (q) =>
        q.eq("organizationId", args.organizationId).eq("key", args.key),
      )
      .unique();
    return item && item.expiresAt > Date.now() ? item.result : null;
  },
});
export const set = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    key: v.string(),
    result: v.string(),
    context:v.optional(v.object(context)),
  },
  handler: async (ctx, args) => {
    if(args.context?.repositoryContext){if(args.context.repositoryContext.repositoryId!==args.context.repositoryId)throw new Error("Cache context repository mismatch");await validateRepositoryContext(ctx,args.context.repositoryContext);}
    if(args.context)await validateIntegrationScopes(ctx,args.context.repositoryId,args.context.scopes);
    if (args.result.length > 200000) return;
    const old = await ctx.db
      .query("modelCache")
      .withIndex("by_key", (q) =>
        q.eq("organizationId", args.organizationId).eq("key", args.key),
      )
      .unique();
    const data = { organizationId:args.organizationId,key:args.key,result:args.result, expiresAt: Date.now() + 86400000 };
    if (old) await ctx.db.patch(old._id, data);
    else await ctx.db.insert("modelCache", data);
  },
});
export const clearOrganization=internalMutation({args:{organizationId:v.id("organizations")},handler:async(ctx,a)=>{
 const items=await ctx.db.query("modelCache").withIndex("by_key",q=>q.eq("organizationId",a.organizationId)).take(10);
 for(const item of items)await ctx.db.delete(item._id);
 if(items.length===10)await ctx.scheduler.runAfter(0,internal.cache.clearOrganization,a);
}});
