import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { infraEnv } from "@/lib/env";
import * as schema from "./schema";

/** Any Drizzle Postgres database over our schema (postgres-js in prod, PGlite in tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let client: ReturnType<typeof postgres> | undefined;
let database: Db | undefined;

export function sql() {
  client ??= postgres(infraEnv().DATABASE_URL, { max: 10 });
  return client;
}

export function db(): Db {
  database ??= drizzle(sql(), { schema });
  return database;
}

export { schema };
