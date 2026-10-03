/**
 * Ephemeral databases for evaluation runs (R6.24): an in-process Postgres (PGlite + pgvector) migrated once with the
 * app's own migrations and copied per case, so the indexer, retrieval, and engine run unchanged and cases never share
 * state. Nothing is written to the configured DATABASE_URL.
 */
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

const MIGRATIONS = path.resolve(import.meta.dirname, "../../drizzle");

let template: Promise<Blob> | undefined;

function migratedTemplate(): Promise<Blob> {
  template ??= (async () => {
    const client = new PGlite({ extensions: { vector } });
    await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS });
    const dump = await client.dumpDataDir("none");
    await client.close();
    return dump;
  })();
  return template;
}

/** A fresh migrated database; `close()` releases it. */
export async function ephemeralDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite({ extensions: { vector }, loadDataDir: await migratedTemplate() });
  return { db: drizzle(client, { schema }), close: () => client.close() };
}
