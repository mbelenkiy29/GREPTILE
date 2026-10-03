import { z } from "zod";

/**
 * The fields OpenReview reads from GitHub webhook payloads (R1.2). Payloads are signed by GitHub but still external
 * input: each event is parsed with its schema before routing. Unknown fields are dropped; only what routing needs is
 * required, so new GitHub fields never break intake.
 */

export const actorSchema = z.object({
  login: z.string().optional(),
  id: z.number().optional(),
  type: z.string().optional(),
});
export type Actor = z.infer<typeof actorSchema>;

const actor = actorSchema.nullish();
const installationRef = z.object({ id: z.number() });
const repositorySchema = z.object({
  id: z.number(),
  full_name: z.string().optional(),
  default_branch: z.string().nullish(),
  private: z.boolean().nullish(),
  archived: z.boolean().nullish(),
});

/** Fields every event may carry; used to resolve correlation ids before routing. */
export const envelopeSchema = z.object({
  action: z.string().optional(),
  installation: installationRef.optional(),
  repository: repositorySchema.optional(),
  sender: actor,
});

export const pullRequestPayload = envelopeSchema.extend({
  action: z.string(),
  pull_request: z.object({
    number: z.number(),
    draft: z.boolean().nullish(),
    head: z.object({ sha: z.string(), ref: z.string().optional() }).optional(),
    base: z.object({ sha: z.string(), ref: z.string() }).optional(),
    user: actor,
  }),
});

export const issueCommentPayload = envelopeSchema.extend({
  action: z.string(),
  issue: z.object({ number: z.number(), pull_request: z.record(z.string(), z.unknown()).nullish() }),
  comment: z.object({ id: z.number(), body: z.string().nullish(), user: actor, author_association: z.string().nullish() }),
});

export const reviewCommentPayload = envelopeSchema.extend({
  action: z.string(),
  pull_request: z.object({ number: z.number() }),
  comment: z.object({
    id: z.number(),
    body: z.string().nullish(),
    user: actor,
    path: z.string().nullish(),
    line: z.number().nullish(),
    original_line: z.number().nullish(),
    in_reply_to_id: z.number().nullish(),
    author_association: z.string().nullish(),
  }),
});

export const reviewPayload = envelopeSchema.extend({
  action: z.string(),
  pull_request: z.object({ number: z.number() }),
  review: z.object({ id: z.number(), body: z.string().nullish(), user: actor, author_association: z.string().nullish() }),
});

export const pushPayload = envelopeSchema.extend({
  ref: z.string(),
  after: z.string(),
  deleted: z.boolean().nullish(),
  repository: repositorySchema,
});

export const installationPayload = envelopeSchema.extend({
  action: z.string(),
  installation: z.object({
    id: z.number(),
    account: z.object({ login: z.string().optional(), slug: z.string().optional(), type: z.string().optional() }).nullish(),
    target_type: z.string().optional(),
    permissions: z.record(z.string(), z.string()).optional(),
    repository_selection: z.string().optional(),
  }),
});

export const installationRepositoriesPayload = envelopeSchema.extend({
  action: z.string(),
  installation: z.object({ id: z.number(), repository_selection: z.string().optional() }),
  repository_selection: z.string().optional(),
});

export const repositoryPayload = envelopeSchema.extend({
  action: z.string(),
  installation: installationRef,
  repository: repositorySchema.extend({ full_name: z.string() }),
  changes: z
    .object({ default_branch: z.object({ from: z.string() }).optional() })
    .nullish(),
});
