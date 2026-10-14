"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// Shows investigation steps as they stream, then refreshes to render the validated answer.
export function ChatStream({ messageId, initial }: { messageId: string; initial: { kind: string; text: string }[] }) {
  const router = useRouter();
  const [events, setEvents] = useState(initial);
  const [state, setState] = useState("Working…");
  useEffect(() => {
    const source = new EventSource(`/api/chat/${encodeURIComponent(messageId)}/stream`);
    const done = (label: string) => { setState(label); source.close(); router.refresh(); };
    source.addEventListener("progress", (e) => { const data = JSON.parse((e as MessageEvent).data) as { kind: string; text: string }; setEvents((list) => list.some((x) => x.text === data.text && x.kind === data.kind) ? list : [...list, data].slice(-40)); });
    source.addEventListener("answer", () => done("Answer ready"));
    source.addEventListener("error", (e) => { if ((e as MessageEvent).data) done("Failed"); });
    source.addEventListener("timeout", () => done("Still working"));
    return () => source.close();
  }, [messageId, router]);
  return <div className="chat-progress" role="status" aria-live="polite"><p className="muted">{state}</p><ol>{events.map((e, i) => <li key={i} className={e.kind}>{e.text}</li>)}</ol></div>;
}
