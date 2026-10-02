import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import type { Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

let template: Promise<Blob> | undefined;

/** Migrates once per worker and snapshots the data dir, so each test gets a fresh copy cheaply. */
function migratedTemplate(): Promise<Blob> {
  template ??= (async () => {
    const client = new PGlite({ extensions: { vector } });
    await migrate(drizzle(client, { schema }), { migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle") });
    const dump = await client.dumpDataDir("none");
    await client.close();
    return dump;
  })();
  return template;
}

/** A fresh in-process Postgres (with pgvector) migrated to the current schema. */
export async function createTestDb(): Promise<Db & { $client: PGlite }> {
  const client = new PGlite({ extensions: { vector }, loadDataDir: await migratedTemplate() });
  return drizzle(client, { schema });
}
