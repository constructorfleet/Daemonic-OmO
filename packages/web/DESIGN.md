# Web app design

## 0. Research Log

- Existing product reference: the `omo-agent-viewer` palette in `viewer-model.ts`; reused because Todo 6 explicitly carries the viewer's dark palette into the web shell.
- Spatial reference: StyleGallery `fixed-sidenav-shell` pattern, https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/fixed-sidenav-shell.md.

## 1. Color

The application uses the established viewer palette. `tokens.css` is the source of truth for these semantic roles.

| Role | Token | Value |
| --- | --- | --- |
| Page and panel | `--color-panel` | `#0b1020` |
| Raised surface | `--color-surface` | `#141d33` |
| Selection | `--color-selection` | `#1b2a4a` |
| Primary accent | `--color-accent` | `#8be9fd` |
| Assistant | `--color-assistant` | `#a5d6ff` |
| Muted | `--color-muted` | `#7c8aa5` |
| Tool | `--color-tool` | `#e0af68` |
| Success | `--color-success` | `#9ece6a` |
| Error | `--color-error` | `#f7768e` |
| Image | `--color-image` | `#cba6f7` |
| Navigation | `--color-rail` | `#7aa2f7` |

## 2. Typography

Use the platform sans-serif stack. The page title, section title, body, and supporting text use the type scale declared in `tokens.css`.

## 3. Spacing and layout

Spacing follows a 4 px scale. The desktop shell uses a fixed side navigation and a bounded main scroll region. At compact widths, navigation moves above the content as a two-column grid and the document is the only vertical scroll owner.

Layout: Application shell - stable navigation beside a changing page -> fixed-sidenav-shell (https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/fixed-sidenav-shell.md); scroll owner: `main.workspace__content` on wide screens and `document` on compact screens; anti-patterns: no nested same-direction scroll regions, no visual ordering that differs from DOM order.

## 4. Components

`AppShell` owns primary navigation, the account menu, the compatibility status region, and the active route heading. `EmptyState` owns the title, current data state, and next-step guidance for a route. Each component uses the shared semantic tokens and native HTML controls.

## 5. Screen brief: application shell

- Primary action: choose a primary navigation destination.
- Information priorities: current page title; whether route data is available; what event will populate the view.
- Left out on purpose: sample projects, sessions, users, metrics, fabricated connection state, and decorative badges.
- Required content: Projects, Sessions, Graph, Schedules, Loops, Runs, Audit, Admin navigation; account menu; compatibility status region; a meaningful empty state on every route; an unknown-route message with a path back to Projects.
- The account menu states that account details appear after authentication is configured. The compatibility region states that daemon status appears after a connection is configured.

## 6. Interaction and accessibility

Navigation uses links with an active-page marker. The account menu is a keyboard-operable button with an exposed expanded state. Focus rings use the accent token. Compact navigation preserves source and focus order.

## 7. Motion and surfaces

No animation, blur, or decorative elevation is used in this operational shell. Surfaces use the existing viewer palette and neutral separators.

## 8. Accepted debt

- The rendered-page reflow check's synthetic 300-character token appears alone at the end of the Projects next-step paragraph at its 320 px stress width. This is generated test content; the actual mobile copy wraps normally.
