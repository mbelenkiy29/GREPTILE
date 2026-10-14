import type { ReactNode } from "react";
import Link from "next/link";

// A small in-repo component kit over the design tokens in globals.css (no CSS framework, so
// existing hand-written styles keep working). New UI should prefer these primitives.
type Tone = "default" | "primary" | "danger";
export function Button({ children, tone = "default", size, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: "small" }) {
  return <button {...rest} className={[tone === "primary" ? "primary" : tone === "danger" ? "danger" : "", size === "small" ? "small" : "", rest.className ?? ""].filter(Boolean).join(" ") || undefined}>{children}</button>;
}
export function ButtonLink({ href, children, tone = "default" }: { href: string; children: ReactNode; tone?: Tone }) {
  return <Link className={`button${tone === "primary" ? " primary" : ""}`} href={href}>{children}</Link>;
}
export function Card({ title, children, actions, labelledBy }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; labelledBy?: string }) {
  return <section className="card" aria-labelledby={labelledBy}>{(title || actions) && <div className="card-head">{title && <h2 id={labelledBy}>{title}</h2>}{actions}</div>}{children}</section>;
}
export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={`badge${tone ? " " + tone : ""}`}>{children}</span>;
}
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return <div className="stat"><span className="muted">{label}</span><strong>{value}</strong>{hint && <span className="muted">{hint}</span>}</div>;
}
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <section className="empty"><h2>{title}</h2>{children && <p>{children}</p>}{action}</section>;
}
export function Skeleton({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  return <div className="skeleton" role="status" aria-live="polite" aria-label={label}>{Array.from({ length: lines }, (_, i) => <span key={i} style={{ width: `${90 - i * 12}%` }} />)}</div>;
}
