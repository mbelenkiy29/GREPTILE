/** Stored runtime validations (R4.5) as the review output and the dashboard describe them. */
import { eq } from "drizzle-orm";
import { scoped } from "@/lib/data/tenant";
import type { Db } from "@/lib/db";
import { runtimeValidations } from "@/lib/db/schema";
import type { RuntimeValidationResult } from "@/lib/engine/types";

type Row = typeof runtimeValidations.$inferSelect;

/** A stored validation as the review output and dashboard describe it. */
export function toResult(row: Row): RuntimeValidationResult {
  const status = row.status === "queued" || row.status === "running" ? "error" : row.status;
  const failed = row.failedStep === "install" ? row.commands.install : row.commands.test;
  return {
    status,
    image: row.image,
    network: row.network === "install-only" ? "install-only" : "none",
    failedStep: row.failedStep === "install" || row.failedStep === "test" ? row.failedStep : null,
    command: failed,
    exitCode: row.exitCode,
    durationMs: row.durationMs ?? 0,
    outputExcerpt: row.outputExcerpt ?? "",
    failingTests: row.failingTests,
    reason: row.reason,
  };
}

export type RuntimeValidationView = RuntimeValidationResult & { truncated: boolean; inProgress: boolean; finishedAt: Date | null };

/** The runtime validation of one review run, for the dashboard (R4.5). */
export async function getRuntimeValidation(db: Db, orgId: string, reviewRunId: number): Promise<RuntimeValidationView | null> {
  const [row] = await db.select().from(runtimeValidations).where(scoped(runtimeValidations, orgId, eq(runtimeValidations.reviewRunId, reviewRunId)));
  if (!row) return null;
  return { ...toResult(row), truncated: row.outputTruncated, inProgress: row.status === "queued" || row.status === "running", finishedAt: row.finishedAt };
}
