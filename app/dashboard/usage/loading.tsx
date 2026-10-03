import { PageSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return <PageSkeleton label="Loading usage" kpis={5} rows={3} />;
}
