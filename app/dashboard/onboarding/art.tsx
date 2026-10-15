// Guided-setup illustrations: plain SVG in ink on parchment, one ember mark per panel. They are
// decorative (aria-hidden); each panel's meaning is carried by a live text caption beside it.
// Every drawing is complete without animation, so prefers-reduced-motion only stops the motion.
import type { ReactNode } from "react";
import { basename, graphLayout, litCount } from "../../../src/onboarding-graph";

const SIZE = 320;
export function Stage({ caption, children }: { caption: string; children: ReactNode }) {
  return <div className="wizard-stage">
    <figure className="wizard-art" aria-hidden="true">{children}</figure>
    <p className="wizard-caption" aria-live="polite">{caption}</p>
  </div>;
}
function Grid() {
  return <><defs><pattern id="wizard-dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" className="art-dot" /></pattern></defs>
    <rect width={SIZE} height={SIZE} fill="url(#wizard-dots)" /></>;
}
// The OpenReview mark: four lines of code with a finding pinned beside the third.
function MarkGlyph({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`}>
    <rect className="art-ink" x="8" y="0" width="20" height="4" rx="2" /><rect className="art-ink" x="12" y="7" width="18" height="4" rx="2" />
    <rect className="art-ink" x="12" y="14" width="13" height="4" rx="2" /><rect className="art-ink" x="8" y="21" width="15" height="4" rx="2" />
    <circle className="art-ember" cx="4" cy="16" r="3.5" />
  </g>;
}
const tiles = [[52, 56], [118, 34], [236, 48], [270, 112], [40, 230], [92, 270], [214, 262], [276, 214]];
function FileTile({ x, y, index, settled }: { x: number; y: number; index: number; settled?: boolean }) {
  return <g className={`art-tile${settled ? " settled" : ""}`} style={{ ["--i" as string]: index }} transform={`translate(${x} ${y})`}>
    <path className="art-sheet" d="M0 0h11l5 5v15H0z" /><path className="art-fold" d="M11 0v5h5" />
    <rect className="art-faint" x="3" y="9" width="9" height="1.5" /><rect className="art-faint" x="3" y="13" width="7" height="1.5" />
  </g>;
}

/** Provider on the left, OpenReview on the right; the wire turns solid once connected. */
export function ConnectArt({ provider, connected }: { provider: string; connected: boolean }) {
  return <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className={connected ? "connected" : "waiting"}>
    <Grid />
    {tiles.map(([x, y], i) => <FileTile key={i} x={x} y={y} index={i} settled={connected} />)}
    <rect className="art-node" x="40" y="124" width="72" height="72" rx="4" />
    <text className="art-monogram" x="76" y="166" textAnchor="middle">{provider}</text>
    <rect className="art-node" x="208" y="124" width="72" height="72" rx="4" />
    <MarkGlyph x={226} y={146} />
    <path className="art-wire" d="M112 160 C 140 160, 180 160, 208 160" pathLength={1} />
    {connected && <circle className="art-ember art-pulse" cx="160" cy="160" r="4" />}
  </svg>;
}

/** The connected account with one leaf per repository; selected leaves fill in. */
export function RepoTreeArt({ account, repositories }: { account: string; repositories: { name: string; selected: boolean }[] }) {
  const shown = repositories.slice(0, 12), extra = repositories.length - shown.length, cols = Math.min(4, Math.max(1, shown.length));
  const any = shown.some((r) => r.selected);
  return <svg viewBox={`0 0 ${SIZE} ${SIZE}`}>
    <Grid />
    <rect className="art-node" x="110" y="28" width="100" height="36" rx="4" />
    <text className="art-label strong" x="160" y="50" textAnchor="middle">{account.slice(0, 16)}</text>
    {any && <circle className="art-ember" cx="210" cy="28" r="4" />}
    {shown.map((r, i) => {
      // Wider leaves when there are fewer columns; labels fit the leaf (about 5.5px per mono glyph).
      const width = cols <= 2 ? 132 : cols === 3 ? 92 : 68, margin = width / 2 + 6, chars = Math.floor((width - 10) / 5.5);
      const col = i % cols, row = Math.floor(i / cols), y = 124 + row * 58;
      const lx = cols === 1 ? 160 : margin + col * ((SIZE - 2 * margin) / (cols - 1)), name = r.name.split("/").pop()!;
      return <g key={r.name + i} className={`art-leaf${r.selected ? " selected" : ""}`}>
        <path className="art-branch" d={`M160 64 C 160 ${(64 + y) / 2}, ${lx} ${(64 + y) / 2}, ${lx} ${y - 12}`} pathLength={1} />
        <rect className="art-node" x={lx - width / 2} y={y - 12} width={width} height="24" rx="4" />
        <text className="art-label" x={lx} y={y + 4} textAnchor="middle">{name.length > chars ? name.slice(0, chars - 1) + "…" : name}</text>
      </g>;
    })}
    {extra > 0 && <text className="art-label" x="160" y="306" textAnchor="middle">+{extra} more</text>}
  </svg>;
}

/** Indexed files as a graph: nodes fill in with real job progress, edges draw between them. */
export function IndexGraph({ samples, processed, total, complete }: { samples: { repository: string; files: string[]; edges: [string, string][] }[]; processed: number; total: number; complete?: boolean }) {
  const paths = samples.flatMap((s) => s.files.map((f) => `${s.repository}/${f}`));
  const refs = samples.flatMap((s) => s.edges.map(([a, b]) => [`${s.repository}/${a}`, `${s.repository}/${b}`] as const));
  const layout = graphLayout(paths, refs, SIZE);
  const lit = complete ? layout.nodes.length : litCount(layout.nodes.length, processed, total);
  const labelled = new Set(layout.nodes.map((_, i) => i).filter((i) => i % Math.max(1, Math.ceil(layout.nodes.length / 8)) === 0).slice(0, 8));
  return <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className={layout.placeholder ? "placeholder" : undefined}>
    <Grid />
    <circle className="art-orbit" cx={SIZE / 2} cy={SIZE / 2} r="136" />
    {layout.edges.map(([a, b]) => <line key={`${a}-${b}`} className={`art-edge${a < lit && b < lit ? " lit" : ""}`} pathLength={1}
      x1={layout.nodes[a].x} y1={layout.nodes[a].y} x2={layout.nodes[b].x} y2={layout.nodes[b].y} />)}
    {layout.nodes.map((n, i) => <circle key={n.id} className={`art-vertex${i < lit ? " lit" : ""}`} style={{ ["--i" as string]: i % 9 }} cx={n.x} cy={n.y} r={i < lit ? 4.5 : 3.5} />)}
    {lit < layout.nodes.length && <circle className="art-scan" cx={layout.nodes[lit].x} cy={layout.nodes[lit].y} r="9" />}
    {!layout.placeholder && layout.nodes.map((n, i) => labelled.has(i) && <text key={`label-${n.id}`} className="art-label" x={n.x < SIZE / 2 ? n.x - 8 : n.x + 8} y={n.y - 7} textAnchor={n.x < SIZE / 2 ? "end" : "start"}>{basename(n.id).slice(0, 18)}</text>)}
  </svg>;
}

/** Seats around the workspace mark; invited teammates fill seats. */
export function TeamArt({ invited }: { invited: number }) {
  const seats = 8;
  return <svg viewBox={`0 0 ${SIZE} ${SIZE}`}>
    <Grid />
    <rect className="art-node" x="124" y="124" width="72" height="72" rx="4" />
    <MarkGlyph x={142} y={146} />
    {Array.from({ length: seats }, (_, i) => {
      const angle = (i / seats) * Math.PI * 2 - Math.PI / 2, x = 160 + Math.cos(angle) * 108, y = 160 + Math.sin(angle) * 108;
      return <g key={i} className={`art-seat${i < invited ? " filled" : ""}`} style={{ ["--i" as string]: i }}>
        <line className="art-branch" x1="160" y1="160" x2={x} y2={y} pathLength={1} />
        <circle className="art-node" cx={x} cy={y} r="16" />
        <circle className="art-head" cx={x} cy={y - 4} r="5" /><path className="art-head" d={`M${x - 8} ${y + 9} a8 7 0 0 1 16 0`} />
      </g>;
    })}
  </svg>;
}
