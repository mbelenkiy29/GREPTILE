import { v1 } from "@/lib/api/next";

export const dynamic = "force-dynamic";

export const POST = v1("POST /reviews/local");

// Reviews run inside the request; allow up to the review timeout (LOCAL_REVIEW_TIMEOUT_MS).
export const maxDuration = 300;
