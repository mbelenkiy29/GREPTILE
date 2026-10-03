/**
 * Persisted follow-up conversations (R6.17): one row per thread (an inline review thread, keyed by its root comment,
 * or a PR conversation, keyed by the PR number) and its messages. Every query is tenant-scoped.
 */
import { asc, desc, eq, lt } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { conversationMessages, conversations } from "@/lib/db/schema";
import { scoped } from "@/lib/data/tenant";

export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationMessageRow = typeof conversationMessages.$inferSelect;
export type ConversationKind = ConversationRow["kind"];

/** Messages of history passed back to the model with each new question. */
export const HISTORY_LIMIT = 10;

export async function getOrCreateConversation(
  db: Db,
  input: { orgId: string; repoId: number; prNumber: number; kind: ConversationKind; externalThreadId: number; findingId?: number | null },
): Promise<ConversationRow> {
  await db
    .insert(conversations)
    .values({
      orgId: input.orgId,
      repoId: input.repoId,
      prNumber: input.prNumber,
      kind: input.kind,
      externalThreadId: input.externalThreadId,
      findingId: input.findingId ?? null,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      scoped(
        conversations,
        input.orgId,
        eq(conversations.repoId, input.repoId),
        eq(conversations.kind, input.kind),
        eq(conversations.externalThreadId, input.externalThreadId),
      ),
    );
  if (!row) throw new Error("conversation belongs to another org");
  if (input.findingId && row.findingId !== input.findingId) {
    const [updated] = await db
      .update(conversations)
      .set({ findingId: input.findingId })
      .where(scoped(conversations, input.orgId, eq(conversations.id, row.id)))
      .returning();
    return updated ?? row;
  }
  return row;
}

/** Adds a message (once per conversation, role, and GitHub comment id) and returns it. */
export async function appendMessage(
  db: Db,
  input: {
    orgId: string;
    conversationId: number;
    role: "user" | "assistant";
    author: string;
    body: string;
    externalCommentId?: number | null;
    intent?: string | null;
  },
): Promise<ConversationMessageRow> {
  const values = {
    orgId: input.orgId,
    conversationId: input.conversationId,
    role: input.role,
    author: input.author,
    body: input.body.slice(0, 20_000),
    externalCommentId: input.externalCommentId ?? null,
    intent: input.intent ?? null,
  };
  const [inserted] = await db.insert(conversationMessages).values(values).onConflictDoNothing().returning();
  await db.update(conversations).set({ updatedAt: new Date() }).where(scoped(conversations, input.orgId, eq(conversations.id, input.conversationId)));
  if (inserted) return inserted;
  const [existing] = await db
    .select()
    .from(conversationMessages)
    .where(
      scoped(
        conversationMessages,
        input.orgId,
        eq(conversationMessages.conversationId, input.conversationId),
        eq(conversationMessages.role, input.role),
        eq(conversationMessages.externalCommentId, input.externalCommentId ?? -1),
      ),
    );
  if (!existing) throw new Error("message could not be stored");
  if (input.intent && existing.intent !== input.intent) {
    await db.update(conversationMessages).set({ intent: input.intent }).where(scoped(conversationMessages, input.orgId, eq(conversationMessages.id, existing.id)));
    return { ...existing, intent: input.intent };
  }
  return existing;
}

/** The last `limit` messages of a conversation before message `beforeId` (or all), oldest first. */
export async function recentMessages(
  db: Db,
  orgId: string,
  conversationId: number,
  opts: { beforeId?: number; limit?: number } = {},
): Promise<ConversationMessageRow[]> {
  const rows = await db
    .select()
    .from(conversationMessages)
    .where(
      scoped(
        conversationMessages,
        orgId,
        eq(conversationMessages.conversationId, conversationId),
        opts.beforeId !== undefined ? lt(conversationMessages.id, opts.beforeId) : undefined,
      ),
    )
    .orderBy(desc(conversationMessages.id))
    .limit(opts.limit ?? HISTORY_LIMIT);
  return rows.reverse();
}

/** Conversations of the org, newest activity first, optionally for one repository or pull request. */
export async function listConversations(db: Db, orgId: string, opts: { repoId?: number; prNumber?: number; limit?: number } = {}): Promise<ConversationRow[]> {
  return db
    .select()
    .from(conversations)
    .where(
      scoped(
        conversations,
        orgId,
        opts.repoId !== undefined ? eq(conversations.repoId, opts.repoId) : undefined,
        opts.prNumber !== undefined ? eq(conversations.prNumber, opts.prNumber) : undefined,
      ),
    )
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(Math.min(opts.limit ?? 50, 200));
}

/** Every message of one conversation, oldest first (empty for another org's conversation). */
export async function conversationThread(db: Db, orgId: string, conversationId: number): Promise<ConversationMessageRow[]> {
  return db
    .select()
    .from(conversationMessages)
    .where(scoped(conversationMessages, orgId, eq(conversationMessages.conversationId, conversationId)))
    .orderBy(asc(conversationMessages.id));
}
