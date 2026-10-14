import React, { Fragment } from "react";
import { priorityBadge, tagBadges } from "../../../src/priority";
// Helpers shared by the dashboard page and its section components.
export const navigation = [
  "Overview",
  "Chat",
  "Repositories",
  "Reviews",
  "Findings",
  "Knowledge",
  "Rules",
  "Team",
  "Usage",
  "Settings",
];
export const when = (value: number) =>
  new Date(value).toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  }) + " UTC";
// Priority badge (P0–P3, colored by severity) plus a Security tag for security findings.
export const priority = (f: { severity: string; category?: string }) => (
  <>
    <span className={`badge ${f.severity}`} title={`Severity: ${f.severity}`}>{priorityBadge(f.severity)}</span>
    {tagBadges(f).map((tag) => <Fragment key={tag}>{" "}<span className="badge">{tag}</span></Fragment>)}
  </>
);
export const status = (value: string) => (
  <span className={`badge ${value}`}>{value.replaceAll("_", " ")}</span>
);
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <section className="empty">
      <h2>{title}</h2>
      <p>{text}</p>
    </section>
  );
}
