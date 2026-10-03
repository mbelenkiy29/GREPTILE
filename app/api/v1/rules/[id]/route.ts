import { v1 } from "@/lib/api/next";

export const dynamic = "force-dynamic";

export const PATCH = v1("PATCH /rules/{id}");
export const DELETE = v1("DELETE /rules/{id}");
