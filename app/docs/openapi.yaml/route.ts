import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-static";
export async function GET() {
  return new Response(await fs.readFile(path.join(process.cwd(), "docs", "openapi.yaml"), "utf8"), { headers: { "content-type": "application/yaml; charset=utf-8" } });
}
