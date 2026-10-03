import { buildSearchIndex } from "@/lib/docs/content";

// Built once at build time from content/docs (R5.3); served from the app's own origin.
export const dynamic = "force-static";

export function GET() {
  return Response.json(buildSearchIndex());
}
