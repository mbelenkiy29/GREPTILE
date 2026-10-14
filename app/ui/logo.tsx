// OpenReview mark: an ink tile with a check, drawn in the text colour so it inverts with the theme.
export function Mark() {
  return <svg className="mark" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <rect width="20" height="20" rx="4" fill="currentColor" />
    <path d="M5.5 10.5l3 3 6-7" fill="none" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
