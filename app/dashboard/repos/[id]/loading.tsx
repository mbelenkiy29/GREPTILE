import { PageSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return <PageSkeleton label="Loading repository" kpis={4} rows={6} />;
}
