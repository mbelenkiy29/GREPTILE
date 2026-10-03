import { v1 } from "@/lib/api/next";

export const dynamic = "force-dynamic";

export const POST = v1("POST /reviews/runs/{runId}/cancel");
