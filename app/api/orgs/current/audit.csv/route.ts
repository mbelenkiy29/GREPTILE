import { requireOrgForRoute } from "@/lib/auth";
import { createAuditCsvHandler } from "@/lib/audit/export";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** The active org's audit log as CSV (R4.6), with the audit log page's filters. Owners and admins (`audit.read`). */
export const GET = createAuditCsvHandler(() => ({ db: db(), authorize: (req) => requireOrgForRoute(req, { permission: "audit.read" }) }));
