import { PageSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return <PageSkeleton label="Loading learned patterns" rows={5} />;
}
