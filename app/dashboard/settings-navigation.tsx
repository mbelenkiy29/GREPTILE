"use client";

import Link from "next/link";
import { useState } from "react";

export function SettingsNavigation({ groups, section, team }: {
  groups: { label: string; links: string[][] }[];
  section?: string;
  team?: string;
}) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const visible = groups.map(group => ({ ...group, links: group.links.filter(([, label]) => `${group.label} ${label}`.toLocaleLowerCase().includes(query)) })).filter(group => group.links.length);
  const count = visible.reduce((sum, group) => sum + group.links.length, 0);
  return <>
    <input type="search" aria-label="Search settings" placeholder="Search settings…" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setSearch(""); }} />
    <nav aria-label="settings navigation" className="settings-navigation">
      {visible.map(group => <section className="settings-nav-group" key={group.label} aria-label={group.label}>
        <h2>{group.label}</h2>
        <div>{group.links.map(([key, label]) => <Link key={key} href={`/dashboard/settings/${key}${team !== undefined ? `?team=${encodeURIComponent(team)}` : ""}`} aria-current={section === key ? "page" : undefined}>{label}</Link>)}</div>
      </section>)}
    </nav>
    <p className="settings-search-status" role="status">{query ? count ? `${count} matching settings` : "No matching settings. Try another search." : ""}</p>
  </>;
}
