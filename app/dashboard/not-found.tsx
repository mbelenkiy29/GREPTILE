import { ButtonLink, EmptyState } from "../ui";

export default function DashboardNotFound() {
  return <div className="shell"><main className="content"><EmptyState title="Not found" action={<ButtonLink href="/dashboard" tone="primary">Back to the dashboard</ButtonLink>}>This page, repository or review does not exist, or you no longer have access to it.</EmptyState></main></div>;
}
