import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

async function check(fn: () => Promise<unknown>): Promise<"ok" | string> {
  try {
    await fn();
    return "ok";
  } catch (err) {
    return err instanceof Error ? err.message : "error";
  }
}

export async function GET() {
  const [database, cache] = await Promise.all([
    check(() => sql()`select 1`),
    check(() => redis().ping()),
  ]);
  const healthy = database === "ok" && cache === "ok";
  return NextResponse.json({ status: healthy ? "ok" : "degraded", database, redis: cache }, { status: healthy ? 200 : 503 });
}
