import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Applies pending SQL migrations from ./drizzle. Safe to run concurrently (drizzle takes a lock table). */
export async function runMigrations(url = process.env.DATABASE_URL, folder = path.join(process.cwd(), "drizzle")) {
  if (!url) throw new Error("DATABASE_URL is required to run migrations");
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    await client.end();
  }
}
