# Design system

Research Hub should feel like a calm, modern research tool: a light canvas,
one card style, near-black primary actions, one muted steel-blue accent used
sparingly (links, focus rings, citations), generous spacing, and no
gradients or colour blocks anywhere. Nothing in the UI
mentions pricing tiers, API keys or environment variables.

## Tokens (tailwind.config.js, src/styles/globals.css)
- Font: Inter (loaded in `_document.js`), `font-sans`.
- Colours: `text-ink` (#0F172A) for text, `text-muted` (#64748B) for secondary
  text, `border-line` (#E6E8EF) for every border, `bg-canvas` page background,
  white surfaces. Primary actions are `bg-ink`. Accent `brand-50…700` is a
  muted steel blue (#3D6A96) for links, focus, citations and AI markers.
  Status: emerald (good), amber (warn), rose (bad). No other colours, no
  gradients (`var(--grad)` is kept only as a flat ink fill for old rules).
- Radius: cards `rounded-2xl`, controls `rounded-xl`, chips `rounded-full`.
- Shadow: `shadow-card` on cards; no other shadows except menus.
- Motion: `animate-fadeIn` on mounted content, `.skeleton` for loading.

## Day and night

- The site has two themes. Day is the default; night is switched on with the
  moon button in the top bar (a sun at night) and remembered in the browser.
- The theme is one attribute, `<html data-theme="dark">`, set by
  `src/utils/theme.js` (`applyTheme`, `useTheme`). A small script in
  `_document.js` applies a remembered night theme before the first paint, so
  there is no flash of day.
- Every colour is a CSS variable holding "R G B" (`--c-ink`, `--c-white`,
  `--c-brand-500`, `--c-slate-100`, ...), defined for day in `:root` and for
  night in `:root[data-theme='dark']` in `globals.css`. Tailwind's colours
  point at those variables, so `text-ink`, `bg-white`, `border-line`,
  `bg-brand-50`, `text-slate-600`, `bg-rose-50` and the rest all follow the
  theme with no extra classes.
- At night the scales turn over: `ink` is light, `white` is a dark panel,
  tints (`-50`, `-100`) are deep and text shades (`-600`, `-700`) are light.
  `bg-ink text-white` therefore stays a high-contrast button in both.
- **Rules for new code:** use the token classes. Do not write hex colours
  for surfaces, text or borders; in inline styles use
  `rgb(var(--c-ink))` and friends. A fixed hex is fine only for a colour
  that means the same thing in both themes (a category accent, a brand
  logo). Do not use Tailwind's `dark:` variants.
- The Network Map canvas takes `theme` as a prop and paints from `THEMES`
  in `NetworkGraph.js`.
- Printing always uses the day palette.

## Components (classes in globals.css)
- `.card` + `.card-pad`: every panel. `.section-title`, `.muted`, `.eyebrow`.
- `.btn-primary` (ink), `.btn-secondary` (white), `.btn-ghost`, `.btn-danger`.
- `.chip`, `.chip-active`, `.chip-good`, `.chip-warn`, `.chip-bad`.
- `.input`, `.select` for form controls.
- `.ai-card`: wraps AI-written output (answer, brief). `.ai-badge` for the
  "AI" marker with a sparkle (`HiOutlineSparkles` from `react-icons/hi2`).
  `.gradient-text` for one accent word in a heading, used sparingly.
- `.cite`: inline citation pill `[3]`.
- `.skeleton`: shimmering placeholder blocks.
- Shell: `PageShell` (`src/components/layout/PageShell.js`) with `TopBar`
  (wordmark left; Workspaces, Watchlist and the account menu as quiet text
  on the right), the three-flow `SectionSwitch` under it as the primary
  navigation, page title/subtitle, optional `actions`; `SignInPrompt` for
  gated pages.

## Rules
- Keep every existing feature, test id and data flow; this is presentation.
- Loading states are skeletons or a short progress line ("Reading 35
  sources…"), never a bare spinner with no text.
- Empty states say what to do next in one sentence, with one action.
- Icons: `react-icons/hi2` outline set only, 15–18px, muted colour.
- Copy: short, specific, no exclamation marks. Never mention "free", "paid",
  "tier", "API key", or an environment variable name. If a capability is
  unavailable say "not enabled on this deployment" or "not available yet".
- Mobile: single column at < 768px, 16px side gutters, no horizontal scroll.
