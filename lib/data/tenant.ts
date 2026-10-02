import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Multi-tenant guard (R1.1): every query on a tenant-owned table goes through
 * `scoped(table, orgId, ...)`, which always ANDs in `org_id = $orgId`.
 */
export function scoped(table: { orgId: PgColumn }, orgId: string, ...conditions: (SQL | undefined)[]): SQL {
  if (!orgId) throw new Error("tenant scope requires an orgId");
  return and(eq(table.orgId, orgId), ...conditions)!;
}
