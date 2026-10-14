import { Skeleton } from "../ui";

export default function Loading() {
  return <div className="shell"><main className="content"><header><div><p className="muted">Loading</p><h1>Loading…</h1></div></header><Skeleton lines={5} label="Loading dashboard" /></main></div>;
}
