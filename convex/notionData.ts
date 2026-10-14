import {internalMutation} from "./_generated/server";
import {v} from "convex/values";

// A Notion 401 without a refresh token means the user removed access in Notion: keep the
// connection (so admins see why) but surface a reconnect prompt.
export const markError=internalMutation({args:{id:v.id("integrationConnections"),error:v.string()},handler:async(ctx,a)=>{const c=await ctx.db.get(a.id);if(c?.active&&c.kind==="notion")await ctx.db.patch(c._id,{error:a.error.slice(0,300)});}});
