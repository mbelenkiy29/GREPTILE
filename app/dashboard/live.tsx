"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
export function Live({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [active, router]);
  return active ? (
    <span className="live" role="status">
      Updating automatically
    </span>
  ) : null;
}
export function Copy({
  value,
  label = "Copy fix prompt",
}: {
  value: string;
  label?: string;
}) {
  return (
    <button
      onClick={async (event) => {
        const target = event.currentTarget;
        try {
          await navigator.clipboard.writeText(value);
          target.textContent = "Copied";
        } catch {
          target.textContent = "Copy failed; select the prompt below";
        }
      }}
    >
      {label}
    </button>
  );
}
