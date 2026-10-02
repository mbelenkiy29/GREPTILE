import { expect, test } from "vitest";
import { createTestDb } from "./helpers/db";

test("migrations apply and pgvector is available", async () => {
  const db = await createTestDb();
  const res = await db.$client.query<{ extname: string }>("select extname from pg_extension where extname = 'vector'");
  expect(res.rows).toHaveLength(1);
});
