/**
 * Identifiers of the public demo's system org (R3.7), kept free of imports so any module (git hosts, billing sweeps)
 * can recognise it. `org_demo` has no members and one placeholder installation with provider `public-demo`, which has
 * no git host: nothing may build a git client for it, and org-wide sweeps (billing, usage alerts) skip the org.
 */
export const DEMO_ORG_ID = "org_demo";
export const DEMO_PROVIDER = "public-demo";

/** System orgs that are not customers: excluded from billing, usage alerts, and other "every org" jobs. */
export const SYSTEM_ORG_IDS: readonly string[] = [DEMO_ORG_ID];

export function isSystemOrg(orgId: string): boolean {
  return SYSTEM_ORG_IDS.includes(orgId);
}
