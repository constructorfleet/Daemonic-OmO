# Web app design

## 0. Research Log

- Existing product reference: the `omo-agent-viewer` palette in `viewer-model.ts`; reused because Todo 6 explicitly carries the viewer's dark palette into the web shell.
- Spatial reference: StyleGallery `fixed-sidenav-shell` pattern, https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/fixed-sidenav-shell.md.

## 1. Color

The application keeps the established viewer palette in dark mode. `tokens.css` is the source of truth for both system themes; light mode is selected by `prefers-color-scheme: light`.

| Role | Token | Dark | Light |
| --- | --- | --- | --- |
| Page and panel | `--color-panel` | `#0b1020` | `#f6f8fb` |
| Raised surface | `--color-surface` | `#141d33` | `#ffffff` |
| Selection | `--color-selection` | `#1b2a4a` | `#e5edf6` |
| Primary accent | `--color-accent` | `#8be9fd` | `#006781` |
| Assistant | `--color-assistant` | `#a5d6ff` | `#315f7c` |
| Muted | `--color-muted` | `#7c8aa5` | `#536274` |
| Tool | `--color-tool` | `#e0af68` | `#7a4f05` |
| Success | `--color-success` | `#9ece6a` | `#28623b` |
| Error | `--color-error` | `#f7768e` | `#a3293b` |
| Image | `--color-image` | `#cba6f7` | `#694a91` |
| Navigation | `--color-rail` | `#7aa2f7` | `#385e96` |
| Body text | `--color-text` | `#cbd5e1` | `#293342` |
| Headings | `--color-heading` | `#e7edf7` | `#121a26` |
| Divider | `--color-hairline` | `#34405e` | `#c4ceda` |
| Control edge | `--color-control-edge` | `#596783` | `#7a879a` |
| Focus | `--color-focus` | `#8be9fd` | `#005fcc` |
| Overlay scrim | `--color-scrim` | `#000000` | `#121a26` |

## 2. Typography

Use the platform sans-serif stack. The page title, section title, body, and supporting text use the type scale declared in `tokens.css`.

## 3. Spacing and layout

Spacing follows a 4 px scale. The desktop shell uses a fixed side navigation and a bounded main scroll region. At compact widths, navigation moves above the content as a two-column grid and the document is the only vertical scroll owner.

Layout: Application shell - stable navigation beside a changing page -> fixed-sidenav-shell (https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/fixed-sidenav-shell.md); scroll owner: `main.workspace__content` on wide screens and `document` on compact screens; anti-patterns: no nested same-direction scroll regions, no visual ordering that differs from DOM order.

Layout: Projects list - registered and discovered project rows in one reading column -> fixed-sidenav-shell; scroll owner: `main.workspace__content` on wide screens and `document` on compact screens; anti-patterns: no nested same-direction scroll regions, task rows stay inside their project row, no card nesting.

Layout: Project settings - one stacked form column within the project page -> fixed-sidenav-shell; scroll owner: `main.workspace__content` on wide screens and `document` on compact screens; anti-patterns: no nested form scroller, confirmation remains modal.

Layout: Sign-in - left-aligned purpose and one provider action -> fixed-sidenav-shell; scroll owner: `main.workspace__content` on wide screens and `document` on compact screens; anti-patterns: no centered splash, no provider choices the daemon does not support.

Layout: Project registration - stacked directory and optional name fields in the projects page -> fixed-sidenav-shell; scroll owner: `main.workspace__content` on wide screens and `document` on compact screens; anti-patterns: no nested form scroller, fields stay in source order.

Layout: Full-access confirmation - centered dialog over the project settings form -> fixed-sidenav-shell; scroll owner: dialog content only when necessary; anti-patterns: one dialog at a time, visible Cancel action, no page scroll while open.

Layout: Account menu - anchored action on wide screens and a bottom sheet on compact screens -> fixed-sidenav-shell; scroll owner: `main.workspace__content` on wide screens and `document` on compact screens; anti-patterns: no compact-width popover, no competing overlay.

## 4. Components

`AppShell` owns primary navigation, the account menu, the compatibility status region, and the active route heading. `ProjectActivity` owns task counts, task rows, and the running-runs count for one project. `EmptyState` owns the title, current data state, and next-step guidance for a route. Each component uses the shared semantic tokens and native HTML controls.

## 5. Screen brief: application shell

- Primary action: choose a primary navigation destination.
- Information priorities: current page title; whether route data is available; what event will populate the view.
- Left out on purpose: sample projects, sessions, users, metrics, fabricated connection state, and decorative badges.
- Required content: Projects, Sessions, Graph, Schedules, Loops, Runs, Audit, Admin navigation; account menu; compatibility status region; a meaningful empty state on every route; an unknown-route message with a path back to Projects.
- The account menu offers Sign out; it does not display account details. The compatibility region states that daemon status appears after a connection is configured.

## 5.1 Screen brief: projects list

- Primary action: Register project.
- Information priorities: registered project names and task status counts; running run counts; discovered projects and their latest session.
- Left out on purpose: per-project metric tiles, duplicate project summaries, and fabricated task activity.
- Required content: registered and discovered projects, project name and directory, active or archived state, running/completed/stopped task counts, task rows with task name and status, running-runs count, Register project action, project settings action, compatibility status.
- Empty, loading, and error states remain next to the project list they describe. A task document updates the existing row through the single event stream.

## 5.2 Screen brief: project settings

- Primary action: Save settings.
- Information priorities: project directory; run limit and defaults; worktree and full-access choices.
- Left out on purpose: permission presets and settings that the canonical Project model does not support.
- Required content: maximum parallel runs, default model, default reasoning, worktree for ad-hoc runs, full-access loop-check opt-in, Save settings, Back to projects, save errors and success state.

## 5.3 Screen brief: sign-in

- Primary action: Continue with your identity provider.
- Information priorities: sign-in purpose; configured identity-provider action.
- Left out on purpose: provider choices the daemon does not support, account metrics, and unauthenticated project data.
- Required content: page title “Sign in”, identity-provider explanation, Continue with your identity provider link.

## 5.4 Screen brief: account menu

- Primary action: Sign out.
- Information priorities: account menu state; sign-out action; sign-out error if the request fails.
- Left out on purpose: placeholder account details presented as authenticated identity.
- Required content: keyboard-operable Account control, expanded state, Sign out action, in-menu error feedback.

## 5.5 Screen brief: project registration

- Primary action: Register project.
- Information priorities: project directory; optional project name.
- Left out on purpose: project fields not accepted by the API.
- Required content: visible Project directory and Project name labels, directory input, optional name input, Register project action, Cancel registration action, and request error feedback.

## 5.6 Screen brief: full-access confirmation

- Primary action: Confirm full access.
- Information priorities: the loop-check command capability; its permission boundary.
- Left out on purpose: an Enter-default confirmation or a second permission setting.
- Required content: confirmation title and explanation, Confirm full access, Cancel, Escape dismissal, and focus return to the checkbox.

## 6. Interaction and accessibility

Navigation uses links with an active-page marker. The account menu is a keyboard-operable button with an exposed expanded state and a Sign out menu item. Focus rings use the focus token, carets use the accent token, and placeholders use the muted token. Compact navigation preserves source and focus order. System light and dark appearances use the same semantic roles and layout.

## 7. Motion and surfaces

No animation, blur, or decorative elevation is used in this operational shell. Surfaces use the existing viewer palette and neutral separators.

## 8. Accepted debt

None.
