---
name: WebSSH Studio
colors:
  primary: "#172033"     # light theme fg-primary; every value lives in design/tokens.json
  accent: "#3157C8"      # light theme accent-primary
  background: "#F4F7FB"  # light theme bg-canvas (default theme)
typography:
  heading: { fontFamily: "var(--font-font-sans)", fontSize: "var(--font-size2xl) / 22px" }
  body: { fontFamily: "var(--font-font-sans)", fontSize: "var(--font-size-md) / 13px" }
iconography:
  system: "custom inline SVG (packages/ui-kit/src/icons.tsx)"
  weight: "1.5px line"
  domain: "custom"
---

# Design System — WebSSH Studio

Reading this as: a developer tool's connect page for people who already know what SSH is, with
the language of a terminal settings sheet. It opens straight onto the form; there is no marketing hero.

Do: put the form first, state what each hop receives, and keep host and user values in mono.
Don't: hero art, feature tiles, social proof, or claims the transport cannot back up.

## Dials

```
DESIGN_VARIANCE: 3
MOTION_INTENSITY: 1
Product density profile: D4
Reasoning: a repeated-use utility screen in an existing design system; trust and speed beat novelty.
```

Concept generation was skipped on purpose. `design/tokens.json` and `packages/ui-kit` already
govern this product, so the redesign works inside that system rather than proposing a new one.

## Tokens

- Source: `design/tokens.json` merged over `packages/ui-kit/tokens.json`, then generated into
  `packages/ui-kit/src/generated/tokens.css` and `tokens.ts`. Never edit the generated files.
- `npm run lint:tokens` rejects hex colours, raw px on spacing, radius and font-size, and any
  `var(--x)` that no stylesheet declares and no code sets. px stays allowed on min-height and width
  (control heights, the Turnstile slot).
- Names to copy exactly: `--space-0..8`, `--radius-sm|md|panel|pill`, `--border-hairline|strong|control|focus-ring`,
  `--font-size-xs|sm|md|lg|xl`, and `--font-size2xl` (no hyphen before `2xl`; the hyphenated name is
  undefined and silently falls back to 13px), `--density-comfortable-control-height` (36px).

## Colors

Nine themes, applied by `applyThemeToDocument` (inline custom properties on `<html>`). Light is the default.

| Role | Token |
|---|---|
| Page | `--color-bg-canvas` |
| Card, inputs | `--color-bg-surface`, `--color-bg-elevated`; control borders `--border-control` |
| Text | `--color-fg-primary`, `--color-fg-secondary` (labels, lede), `--color-fg-muted` (hints, notes) |
| Action, focus | `--color-accent-primary`, `--color-accent-hover`, `--border-focus-ring` |
| Status | `--color-status-danger|warning|success` |

Contrast is enforced at the token source. `auditThemeContrast` (`packages/ui-kit/src/contrast.ts`)
checks every theme for text colours (fg, accent, status) at 4.5:1 on canvas, surface and elevated,
labels on accent and danger fills at 4.5:1, and `--color-border-control` at 3:1 (WCAG 1.4.11).
`ui-kit.test.ts` fails when a theme drops below, so status colours are safe as text anywhere.
Decorative hairlines (`--border-hairline`) stay subtle on purpose and are not form-control borders.

## Components (welcome / connect page)

`apps/web/src/ui/shell/WelcomeScreen.tsx` + `welcome-screen.css`.

- Layout: one column up to 959px (intro, form, route); from 960px two columns, with intro and route on
  the left and the form card on the right (max 960px). The headline sits on the card title's baseline.
- Card: hairline border, `--radius-panel`, surface fill, no shadow.
- Form: labels above fields, 36px controls (44px and 16px text under `pointer: coarse`). Selects use
  the ui-kit caret (`appearance: none`): WebKit ignores vertical padding on a native select. Host, user,
  port and key text are mono. Field errors appear inline under the field (`role=alert`,
  `aria-invalid`, `aria-describedby`). Other errors go in the status block (`connect-error-badge`).
- Actions: one primary button ("Connect to server"), flat fill, no gradient, shadow or lift. The
  secondary is "Saved hosts", or "Cancel" while a connection is in progress.
- Route panel: "How this connects" lists browser, relay or gateway, then server. The copy comes from
  `describeRoute(mode, authMethod)` and says what the hop receives: the gateway gets passwords and
  PEM keys, but the browser-generated key never leaves the tab.
- Guest check: Turnstile renders only in relay mode with a site key, in a 65px reserved slot.
- Badges (`ui-kit`): mono, pill, status colour for text and border.
- Dash runs: Chromium wraps between consecutive dashes, so the key placeholder joins them with U+2060
  and symbolic modes such as `(-r--------)` in messages render in a `webssh-welcome-nowrap` span.

The app-wide `.ui-btn--primary` keeps the gradient, shadow and hover lift added in `0859bdc`; this
page overrides it locally to a flat fill. The gradient is a `background-image`, so any override of a
primary button uses the `background` shorthand: the selected rail item is a 10% accent tint with no
shadow or lift, and its hover only adds a border, because a stronger tint misses 4.5:1 in Solarized.

Connection-state dots take their class from `statusDotClassFor` (`shell/status-dot.ts`). The bare dot
is green, so it is reserved for a live session; a dot never hardcodes `--connected`.

Browser key: until the vault creates a key in this session the form shows only "Generate browser key";
afterwards it shows the public key line (read-only, mono), a Copy button and the SHA256 fingerprint.
The copy says the private key cannot be exported and that the public key goes in `authorized_keys`;
it never claims passphrase protection. "Copied" appears only after the clipboard write resolves.

## Rules

- Type: `--font-font-sans` and `--font-font-mono` stacks. No webfont files ship today, so text renders
  in Inter or JetBrains Mono when installed, and otherwise the system UI font. Do not add a CDN font
  (invariant 3); self-host WOFF2 if a face is wanted.
- Headings use `text-wrap: balance`, body text uses `pretty`, and prose is capped at 44–52ch.
- Icons: inline 1.5px line SVG from `icons.tsx`. No emoji or icon tiles.
- Motion: none on this page beyond hover colour and the focus ring. No entrance or scroll motion.
- Focus: `outline: var(--border-focus-ring)` on every interactive element. Never `outline: none`
  without a replacement.
- Copy: plain verbs, no em dashes in new copy, and no claims the code does not back (invariant 5).
- Proof: `e2e/welcome.spec.ts` runs axe for WCAG 2.2 AA in every theme, with error states included,
  and checks layout at 1440, 1024, 768, 390 and 320 in every auth mode (no overflow; 44px targets and
  16px field text on touch widths). `WelcomeScreen.test.tsx` covers field errors, route copy and dash
  runs; `ui-kit.test.ts` covers theme contrast.

## Never

- Gradients, glass, aurora or blurred backgrounds behind the form.
- Border plus shadow on the same card.
- More than one primary action on a screen.
- Fixed heights or `overflow: hidden` that can clip the form at 320px.
- Invisible placeholders that reserve space for UI that is not rendered.
- Copy saying keys or passwords stay in the browser unless the transport and auth method make it true.
