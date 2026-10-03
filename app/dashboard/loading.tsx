import { PageSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return <PageSkeleton label="Loading overview" kpis={4} rows={5} />;
}
