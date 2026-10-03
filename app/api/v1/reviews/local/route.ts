import { v1 } from "@/lib/api/next";

export const dynamic = "force-dynamic";

export const POST = v1("POST /reviews/local");

// Reviews run inside the request; allow up to the longest review timeout (LOCAL_REVIEW_TIMEOUT_MS, max 900s).
export const maxDuration = 900;
