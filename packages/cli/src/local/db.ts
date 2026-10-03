/**
 * Local mode's database (R3.5): an embedded Postgres (PGlite + pgvector) in `.openreview/index` at the repository
 * root, migrated with the server's own migrations, so the indexer, retrieval, and engine run unchanged.
 */
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { CliError } from "../errors";
import { ensureExcluded } from "../git";

export const LOCAL_DIR = ".openreview";
export const LOCAL_ORG_ID = "local";
const LOCAL_PROVIDER = "local";

/** The migrations folder: next to the bundle when installed (`dist/drizzle`), the repository's when run from source. */
export function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "drizzle"), path.resolve(here, "../../../../drizzle")];
  const found = candidates.find((dir) => existsSync(path.join(dir, "meta", "_journal.json")));
  if (!found) throw new CliError("The CLI's database migrations are missing; reinstall openreview.");
  return found;
}

export interface LocalDb {
  db: Db;
  dir: string;
  close(): Promise<void>;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One local review at a time per repository: PGlite's data directory is not safe for concurrent writers. */
async function lock(dir: string): Promise<() => Promise<void>> {
  const file = path.join(dir, "index.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => rm(file, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
        throw new CliError(`Another openreview review (pid ${pid}) is using this repository's local index.`, "Wait for it to finish and try again.");
      }
      await rm(file, { force: true });
    }
  }
  throw new CliError(`Couldn't lock ${file}.`, "Delete it if no openreview process is running.");
}

/** Opens (creating and migrating on first use) the repository's local index database. */
export async function openLocalDb(root: string): Promise<LocalDb> {
  const dir = path.join(root, LOCAL_DIR);
  await mkdir(dir, { recursive: true });
  await ensureExcluded(root, `/${LOCAL_DIR}/`);
  const unlock = await lock(dir);
  let client: PGlite | undefined;
  try {
    client = new PGlite(path.join(dir, "index"), { extensions: { vector } });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    const c = client;
    return {
      db,
      dir,
      close: async () => {
        await c.close();
        await unlock();
      },
    };
  } catch (err) {
    await client?.close().catch(() => undefined);
    await unlock();
    if (err instanceof CliError) throw err;
    throw new CliError(`Couldn't open the local index in ${dir}: ${(err as Error).message}`, `Delete ${LOCAL_DIR}/ to rebuild it from scratch.`);
  }
}

/** The single repository row local mode indexes into (one per local database), named after the remote. */
export async function ensureLocalRepo(db: Db, fullName: string, defaultBranch: string): Promise<typeof schema.repos.$inferSelect> {
  await db.insert(schema.orgs).values({ id: LOCAL_ORG_ID, name: "Local", slug: "local" }).onConflictDoNothing();
  let [installation] = await db.select().from(schema.installations).where(eq(schema.installations.provider, LOCAL_PROVIDER));
  if (!installation) {
    [installation] = await db
      .insert(schema.installations)
      .values({ orgId: LOCAL_ORG_ID, provider: LOCAL_PROVIDER, externalId: 0, accountLogin: "local", accountType: "User" })
      .returning();
  }
  const [existing] = await db.select().from(schema.repos).where(eq(schema.repos.installationId, installation!.id));
  if (existing) {
    if (existing.fullName === fullName && existing.defaultBranch === defaultBranch) return existing;
    const [updated] = await db.update(schema.repos).set({ fullName, defaultBranch }).where(eq(schema.repos.id, existing.id)).returning();
    return updated!;
  }
  const [created] = await db
    .insert(schema.repos)
    .values({ orgId: LOCAL_ORG_ID, installationId: installation!.id, externalId: 0, fullName, defaultBranch, private: true })
    .returning();
  return created!;
}
