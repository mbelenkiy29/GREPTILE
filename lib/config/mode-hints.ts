/** What each review mode trades off (R4.1), for settings and onboarding. Free of server imports. */
export const REVIEW_MODE_HINTS = {
  fast: {
    label: "Fast",
    cost: "Lowest cost",
    detail: "A lighter model with low reasoning effort and a smaller diff budget. Good for busy repositories and small changes.",
  },
  standard: {
    label: "Standard",
    cost: "Balanced cost",
    detail: "The default: a strong model with moderate effort, retrieved context from the whole codebase, and independent verification.",
  },
  deep: {
    label: "Deep",
    cost: "Highest cost",
    detail: "The strongest model with maximum effort and the largest context budget. Usually several times the cost of standard.",
  },
} as const;
