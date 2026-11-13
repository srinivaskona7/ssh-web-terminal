# UI & Design System

## Token Pipeline (Invariant 1)

```
design/tokens.json ──build-tokens.mjs──▶ packages/ui-kit/tokens.json ──▶ tokens.css + TS defs
npm run lint:tokens  =  fails on any hardcoded hex/px in components
```

- All components consume CSS variables (`--color-*`, `--space-*`, `--font-*`). No hardcoded values.
- `scripts/check-eol.mjs` enforces LF only.
- Design tokens source of truth: `design/tokens.json` (spacing, radius, studio Dracula palette `#000`/`#131313`/`#282A36`, prompt colors `#F1FA8C`/`#72C7F5`/`#70DFE3`/`#80F29A`, elevation, motion, density, typography).

## Themes

9 themes: Dark, Light, High-Contrast, Solarized, Dracula, Nord, Gruvbox, Tokyo Night, One Dark. Each has `bgCanvas`/`bgSurface`/`bgElevated`/`bgOverlay`, fg/border (`borderControl` for form controls)/accent (`accentText` for labels on accent)/status, terminal bg/fg/cursor/selection, and 16-color ANSI map. `contrast.ts` `auditThemeContrast` checks every text and status colour at 4.5:1 on all three backgrounds, labels on accent and danger fills plus terminal text at 4.5:1, and the control border at 3:1; `ui-kit.test.ts` fails on any theme below AA. Theme choice persists via `PreferencesStore`.

Vite: `host: true`, `allowedHosts: true`, `cors: true`. CSP `default-src 'self'`. Icons are inline 1.5px line SVG (`ui-kit/src/icons.tsx`). No webfont files ship: the sans/mono stacks use Inter / JetBrains Mono when installed, else system fonts (no CDN either way).

## Shell & Screens

`ui/App.tsx` is shell + rail. Extracted shell in `ui/shell/`:

- `AppHeader.tsx`, `AppRail.tsx` — top bar, collapsible rail (resizable, width persisted)
- `SettingsScreen.tsx` — appearance, connection, gateway/relay endpoint, tokens. Saved prefs preserved on endpoint change.
- `WelcomeScreen.tsx` + `welcome-screen.css` — connect page: one New connection form (field errors inline via `CONNECT_FIELD_MESSAGES`), "How this connects" route panel (`describeRoute`: what the relay/gateway receives per auth method), Turnstile guest check only in relay mode with a site key. Direction, dials and Never list in root `DESIGN.md`; axe in all nine themes in `e2e/welcome.spec.ts`.
- `WelcomeDashboard.tsx` + `welcome-data.ts`, `ProfileCard.tsx` — tested components, not mounted on Welcome (recent hosts live in Saved Hosts)
- `TurnstileWidget.tsx` — guest widget

Module screens: `ServerModules.tsx` — Overview, Software, Containers, Kubernetes, Automations, Deployments, Activity (compact rail via `ModuleContext`).

`CapabilityMatrixPanel.tsx` — generated from `capability-matrix.ts`. Honest states.

## Terminal Surface

- One xterm per pane (`TerminalPane.tsx`). WebGL → canvas → DOM fallback with `Renderer: webgl|canvas|dom` notice.
- Tabs + split panes (`workspace-state.ts`), broadcast input when `splitPanes > 1`.
- Find bar: Ctrl/Cmd+F (except text fields), Enter next, Shift+Enter prev, Esc refocus. `xterm-adapter.ts` leaves Ctrl+F/K to app.
- Zoom: `Cmd/Ctrl+Shift+F` / `F11` full-screen, `100dvh` iOS fallback, Zen mode (Esc exits), top-edge hover overlay.
- Keyboard: `?` cheatsheet (refuses inside terminal), palette `Cmd/Ctrl+K`.

Startup: ES5 watchdog in `index.html` dismisses `#startup-shell`, auto-repairs stale cache on `Unexpected token '<'`, even without SW.

## IDE (LightIde)

`ui/LightIde.tsx` + `ide-editing.ts`:

- Browse/create/rename/delete over SFTP. UTF-8 only; binary/non-UTF-8 refused.
- Autosave 1.2 s debounce, flush on unmount. Read-before-write conflict UI ("Overwrite" / "Reload").
- CRLF preserved (`detectEol`), buffers LF. Line-number gutter synced to scroll (hidden when wrapping or >5k lines).
- Find/replace, go-to-line, comment, duplicate/move line, indent, auto-indent, project search, quick open, git status/diff (read-only, quoted).
- Cmd runner (history in-memory only, never localStorage), pinned presets, run-in-root.
- Saved projects + recents via `ide-storage.ts` (`webssh.ide.v1`) — paths only, never contents.
- Limits: no LSP, debugger, extension host, terminals. Deliberate.

## Feature Matrix Rule

- UI claims generated from `ui/capability-matrix.ts`. `docs/FEATURES.md` is source of truth.
- Missing probe → "not reported". Disconnected → report disconnect. No green fake statuses.
- Editor save while disconnected → error, never fake success. Save refuses when remote changed since load.
