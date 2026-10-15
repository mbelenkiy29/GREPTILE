import { createWorkspace, logout, switchWorkspace, switchTeam } from "../actions";
import { Live } from "../live";
import { ProvidersPanel } from "../providers";
import { IntegrationsPanel } from "../integrations";
import { PreferencesPanel } from "../preferences";
import { ChatPanel } from "../chat";
import { NotificationsPanel } from "../notifications";
import { BillingPanel } from "../billing";
import { AccountPanel } from "../account";
import { EmailInvitations } from "../email-invitations";
import { ScopePanel, AuditPanel } from "../scopes";
import { AgentSettings } from "../agents";
import Link from "next/link";
import { needsSetup } from "../../../src/onboarding-steps";
import { RuntimeSettings } from "../runtime";
import { PortalNav, AnalyticsView, settingsNavigation } from "../portal";
import { WorkspaceInvitations } from "../invitations";
import { RepositoriesSection } from "../sections/repositories";
import { ReviewsSection } from "../sections/reviews";
import { FindingsSection } from "../sections/findings";
import { RulesSection } from "../sections/rules";
import { TeamSection } from "../sections/team";
import { KnowledgeSection } from "../sections/knowledge";
import { UsageSection } from "../sections/usage";
import { ReviewSettingsSection } from "../sections/settings-review";
import { navigation } from "../sections/shared";
import { loadDashboard } from "../load";

export default async function Dashboard(props: {
  params: Promise<{ section?: string[] }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await loadDashboard(props);
  const { active, data, filters, isAdmin, organization, reviewDetailId, route, savedTeam, scopes, section, selectedTeam, user, view } = ctx;
  return (
    <div className="shell">
      <PortalNav organization={(organization.name ?? "Workspace")+(selectedTeam?" / "+selectedTeam.name:"")} login={user.user.login} route={route} section={section[1]} team={filters.team} scopeSelector={<><form action={switchWorkspace}><label className="sr-only" htmlFor="workspace">Workspace</label><select key={organization._id} id="workspace" name="organizationId" defaultValue={organization._id}>{user.organizations.map(o => <option key={o._id} value={o._id}>{o.name}</option>)}</select><button className="small">Switch workspace</button></form><form action={switchTeam}><label htmlFor="scope-team">Team</label><select key={organization._id+":"+(selectedTeam?._id??"")} id="scope-team" name="teamId" defaultValue={selectedTeam?._id??""}><option value="">All accessible teams</option>{scopes.teams.map(t=><option key={t._id} value={t._id}>{t.name}</option>)}</select><input type="hidden" name="returnTo" value={"/dashboard/"+(reviewDetailId?"pulls":section.join("/"))}/><button className="small">Apply team</button></form><p className="muted">Team selection filters repository activity. Workspace administration applies across the workspace.</p><form action={createWorkspace}><label>New workspace name<input name="name" required maxLength={100}/></label><button>Create workspace</button></form></>}>
        <form action={logout}><button className="small">Sign out</button></form>
      </PortalNav>
      <main className="content">
        <header>
          <div>
            <p className="muted">{organization.name}{selectedTeam&&" / "+selectedTeam.name}</p>
            <h1>{view === "overview" ? "Analytics" : view === "reviews" ? "Pull Requests" : route === "memory" ? ({clusters:"Cross-repository context",preferences:"Learned preferences",integrations:"Integrations",rules:"Custom rules",knowledge:"Knowledge Base"}[section[1]??"rules"]??"Memory") : route === "settings" ? settingsNavigation.find(([key])=>key===section[1])?.[1] : navigation.find((n) => n.toLowerCase() === view)}</h1>
          </div>
          <Live active={active} />
        </header>
        <WorkspaceInvitations invitations={user.invitations}/>
        {savedTeam&&!selectedTeam&&filters.team===undefined&&<p role="status">Your previously selected team is no longer accessible. Showing all accessible repositories; use the workspace menu to select a team.</p>}
        {view === "overview" && needsSetup(organization) && <section className="setup-banner" aria-label="Workspace setup"><p><strong>Setup isn’t finished.</strong> {organization.onboarding?.reviewsPaused ? "Automatic reviews are paused until you choose when reviews run." : "Finish connecting repositories and choosing review behavior."}</p>{isAdmin ? <Link className="button primary small" href="/dashboard/onboarding">Resume setup</Link> : <p className="muted">A workspace admin is completing setup.</p>}</section>}
        {view === "overview" && <AnalyticsView token={user.token} organizationId={organization._id} repositories={data.repositories} filters={filters} />}
        {view === "repositories" && <RepositoriesSection ctx={ctx} />}
        {view === "reviews" && <ReviewsSection ctx={ctx} />}
        {view === "findings" && <FindingsSection ctx={ctx} />}
        {view === "rules" && !["clusters","integrations","preferences"].includes(section[1] ?? "") && <RulesSection ctx={ctx} />}
        {view === "team" && <TeamSection ctx={ctx} />}
        {view === "knowledge" && <KnowledgeSection ctx={ctx} />}
        {view === "usage" && <UsageSection ctx={ctx} />}
        {route === "settings" && section[1] === "agents" && <AgentSettings token={user.token} organizationId={organization._id} />}
        {route === "settings" && section[1] === "automation" && (isAdmin?<RuntimeSettings token={user.token} organizationId={organization._id}/>:<p>Workspace admin access required.</p>)}
        {route === "settings" && section[1] === "account" && <AccountPanel token={user.token}/>}
        {route === "settings" && section[1] === "people" && isAdmin && <EmailInvitations token={user.token} organizationId={organization._id} status={filters.emailInvite}/>}
        {route === "settings" && section[1] === "billing" && <BillingPanel token={user.token} organizationId={organization._id} filters={filters}/>}
        {route === "settings" && section[1] === "notifications" && <NotificationsPanel token={user.token} organizationId={organization._id} repositories={data.repositories} filters={filters}/>}
        {route === "chat" && <ChatPanel token={user.token} organizationId={organization._id} repositories={data.repositories} filters={filters}/>}
        {route === "memory" && section[1] === "preferences" && <PreferencesPanel token={user.token} organizationId={organization._id} repositories={data.repositories} admin={isAdmin} filters={filters}/>}
        {route === "memory" && section[1] === "integrations" && <IntegrationsPanel token={user.token} organizationId={organization._id} admin={isAdmin} repositories={data.repositories} selected={filters.integration} error={filters.error} saved={filters.saved} />}
        {route === "memory" && section[1] === "clusters" && <ScopePanel token={user.token} organizationId={organization._id} admin={isAdmin} clusters />}
        {route === "settings" && section[1] === "teams" && <ScopePanel token={user.token} organizationId={organization._id} admin={isAdmin} />}
        {route === "settings" && section[1] === "audit" && (isAdmin ? <AuditPanel token={user.token} organizationId={organization._id} cursor={filters.activityCursor} /> : <p>Workspace admin access required.</p>)}
        {route === "settings" && section[1] === "providers" && (isAdmin ? <ProvidersPanel token={user.token} organizationId={organization._id} connectionId={filters.connection} projectId={filters.project} after={filters.after} inspect={filters.inspect} /> : <p>Workspace admin access required.</p>)}
        {route === "settings" && ["review","keys"].includes(section[1]) && <ReviewSettingsSection ctx={ctx} />}
      </main>
    </div>
  );
}
