import { effectiveSettings } from "./scopes";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {disableRepository} from "./repositories";
import {cancelReview} from "./reviewLifecycle";

export const receive = internalMutation({
  args: {
    deliveryId: v.string(),
    event: v.string(),
    payloadStorageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const old = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_delivery", (q) => q.eq("deliveryId", args.deliveryId))
      .unique();
    if (old) {
      await ctx.storage.delete(args.payloadStorageId);
      return old._id;
    }
    const deliveryId = await ctx.db.insert("webhookDeliveries", {
      ...args,
      status: "queued",
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.webhookJobs.process, {
      deliveryId,
    });
    return deliveryId;
  },
});
export const data = internalQuery({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: (ctx, args) => ctx.db.get(args.deliveryId),
});
export const mark = internalMutation({
  args: {
    deliveryId: v.id("webhookDeliveries"),
    status: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery) return;
    console.log(
      JSON.stringify({
        event: "webhook.stage",
        deliveryId: delivery.deliveryId,
        webhookEvent: delivery.event,
        status: args.status,
        attempt: delivery.attempts,
      }),
    );
    await ctx.db.patch(delivery._id, {
      status: args.status,
      error: args.error,
      attempts:
        args.status === "processing"
          ? delivery.attempts + 1
          : delivery.attempts,
      updatedAt: Date.now(),
    });
    if (args.status === "failed" && delivery.attempts < 3)
      await ctx.scheduler.runAfter(
        10000 * 2 ** delivery.attempts,
        internal.webhookJobs.process,
        { deliveryId: delivery._id },
      );
  },
});
export const repository = internalQuery({
  args: { githubId: v.number() },
  handler: async (ctx, args) => {
    const repo = await ctx.db
      .query("repositories")
      .withIndex("by_github", (q) => q.eq("githubId", args.githubId))
      .unique();
    if (!repo) return null;
    const installation = await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation", (q) =>
        q.eq("installationId", repo.installationId!),
      )
      .unique();
    if (!installation?.active) return null;
    return { repo, settings: await effectiveSettings(ctx,repo) };
  },
});
export const lifecycle = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    action: v.string(),
    fullName: v.optional(v.string()),
    defaultBranch: v.optional(v.string()),
    prNumber: v.optional(v.number()),
    state: v.optional(v.string()),
    // GitHub reports merged pull requests as closed with merged=true; other providers send "merged".
    merged: v.optional(v.boolean()),
    observedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) return;
    if (args.fullName || args.defaultBranch)
      await ctx.db.patch(repo._id, {
        ...(args.fullName ? { fullName: args.fullName } : {}),
        ...(args.defaultBranch ? { defaultBranch: args.defaultBranch } : {}),
      });
    if (["deleted", "archived", "transferred"].includes(args.action))
      await disableRepository(ctx,repo);
    if (args.prNumber && (args.state === "closed" || args.state === "merged"))
      await ctx.scheduler.runAfter(0, internal.reactionJobs.sync, { repositoryId: repo._id, prNumber: args.prNumber });
    if (args.prNumber && (args.state === "closed" || args.state === "merged")) {
      const pr = await ctx.db
        .query("pullRequests")
        .withIndex("by_repo_number", (q) =>
          q.eq("repositoryId", repo._id).eq("number", args.prNumber!),
        )
        .unique();
      if (args.observedAt!==undefined&&pr?.nativeObservedAt!==undefined&&pr.nativeObservedAt>args.observedAt)return;
      if (args.state === "merged" || (args.state === "closed" && args.merged)) await ctx.scheduler.runAfter(0, internal.commitSignals.recordMerge, { repositoryId: repo._id, prNumber: args.prNumber });
      if (pr)
        await ctx.db.patch(pr._id, {
          state: args.state,
          ...(args.observedAt !== undefined ? { nativeObservedAt: args.observedAt } : {}),
          updatedAt: Date.now(),
        });
      for (const review of await ctx.db
        .query("reviews")
        .withIndex("by_pr", (q) =>
          q.eq("repositoryId", repo._id).eq("prNumber", args.prNumber!),
        )
        .collect())
        if (!["completed", "cancelled", "failed"].includes(review.status))
          await cancelReview(ctx,review);
    }
  },
});
export const installationEvent = internalMutation({
  args: {
    installationId: v.number(),
    action: v.string(),
    repositories: v.array(
      v.object({
        id: v.number(),
        fullName: v.string(),
        defaultBranch: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const install = await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation", (q) =>
        q.eq("installationId", args.installationId),
      )
      .unique();
    if (!install) return; // Installation callbacks bind a verified owner to a workspace before webhook processing can access it.
    if (["deleted", "suspend"].includes(args.action)) {
      await ctx.db.patch(install._id, { active: false });
      for (const repo of await ctx.db
        .query("repositories")
        .withIndex("by_installation", (q) =>
          q.eq("installationId", args.installationId),
        )
        .collect())
        await disableRepository(ctx,repo);
      return;
    }
    if (args.action === "unsuspend")
      await ctx.db.patch(install._id, { active: true });
    for (const r of args.repositories) {
      const existing = await ctx.db
        .query("repositories")
        .withIndex("by_github", (q) => q.eq("githubId", r.id))
        .unique();
      if (args.action === "removed") {
        if (existing?.organizationId === install.organizationId)
          await disableRepository(ctx,existing);
        continue;
      }
      if (!existing)
        await ctx.db.insert("repositories", {
          organizationId: install.organizationId,
          installationId: install.installationId,
          githubId: r.id,
          fullName: r.fullName,
          defaultBranch: r.defaultBranch,
          enabled: false,
          indexStatus: "not_indexed",
          createdAt: Date.now(),
        });
    }
  },
});
