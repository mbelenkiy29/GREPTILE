# OpenReview design

The look is warm ink on parchment. Hairline borders do most of the work before any shadow
appears. One ember accent marks links and emphasis, and each screen has a single dark primary
action. The visual reference is cursor.com, via the Refero "Cursor" style. The colours below are
taken from cursor.com's own stylesheet.

All styling lives in [`app/globals.css`](app/globals.css). It uses plain CSS with semantic class
names and design tokens. There is no Tailwind, and there are no CSS modules. Markup should use the
existing classes and tokens; avoid inline colours.

## Principles

- **Hairlines before shadows.** Cards, tables and inputs use a 1px `--line` border. Only things that float get a shadow: popovers, the toast, and the app windows on the landing page.
- **One accent, used sparingly.** Ember is for links, focus rings, emphasis and the dot in the logo. Never use it as a background fill.
- **Two weights.** Inter at 400 for headings and body text, 500 for labels and small headings. Headings never use 600 or 700, and they tighten as they grow.
- **Monospace for machine text.** File paths, SHAs, timestamps, metric labels, badges and code are set in JetBrains Mono.
- **Square-ish corners.** Use 4px on controls, cards and tiles, and 8px on popovers and windows. No pills.
- **No gradients, glows, pure white or pure black.**

## Tokens

These are defined on `:root`. Dark mode overrides them under `[data-theme="dark"]` and under
`prefers-color-scheme: dark` when the theme is set to System.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f7f7f4` | `#14120b` | Page canvas |
| `--surface` | `#f2f1ed` | `#1b1913` | Cards, sections, code |
| `--surface-2` | `#ebeae5` | `#201e18` | Hover rows, landing stages, diff hunk headers |
| `--surface-3` / `--soft` | `#e6e5e0` | `#26241e` | Secondary buttons, active navigation tile |
| `--surface-4` | `#e1e0db` | `#2b2923` | Secondary button hover |
| `--text` | `#26251e` | `#edecec` | Ink: body text, primary button fill |
| `--muted` | `#64635c` | `#a09f9b` | Secondary text; meets WCAG AA on `--bg` and `--surface` |
| `--text-ter` | `#8d8c86` | `#6f6e69` | Decorative only: line numbers, list markers |
| `--line` / `--line-strong` | ink at 10% / 20% | same | Hairlines / input borders and table header rules |
| `--accent` | `#c03c00` | `#ff6a26` | Link text; a darker ember so small text meets AA |
| `--ember` | `#f54e00` | `#f54e00` | Focus ring, chart emphasis series, logo dot |
| `--primary` / `--on-primary` | ink / parchment | ink / near-black | Primary buttons |
| `--success`, `--error`, `--warning` (+ `-bg`) | `#18704f`, `#b3264a`, `#7c5011` | `#5cc49b`, `#f0718f`, `#d9a352` | Status text on translucent tints |
| `--radius` / `--radius-lg` | 4px / 8px | | Controls and cards / popovers and windows |
| `--shadow-elevated` | Cursor's product shadow | deeper | Landing app windows |
| `--shadow-popover` | soft, small | deeper | Menus and the toast |

Fonts are bundled from npm in `app/layout.tsx`, so builds never fetch them:

- `--font-sans` is Inter Variable, with `cv11` and `ss01` enabled. It is used for UI, headings and body text.
- `--font-mono` is JetBrains Mono Variable. It is used for code, paths, metadata, badges and metric labels.
- `--font-serif` is EB Garamond. It is used only for editorial subheads in review summaries and docs.

## Type scale

| Role | Size and weight | Tracking |
|---|---|---|
| Landing display | 72px / 400 (`clamp` down to 40px) | −0.03em |
| Landing section heading | 36px / 400 | −0.02em |
| Page `h1` | 36px / 400 | −0.02em |
| `h2` (card titles) | 16px / 500 | −0.005em |
| Body | 14px / 400, line height 1.55 | — |
| `.muted` | 13px | — |
| Mono metadata | 11–12px | — |

## Components

All of these are global classes in `app/globals.css`.

- **Buttons.**
  - A bare `button` or `.button` is secondary, with a `--soft` fill.
  - `.primary` is the ink fill. Use one per group.
  - `.danger` is crimson text on a crimson hairline.
  - `.small` is a compact variant.
- **Inputs.** Inputs, selects and textareas have a transparent background and a `--line-strong` border, with an ember focus ring. Selects use a custom chevron. `label` stacks its control under the text; `label.check` puts a checkbox inline with its text.
- **Cards.** A bare `section` is a card: `--surface`, a hairline border and a 4px radius. An `article` inside a card is separated by hairlines. `.empty` is a dashed, transparent card for empty states.
- **App chrome** (`app/dashboard/portal.tsx`).
  - `.portal-top` is a sticky 52px identity row, with the logo, workspace menu and profile menu, above a `.primary-nav` row of tabs. The active tab is a `--soft` tile.
  - `.secondary-nav` is a sticky 232px sidebar with mono group labels.
  - Menus are 8px popovers with `--shadow-popover`.
- **Data.**
  - `.metrics` is a hairline-divided grid with mono labels and 36px tabular numbers.
  - `.badge` is a mono 11px tinted chip, and status names map to tones. For example, `critical` and `high` are red, `medium` is amber, `completed` is green, `running` is ember, and `low` and `queued` are muted.
  - Findings show priority rather than raw severity: `priority(f)` in `app/dashboard/sections/shared.tsx` renders P0–P3 (from `src/priority.ts`) in the severity's badge tone, plus a Security tag for security findings.
  - Tables use mono muted headers and hairline rows.
  - `LineChart` and `BarList` (`app/ui/charts.tsx`) use ink, ember, green and amber series.
- **Diff** (`app/dashboard/diff-files.tsx`): mono text, translucent green and red line tints, and a finding inset card after the line it anchors to.
- **Brand.** The mark is four lines of code, the middle two indented, with an ember dot pinned beside the third: a finding on a line.
  - The lines take the text colour and invert with the theme. The dot is the one place the logo uses `--ember`.
  - Cuts share one geometry, each fitted to a pixel grid. Use each only where it is fitted:
    - **Master** (`brand/openreview-mark.svg`): 24 px and up, except at multiples of 16.
    - **Header cut** (`Mark` in `app/ui/logo.tsx`): exactly 20 px. Its edges land on whole device pixels at 2x; on 1x screens they anti-alias by half a pixel.
    - **Small cut** (`brand/openreview-mark-small.svg`): multiples of 16 px. It is the tab icon (`app/icon.svg`) and the 128 px artwork inside the 180 px `app/apple-icon.png`.
    - **Favicon tile** (`brand/openreview-favicon.svg`): `app/favicon.ico` at 16, 32 and 48 px. It is a separate 16 px drawing on an ink tile, because a static ICO cannot follow the theme.
  - Theme-following uses (`Mark`, `app/icon.svg`) recolour one geometry. The reversed files, with lines thinned for dark backgrounds, are for static artwork on ink: the apple icon, slides and print.
  - Use the one-colour version (`-mono`) where the accent can't be reproduced.
  - The Open Graph image (`app/opengraph-image.tsx`) uses the master.

## Public site

- **Shared chrome.** `SiteHeader` and `SiteFooter` (`app/site-chrome.tsx`) are shared by the landing page, docs and changelog. The footer carries the Appearance picker.
- **Landing layout** (`app/page.tsx`): left-aligned hero, then alternating 5:7 feature rows, a provider strip, "How it works", a terminal card, the comparison table, the FAQ and a closing call to action.
- **Product visuals are replicas of real screens** (`app/landing/replicas.tsx`), not drawings.
  - They render the dashboard's own markup and shared components (`DiffFiles`, `ReviewMarkdown`, `LineChart` and the `status()` badge) with sample content from `app/landing/sample.ts`. This keeps them in step with the app and its theme.
  - Each replica is `inert` and `aria-hidden`, and a visually hidden `figcaption` describes it. That keeps duplicate link and button names out of the accessibility tree.
  - When a dashboard screen changes, update the matching replica in the same change.
- **Docs and changelog** use a compact left navigation and a 768px reading column. Subheads are set in EB Garamond.

## Accessibility

- Text colours meet WCAG AA against the surfaces they sit on. `--text-ter` is never used for meaningful text.
- Focus is always visible: a 2px ember outline, or a 3px ring on inputs.
- Status is never shown by colour alone: badges always carry their text.
- Layouts hold at 390px without horizontal page scroll in both themes. Wide tables and diffs scroll inside their own containers. `pnpm test:e2e` checks this.
- `prefers-reduced-motion` turns off transitions and the skeleton pulse.

## Adding UI

1. Reuse an existing class or component before adding one. Most screens need only `section`, `.row`, `.form-grid`, `.toolbar`, `.metrics`, `.badge` and the button classes.
2. If you need a new rule, add it to the matching block of `app/globals.css` (chrome, components, dashboard features or public site) and use tokens, never raw hex values.
3. Check the screen in light and dark, at desktop width and at 390px.
