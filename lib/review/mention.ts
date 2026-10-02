import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { files, installations, mentionReplies, repos, symbols } from "@/lib/db/schema";
import type { GitHost } from "@/lib/git/types";
import { searchSymbols } from "@/lib/indexer/search";
import type { EmbeddingProvider, LlmProvider } from "@/lib/llm";
import { buildReviewContext, type ImpactedCode } from "./context";
import { isReviewablePath, parsePatch, renderDiff } from "./diff";

export const MENTION_MARKER = "<!-- tracewise:mention -->";

const SYSTEM = `You are Tracewise, answering a developer's question on a pull request. You are given the PR diff and
code retrieved from the whole repository (definitions, callers, callees, importers, similar code). Answer the
question directly and concisely in GitHub Markdown. Ground every claim in the provided code and cite locations as
\`path:line\`. If the provided code is not enough to answer with confidence, say what is missing instead of guessing.`;

export function stripMention(body: string, bot: string): string {
  const name = bot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.replace(new RegExp(`@${name}(?![\\w-])`, "gi"), "").replace(/[ \t]{2,}/g, " ").trim();
}

function identifiers(question: string): string[] {
  const ids = question.match(/`([A-Za-z_][\w.]*)`|\b([A-Za-z_]\w*(?:[A-Z_]\w*|\(\)))/g) ?? [];
  return [...new Set(ids.map((s) => s.replace(/[`()]/g, "").split(".").pop()!).filter((s) => s.length > 2))];
}

/**
 * Answers an `@tracewise` mention on a PR (R1.7) using the PR diff, the code
 * graph around it, symbols named in the question, and vector search, then
 * replies on the PR. Each source comment is answered at most once.
 */
export async function answerMention(
  deps: { db: Db; host: GitHost; llm: LlmProvider; embedder?: EmbeddingProvider; botMention: string },
  job: { orgId: string; repoId: number; prNumber: number; commentId: number; body: string; author: string },
) {
  const { db } = deps;
  const [done] = await db
    .select({ id: mentionReplies.id })
    .from(mentionReplies)
    .where(and(eq(mentionReplies.orgId, job.orgId), eq(mentionReplies.repoId, job.repoId), eq(mentionReplies.sourceCommentId, job.commentId)));
  if (done) return { status: "duplicate" as const };

  const [row] = await db
    .select({ repo: repos, installation: installations })
    .from(repos)
    .innerJoin(installations, eq(repos.installationId, installations.id))
    .where(and(eq(repos.orgId, job.orgId), eq(repos.id, job.repoId)));
  if (!row) throw new Error(`repo ${job.repoId} not found for org ${job.orgId}`);

  const question = stripMention(job.body, deps.botMention) || "Summarize this pull request.";
  const client = deps.host.client(row.installation.externalId);
  const repoName = row.repo.fullName;
  const pr = await client.getPullRequest(repoName, job.prNumber);
  const diffs = (await client.listPullRequestFiles(repoName, job.prNumber))
    .filter((f) => f.status !== "removed" && f.patch && isReviewablePath(f.path))
    .slice(0, 40)
    .map((f) => parsePatch(f.path, f.status, f.patch));
  const headContent = new Map<string, string>();
  await Promise.all(
    diffs.map(async (d) => {
      const c = await client.getFileContent(repoName, d.path, pr.headSha);
      if (c !== null) headContent.set(d.path, c);
    }),
  );
  const ctx = await buildReviewContext(
    { db, embedder: deps.embedder },
    { orgId: job.orgId, repoId: job.repoId, diffs, headContent, budgetChars: 30_000 },
  );

  // Code the question refers to directly, by name.
  const named: ImpactedCode[] = [];
  const names = identifiers(question);
  if (names.length) {
    const rows = await db
      .select({ name: symbols.name, path: files.path, startLine: symbols.startLine, endLine: symbols.endLine, content: symbols.content })
      .from(symbols)
      .innerJoin(files, eq(symbols.fileId, files.id))
      .where(and(eq(symbols.orgId, job.orgId), eq(symbols.repoId, job.repoId), inArray(symbols.name, names)))
      .limit(20);
    named.push(...rows.map((r) => ({ relation: "similar" as const, ...r, via: "named in question" })));
  }
  if (deps.embedder) {
    const [q] = await deps.embedder.embed([question]);
    if (q) {
      for (const hit of await searchSymbols(db, { orgId: job.orgId, repoId: job.repoId }, q, 6)) {
        named.push({ relation: "similar", name: hit.name, path: hit.path, startLine: hit.startLine, endLine: hit.endLine, content: hit.content, via: "semantic match" });
      }
    }
  }

  const seen = new Set<string>();
  // Graph relations first, then code named in the question, then semantic matches; first label wins.
  const graph = ctx.impacted.filter((c) => c.relation !== "similar");
  const semantic = ctx.impacted.filter((c) => c.relation === "similar");
  const code = [...graph, ...named, ...semantic].filter((c) => {
    const k = `${c.path}:${c.startLine}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const prompt = [
    `# Question from @${job.author}\n${question}`,
    `# Pull request #${pr.number}: ${pr.title}\n${pr.body.slice(0, 2000)}`,
    `## Diff\n${diffs.map(renderDiff).join("\n\n").slice(0, 30_000)}`,
    `## Repository code\n${code.map((c) => `--- ${c.path}:${c.startLine}-${c.endLine} ${c.name} (${c.relation}, ${c.via})\n${c.content}`).join("\n\n").slice(0, 40_000)}`,
  ].join("\n\n");

  const { text } = await deps.llm.text({ system: SYSTEM, prompt, effort: "medium" });
  const quoted = question.split("\n").slice(0, 3).map((l) => `> ${l}`).join("\n");
  const reply = await client.createIssueComment(repoName, job.prNumber, `${quoted}\n\n@${job.author} ${text.trim()}\n\n${MENTION_MARKER}`);

  await db
    .insert(mentionReplies)
    .values({
      orgId: job.orgId,
      repoId: job.repoId,
      prNumber: job.prNumber,
      sourceCommentId: job.commentId,
      question,
      answer: text,
      replyCommentId: reply.id,
    })
    .onConflictDoNothing();
  return { status: "answered" as const, replyCommentId: reply.id };
}
