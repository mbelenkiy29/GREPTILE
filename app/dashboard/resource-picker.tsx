"use client";
import { useMemo, useState } from "react";

// Checkbox list for integration resources (Confluence spaces, Jira projects): grouped by site,
// filterable, with select all/none per group and a notice for selections no longer authorized.
export function ResourcePicker({ name, legend, items, selected, empty }: { name: string; legend: string; items: { id: string; name: string }[]; selected: string[]; empty: string }) {
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState(() => new Set(selected.filter((id) => items.some((i) => i.id === id))));
  const stale = selected.filter((id) => !items.some((i) => i.id === id)).length;
  const groups = useMemo(() => {
    const map = new Map<string, { id: string; label: string }[]>();
    for (const item of items) {
      const [site, ...rest] = item.name.split(" · ");
      const label = rest.length ? rest.join(" · ") : item.name;
      if (query && !item.name.toLowerCase().includes(query.toLowerCase())) continue;
      map.set(site, [...(map.get(site) ?? []), { id: item.id, label }]);
    }
    return [...map];
  }, [items, query]);
  const set = (ids: string[], on: boolean) => setChecked((current) => { const next = new Set(current); for (const id of ids) { if (on) next.add(id); else next.delete(id); } return next; });
  return <fieldset className="wide resource-picker">
    <legend>{legend} · {checked.size} selected</legend>
    {stale > 0 && <p role="status" className="muted">{stale} previously selected {stale === 1 ? "resource is" : "resources are"} no longer authorized and will be removed when you save.</p>}
    {!items.length ? <p>{empty}</p> : <>
      {items.length > 8 && <label>Filter<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or key" /></label>}
      {[...checked].filter((id) => !groups.some(([, list]) => list.some((i) => i.id === id))).map((id) => <input key={id} type="hidden" name={name} value={id} />)}
      {groups.map(([site, list]) => <div key={site} className="resource-group">
        <div className="row"><strong>{site}</strong><span className="inline-actions"><button type="button" className="small" onClick={() => set(list.map((i) => i.id), true)}>Select all</button><button type="button" className="small" onClick={() => set(list.map((i) => i.id), false)}>Select none</button></span></div>
        {list.map((i) => <label className="check" key={i.id}><input type="checkbox" name={name} value={i.id} checked={checked.has(i.id)} onChange={(e) => set([i.id], e.target.checked)} />{i.label}</label>)}
      </div>)}
      {!groups.length && <p className="muted">No resources match “{query}”.</p>}
    </>}
  </fieldset>;
}
