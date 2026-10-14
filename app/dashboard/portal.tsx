import {repositoryDisplay} from "../../src/provider-display";
import Link from "next/link";
import type { ReactNode } from "react";
import type { Id, Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { backend } from "../../src/server";
import { SettingsNavigation } from "./settings-navigation";
import { PortalDisclosure } from "./portal-disclosure";
import {ThemePicker} from "../theme";
import {analyticsPeriod} from "../../src/analytics-period";
import { BarList, LineChart } from "../ui/charts";
import { setMinutesPerFinding } from "./actions";

const settingsGroups = [
  { label: "Repositories", links: [["repositories", "Add/Remove Repos"], ["providers", "Code Providers"]] },
  { label: "Agent Config", links: [["review", "Code Review"], ["agents", "Personal agents"], ["automation", "Runtime & Approval"]] },
  { label: "Admin", links: [["teams", "Teams & Inheritance"], ["people", "People"], ["usage", "Usage"], ["billing", "Billing"], ["notifications", "Notifications"]] },
  { label: "Developer", links: [["keys", "API Keys"], ["audit", "Audit Log"]] },
  { label: "Personal", links: [["account", "Account & sessions"]] },
];
export const settingsNavigation = settingsGroups.flatMap(group => group.links);

export function PortalNav({ organization, login, route, section, team,scopeSelector,children }: { organization: string; login: string; route: string; section?: string; team?:string;scopeSelector:ReactNode;children: ReactNode }) {
  const href=(path:string)=>path+(team!==undefined?"?team="+encodeURIComponent(team):"");
  const secondary = route === "memory" ? [["rules", "Custom rules"], ["clusters", "Cross-repo context"], ["knowledge", "Knowledge Base"], ["preferences", "Learned preferences"], ["integrations", "Integrations"]] : route === "settings" ? settingsNavigation : route === "pulls" ? [["", "All Pull Requests"], ["findings", "Findings"]] : [];
  return <><div className="portal-top"><div className="portal-identity"><Link className="brand" href={href("/dashboard/analytics")}><span className="mark">⌘</span> OpenReview</Link><PortalDisclosure className="scope-selector" label={organization}><div className="scope-menu">{scopeSelector}</div></PortalDisclosure><PortalDisclosure className="profile" label={`@${login}`}><div className="profile-menu"><ThemePicker/>{children}<Link href="/dashboard/onboarding">Resume setup</Link><Link href="/dashboard/settings/agents">Personal settings</Link></div></PortalDisclosure></div><nav className="primary-nav" aria-label="Main navigation">{[["analytics", "Analytics"], ["chat", "Chat"], ["memory", "Memory"], ["pulls", "Pull Requests"], ["settings", "Settings"]].map(([key,label]) => <Link key={key} href={href(`/dashboard/${key}`)} aria-current={route === key ? "page" : undefined}>{label}</Link>)}</nav></div>{secondary.length > 0 && <aside className="secondary-nav">{route === "settings" ? <SettingsNavigation groups={settingsGroups} section={section} team={team} /> : <nav aria-label={`${route} navigation`}>{secondary.map(([key,label]) => <Link key={key} href={href(`/dashboard/${route}${key ? `/${key}` : ""}`)} aria-current={(section ?? (route === "memory" ? "rules" : "")) === key ? "page" : undefined}>{label}</Link>)}</nav>}</aside>}</>;
}
export async function AnalyticsView({token,organizationId,repositories,filters}: {token:string;organizationId:Id<"organizations">;repositories:Doc<"repositories">[];filters:Record<string,string|undefined>}) {
  const now = new Date(), start = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString().slice(0,10);
  const since = filters.since ?? start, until = filters.until ?? now.toISOString().slice(0,10);
  const period=analyticsPeriod(since,until);
  const accessible=!filters.repository||repositories.some(r=>r._id===filters.repository);
  const query = new URLSearchParams({since,until,...(filters.team ? {team:filters.team}:{}),...(filters.repository ? {repository:filters.repository}:{}),...(filters.author ? {author:filters.author}:{})});
  const form=<form className="filter-bar">{filters.team!==undefined&&<input type="hidden" name="team" value={filters.team}/>}<label>Repository<select name="repository" defaultValue={filters.repository ?? ""}><option value="">All repositories</option>{repositories.map(r=><option key={r._id} value={r._id}>{repositoryDisplay(r)}</option>)}</select></label><label>Author<input name="author" defaultValue={filters.author} placeholder="All authors" /></label><label>From<input type="date" name="since" defaultValue={since} required /></label><label>Through<input type="date" name="until" defaultValue={until} required /></label><button>Apply</button>{!("error" in period)&&accessible?<a className="button" href={`/api/analytics?${query}`}>Export CSV</a>:<button type="button" disabled>Export CSV</button>}</form>;
  const problem=(message:string)=><>{form}<section role="alert"><h2>Analytics unavailable</h2><p>{message}</p><p>Correct the filters and choose Apply to retry.</p></section></>;
  if("error" in period)return problem(period.error);
  if(!accessible)return problem("Select a repository accessible in the current workspace and team.");
  let report;
  try{report=await backend().query(api.analytics.report,{token,organizationId,...period,...(filters.repository?{repositoryId:filters.repository as Id<"repositories">}:{}),...(filters.author?{author:filters.author}:{}),...(filters.team?{teamId:filters.team as Id<"teams">}:{})});}
  catch{return problem("Could not load the selected analytics. Choose a smaller period or check repository and team access, then retry.");}
  return <>{form}<div className="metrics">{[["Total PRs",report.totalPRs],["Total Reviews",report.totalReviews],["Verified findings",report.findings],["Model cost",`$${report.cost.toFixed(2)}`]].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><div className="analytics-grid"><section><h2>Review activity</h2><div className="activity-chart">{report.daily.map(d=><div key={d.date} title={`${d.date}: ${d.reviews} reviews`}><div style={{height:`${Math.max(2,d.reviews/Math.max(1,...report.daily.map(x=>x.reviews))*140)}px`}} /><small>{d.date.slice(5)}</small></div>)}</div>{!report.daily.length&&<p className="muted">No activity in this period.</p>}</section><section><h2>Findings by severity</h2>{Object.entries(report.severity).map(([severity,count])=><div className="stat-row" key={severity}><span className={`badge ${severity}`}>{severity}</span><strong>{count}</strong></div>)}</section><section><h2>Addressed rate</h2><strong className="big-stat">{report.addressedRate === null ? "—" : `${Math.round(report.addressedRate*100)}%`}</strong><p className="muted">Resolved findings / findings created in this period</p></section><section><h2>Comment usefulness</h2><strong className="big-stat">{report.usefulness===null?"Awaiting feedback":`${Math.round(report.usefulness*100)}%`}</strong><p className="muted">Positive / rated findings</p></section><section><h2>Comment reactions</h2><strong className="big-stat">👍 {report.reactions?.up ?? 0} · 👎 {report.reactions?.down ?? 0}</strong><p className="muted">Reactions on OpenReview finding comments (GitHub polled hourly and on close; GitLab via emoji webhooks)</p></section><section><h2>Average review duration</h2><strong className="big-stat">{report.averageDuration===null?"—":`${Math.round(report.averageDuration/1000)}s`}</strong></section><section><h2>Model usage</h2><strong className="big-stat">{report.tokens.toLocaleString()}</strong><p className="muted">Recorded tokens, including indexing and reviews</p></section></div><Trends token={token} organizationId={organizationId} period={period} filters={filters}/></>;
}
// Trends from the daily analytics rollup: activity, addressed rate, time saved, top repositories and authors.
async function Trends({token,organizationId,period,filters}:{token:string;organizationId:Id<"organizations">;period:{since:number;until:number};filters:Record<string,string|undefined>}) {
  let t;
  try{t=await backend().query(api.analytics.trends,{token,organizationId,...period,...(filters.repository?{repositoryId:filters.repository as Id<"repositories">}:{}),...(filters.author?{author:filters.author}:{}),...(filters.team?{teamId:filters.team as Id<"teams">}:{})});}
  catch{return <section role="alert"><h2>Trends unavailable</h2><p>Daily trends could not be loaded for these filters.</p></section>;}
  const labels=t.days.map(d=>d.day.slice(5));
  let cumulative=0,addressedSoFar=0;
  const rate=t.days.map(d=>{cumulative+=d.findings;addressedSoFar+=d.addressed;return cumulative?Math.round(addressedSoFar/cumulative*100):null;});
  return <section className="trends" aria-labelledby="trends-heading">
    <h2 id="trends-heading">Trends</h2>
    <div className="metrics"><div><span>Estimated time saved</span><strong>{t.hoursSaved} h</strong></div><div><span>Addressed rate</span><strong>{t.addressedRate===null?"—":`${Math.round(t.addressedRate*100)}%`}</strong></div><div><span>High-severity findings</span><strong>{t.totals.high}</strong></div><div><span>Addressed findings</span><strong>{t.totals.addressed}</strong></div></div>
    <p className="muted">Time saved = addressed findings × {t.minutesPerFinding} minutes per finding. Trends come from a daily rollup refreshed hourly{t.updatedAt?`, last updated ${new Date(t.updatedAt).toLocaleString("en-US",{timeZone:"UTC",dateStyle:"medium",timeStyle:"short"})} UTC`:""}.</p>
    <div className="analytics-grid">
      <section><LineChart title="Reviews and findings per day" labels={labels} series={[{label:"Reviews",values:t.days.map(d=>d.reviews)},{label:"Findings",values:t.days.map(d=>d.findings)},{label:"Addressed",values:t.days.map(d=>d.addressed)}]}/></section>
      <section><LineChart title="Addressed rate over time (cumulative %)" labels={labels} series={[{label:"Addressed %",values:rate}]} format={v=>`${v}%`}/></section>
      <section><BarList title="Top repositories by findings" items={t.byRepository.map(r=>({label:r.label,value:r.findings,detail:`${r.reviews} reviews · ${r.addressed} addressed`}))}/></section>
      <section><BarList title="Top authors by findings" items={t.byAuthor.map(r=>({label:r.label,value:r.findings,detail:`${r.reviews} reviews · ${r.addressed} addressed`}))}/></section>
    </div>
    <form action={setMinutesPerFinding} className="filter-bar"><input type="hidden" name="organizationId" value={organizationId}/><label>Minutes saved per addressed finding<input type="number" name="minutes" min={1} max={480} defaultValue={t.minutesPerFinding} required/></label><button>Update estimate</button></form>
  </section>;
}
