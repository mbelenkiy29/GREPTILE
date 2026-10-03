/**
 * The review pipeline as an inline SVG (original artwork): index → understand → specialized reviewers in parallel →
 * verify → publish, with feedback looping back into the next review. Colors come from the design tokens, so it follows
 * light and dark mode. The ordered list next to it carries the same content for assistive technology.
 */

const REVIEWERS = ["Correctness", "Security", "Data", "API compat", "Testing", "Performance", "Your rules"];

function Stage({ x, n, title, sub }: { x: number; n: string; title: string; sub: string }) {
  return (
    <g transform={`translate(${x} 96)`}>
      <rect width="136" height="92" rx="12" className="pd-box" />
      <text x="16" y="28" className="pd-num">
        {n}
      </text>
      <text x="16" y="56" className="pd-title">
        {title}
      </text>
      <text x="16" y="76" className="pd-sub">
        {sub}
      </text>
    </g>
  );
}

export function PipelineDiagram() {
  const fanX = 362;
  return (
    <svg className="pipeline-diagram" viewBox="0 0 1000 312" role="img" aria-labelledby="pd-title pd-desc">
      <title id="pd-title">The OpenReview review pipeline</title>
      <desc id="pd-desc">
        A pull request flows through six stages: index the repository, understand the change with graph context, seven specialized reviewers in
        parallel, verification of every finding, publishing to the pull request, and learning from feedback, which loops back into later reviews.
      </desc>
      <defs>
        <marker id="pd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 10 5 0 10z" className="pd-arrowhead" />
        </marker>
      </defs>

      <Stage x={8} n="01" title="Index" sub="symbols & calls" />
      <path d="M144 142H178" className="pd-line" markerEnd="url(#pd-arrow)" />
      <Stage x={182} n="02" title="Understand" sub="graph context" />

      <text x={fanX} y="14" className="pd-num">
        03 · in parallel
      </text>
      {/* fan-out to parallel reviewers */}
      {REVIEWERS.map((r, i) => {
        const y = 26 + i * 36;
        return (
          <g key={r}>
            <path d={`M318 142C340 142 340 ${y + 14} ${fanX} ${y + 14}`} className="pd-line pd-thin" />
            <rect x={fanX} y={y} width="136" height="28" rx="14" className={i === REVIEWERS.length - 1 ? "pd-pill pd-pill-accent" : "pd-pill"} />
            <text x={fanX + 68} y={y + 18.5} textAnchor="middle" className="pd-pill-text">
              {r}
            </text>
            <path d={`M${fanX + 136} ${y + 14}C${fanX + 160} ${y + 14} ${fanX + 160} 142 ${fanX + 182} 142`} className="pd-line pd-thin" />
          </g>
        );
      })}

      {/* verification: a sieve that lets confirmed findings through */}
      <g transform="translate(548 96)">
        <rect width="136" height="92" rx="12" className="pd-box pd-box-accent" />
        <text x="16" y="28" className="pd-num">
          04
        </text>
        <text x="16" y="56" className="pd-title">
          Verify
        </text>
        <text x="16" y="76" className="pd-sub">
          against the code
        </text>
      </g>
      <path d="M684 142H718" className="pd-line" markerEnd="url(#pd-arrow)" />
      <Stage x={722} n="05" title="Publish" sub="summary + inline" />

      {/* learning loop back into the reviewers */}
      <path d="M790 188V276Q790 286 780 286H440Q430 286 430 276V272" className="pd-line pd-loop" markerEnd="url(#pd-arrow)" />
      <g transform="translate(612 271)">
        <rect x="-96" y="0" width="192" height="30" rx="15" className="pd-learn" />
        <text x="0" y="20" textAnchor="middle" className="pd-learn-text">
          06 · Learn from feedback
        </text>
      </g>
      <text x="870" y="142" className="pd-sub" dominantBaseline="middle">
        → your PR
      </text>
    </svg>
  );
}
