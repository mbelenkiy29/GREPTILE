import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { authorize, audit } from "./auth";
import { scheduleSeatSync } from "./billing";
export const update = mutation({
  args: {
    token: v.string(),
    memberId: v.id("organizationMembers"),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member"), v.literal("viewer")),
    remove: v.boolean(),
  },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.memberId);
    if (!target) throw new Error("Member not found");
    const { member, user } = await authorize(
      ctx,
      args.token,
      target.organizationId,
      true,
    );
    if (
      (target.role === "owner" || args.role === "owner") &&
      member.role !== "owner"
    )
      throw new Error("Only owners can manage owner roles");
    if (target.role === "owner" && (args.remove || args.role !== "owner")) {
      const owners = (
        await ctx.db
          .query("organizationMembers")
          .withIndex("by_org", (q) =>
            q.eq("organizationId", target.organizationId),
          )
          .collect()
      ).filter((m) => m.role === "owner");
      if (owners.length <= 1)
        throw new Error(
          "The last workspace owner cannot be removed or demoted",
        );
    }
    if (args.remove) {
      await ctx.db.delete(target._id);
      await audit(ctx,target.organizationId,user._id,"workspace.member_removed",target._id);
    } else if(target.role!==args.role) {
      await ctx.db.patch(target._id, { role: args.role });
      await audit(ctx,target.organizationId,user._id,"workspace.member_role_changed",target._id);
    }
    await scheduleSeatSync(ctx, target.organizationId);
  },
});
