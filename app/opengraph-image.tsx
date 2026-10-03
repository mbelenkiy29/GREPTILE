import { ImageResponse } from "next/og";

export const alt = "OpenReview — open-source AI code review with full-codebase context";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The Open Graph card (original artwork): the OpenReview mark, the tagline, and a sketch of a reviewed diff. */
export default function OpengraphImage() {
  const ink = "#8ca3ff";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background: "#0e1014", color: "#e7e9ed" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <svg width="72" height="72" viewBox="0 0 32 32">
            <rect x="1" y="1" width="30" height="30" rx="8" fill={ink} />
            <path d="M13 8.5H10a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5h3" stroke="#0b0e14" strokeWidth="2.4" strokeLinecap="round" fill="none" />
            <path d="m14.5 16 3 3 6-7" stroke="#0b0e14" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
          <div style={{ display: "flex", fontSize: 44, fontWeight: 700, letterSpacing: -1 }}>
            <span>Open</span>
            <span style={{ color: "#a3aab5", fontWeight: 400 }}>Review</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 68, fontWeight: 700, lineHeight: 1.08, letterSpacing: -2, maxWidth: 980 }}>Code review that has read the rest of the codebase.</div>
          <div style={{ display: "flex", gap: 16, fontSize: 28, color: "#a3aab5" }}>
            <span>Open source</span>
            <span style={{ color: ink }}>·</span>
            <span>AGPL-3.0</span>
            <span style={{ color: ink }}>·</span>
            <span>Self-hostable</span>
            <span style={{ color: ink }}>·</span>
            <span>Bring your own model</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 22, fontFamily: "monospace" }}>
          <div style={{ display: "flex", background: "#2e1515", color: "#f7a59c", padding: "6px 14px", borderRadius: 6 }}>- const total = computeTotal(cart.items);</div>
          <div style={{ display: "flex", background: "#12281b", color: "#8fdcae", padding: "6px 14px", borderRadius: 6, borderLeft: `6px solid ${ink}` }}>
            + const total = computeTotal(cart.items, account.region);
          </div>
        </div>
      </div>
    ),
    size,
  );
}
