import { v1 } from "@/lib/api/next";

export const dynamic = "force-dynamic";

export const GET = v1("GET /rules");
export const POST = v1("POST /rules");
