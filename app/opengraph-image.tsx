import { ImageResponse } from "next/og";

export const alt = "OpenReview: repository-aware pull request reviews you can run yourself";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export default function OpengraphImage() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background: "#f7f7f4", color: "#26251e", fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 36, fontWeight: 500 }}>
        <svg width="56" height="56" viewBox="0 0 256 256">
          <rect x="75" y="44" width="136" height="28" rx="14" fill="#26251e" />
          <rect x="107" y="88" width="120" height="28" rx="14" fill="#26251e" />
          <rect x="107" y="132" width="92" height="28" rx="14" fill="#26251e" />
          <rect x="75" y="176" width="108" height="28" rx="14" fill="#26251e" />
          <circle cx="42" cy="146" r="22" fill="#f54e00" />
        </svg>
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
