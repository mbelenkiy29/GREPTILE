// OpenReview mark: four lines of code with an ember dot pinned to the third, a finding on a line.
// This is the header cut (brand/openreview-mark-header.svg), drawn for 20 px: lines take the text
// colour so the mark follows the theme, and the dot keeps the ember accent.
export function Mark() {
  return <svg className="mark" viewBox="0 0 256 256" aria-hidden="true" focusable="false">
    <g fill="currentColor">
      <rect x="70.5" y="32" width="153.5" height="32" rx="16" />
      <rect x="102.5" y="83" width="140.5" height="32" rx="16" />
      <rect x="102.5" y="134.5" width="102.5" height="32" rx="16" />
      <rect x="70.5" y="185.5" width="115" height="32" rx="16" />
    </g>
    <circle className="mark-dot" cx="38.5" cy="150.5" r="28" />
  </svg>;
}
