import { Suspense } from "react";
import { Toaster } from "../ui/toaster";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <>{children}<Suspense fallback={null}><Toaster /></Suspense></>;
}
