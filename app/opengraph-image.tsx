import { ImageResponse } from "next/og";

export const alt = "OpenReview: repository-aware pull request reviews you can run yourself";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export default function OpengraphImage() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background: "#f7f7f4", color: "#26251e", fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 36, fontWeight: 500 }}>
        <svg width="48" height="48" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#26251e" /><path d="M5.5 10.5l3 3 6-7" fill="none" stroke="#f7f7f4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        OpenReview
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 76, fontWeight: 400, lineHeight: 1.05, letterSpacing: -2 }}>Review the change.</div>
        <div style={{ fontSize: 76, fontWeight: 400, lineHeight: 1.05, letterSpacing: -2 }}>Understand the codebase.</div>
      </div>
      <div style={{ display: "flex", fontSize: 28, color: "#64635c" }}>Evidence-backed pull request reviews · self-hosted or cloud</div>
    </div>,
    size,
  );
}
