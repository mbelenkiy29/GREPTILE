import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

let client: ReturnType<typeof postgres> | undefined;

export function sql() {
  client ??= postgres(env().DATABASE_URL, { max: 10 });
  return client;
}

export function db() {
  return drizzle(sql(), { schema });
}
