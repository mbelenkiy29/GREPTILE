import { ImageResponse } from "next/og";

export const alt = "OpenReview: repository-aware pull request reviews you can run yourself";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export default function OpengraphImage() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background: "#0f172a", color: "#f8fafc", fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 40, fontWeight: 700 }}><span style={{ display: "flex", width: 64, height: 64, borderRadius: 14, background: "#315bbe", alignItems: "center", justifyContent: "center" }}>⌘</span>OpenReview</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ fontSize: 68, fontWeight: 700, lineHeight: 1.1 }}>Review the change.</div>
        <div style={{ fontSize: 68, fontWeight: 700, lineHeight: 1.1, color: "#93b4ff" }}>Understand the codebase.</div>
      </div>
      <div style={{ fontSize: 28, color: "#cbd5e1" }}>Evidence-backed pull request reviews · self-hosted or cloud</div>
    </div>,
    size,
  );
}
