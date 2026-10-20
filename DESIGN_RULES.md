# Design rules — phone and laptop, one codebase

Every screen must work on the store phone (390px wide) and on a laptop (1280px) without a separate layout.
`test/e2e/responsive.mjs` enforces the measurable parts on every page at both widths; a change that breaks them does not merge to `main`.

## Layout
1. **One column of content.** 640px max on phones, 760px on laptops, left-aligned next to the sidebar. Never a wide dashboard grid.
2. **Navigation is one component** (`Tabs` in `lib/app/ui.tsx`). CSS turns it into bottom tabs under 900px and a left sidebar at 900px and up. Pages never render their own nav.
3. **Gutters:** 16px each side on phones; content never touches the edge. No horizontal scrolling, ever (`scrollWidth <= innerWidth` is asserted).
4. **Bottom clearance:** `main` keeps 120px of bottom padding on phones so the last button is never under the tab bar.
5. **Two-column form rows** (`.grid2`) are the only side-by-side layout, and every cell has `min-width: 0`.

## Touch and reading
6. Every tap target is at least 44px tall (buttons, tabs, inputs).
7. Inputs are 17px text so iOS does not zoom when focused. Money inputs use `inputMode="decimal"`.
8. Body text 15–16px, headings 22px, never smaller than 12px for labels.
9. Dark theme by default; every color comes from a CSS variable in `globals.css`.

## Plain language
10. Each page has a one-sentence `help` line under its title saying what the page is for.
11. Home shows the four-step flow (Drop → Close → Collect & deposit → Verify) and a "Your next step" line that depends on who is signed in. On phones the flow is one compact row (tap for the full text) so today's numbers stay on the first screen; on laptops it is four cards.
12. Labels name what the person is doing ("Counted drawer", "Record drop"), not what the system is doing. Money is always shown as `$1,234.56`.
13. Errors say what went wrong and what to do next, inline on the page, never a blank or crashed screen.

## Checks
- `npm run test:ui` loads every page as each role at 390×844 and 1280×800 and fails on horizontal overflow, missing nav, a hidden last button, or a tap target under 44px.
- Screenshots from that run land in `test/e2e/shots/` for a visual look before merging.
