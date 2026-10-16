import { cookies } from "next/headers";
import { current, backend } from "../../../src/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {analyticsPeriod} from "../../../src/analytics-period";
import { apiFailure, apiIdentity } from "../../../src/api-auth";
export async function GET(request: Request) {
  // API keys (and MCP report) get the JSON report for the key's workspace; signed-in users get CSV.
  if (request.headers.get("authorization")) {
    try {
      const { token, organizationId } = await apiIdentity(request);
      const q = new URL(request.url).searchParams, period = analyticsPeriod(q.get("since") ?? "", q.get("until") ?? "");
      if ("error" in period) return Response.json({ error: period.error }, { status: 400 });
      try { return Response.json(await backend().query(api.analytics.report, { token, organizationId, ...period, ...(q.get("team") ? { teamId: q.get("team") as Id<"teams"> } : {}), ...(q.get("repository") ? { repositoryId: q.get("repository") as Id<"repositories"> } : {}), ...(q.get("author") ? { author: q.get("author")! } : {}) })); }
      catch { return Response.json({ error: "Invalid filters or access" }, { status: 400 }); }
    } catch (error) { return apiFailure(error, { status: 401, error: "Unauthorized" }); }
  }
  const user=await current(); const jar=await cookies(); const org=user.organizations.find(o=>o._id===jar.get("openreview_workspace")?.value)??user.organizations[0];
  if(!org?._id) return new Response("Workspace required",{status:403});
  const q=new URL(request.url).searchParams;
  const period=analyticsPeriod(q.get("since")??"",q.get("until")??"");
  if("error" in period)return new Response("Invalid filters or access",{status:400});
  try {const r=await backend().query(api.analytics.report,{token:user.token,organizationId:org._id,...period,...(q.get("team")?{teamId:q.get("team") as Id<"teams">}:{}),...(q.get("repository")?{repositoryId:q.get("repository") as Id<"repositories">}:{}),...(q.get("author")?{author:q.get("author")!}:{})});
    return new Response("date,reviews,findings,cost\n"+r.daily.map(d=>`${d.date},${d.reviews},${d.findings},${d.cost.toFixed(6)}`).join("\n"),{headers:{"content-type":"text/csv","content-disposition":'attachment; filename="openreview-analytics.csv"',"cache-control":"no-store"}});
  } catch {return new Response("Invalid filters or access",{status:400});}
}
