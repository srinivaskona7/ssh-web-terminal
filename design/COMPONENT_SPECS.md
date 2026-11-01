# WebSSH Studio — Design & Screen Specifications

This document captures the 13 canonical screens and component tokens from Section 2 of the specification.

## Visual Invariants
- **Grid & Geometry**: 8px spacing unit (`--space-1` = 4px, `--space-2` = 8px, `--space-3` = 12px, `--space-4` = 16px, `--space-5` = 24px), 12px panel border radius (`--radius-panel`), 1px hairline borders (`--border-hairline`), 3-level elevation (`--elevation-1..3`).
- **Motion**: Maximum transition duration 200ms (`--motion-max`), automatically disabled when `@media (prefers-reduced-motion: reduce)` matches.
- **Contrast & Focus**: WCAG AA minimum (4.5:1 text contrast), explicit `:focus-visible` 2px solid focus ring (`--border-focusRing`).
- **Clean Terminal Area**: Uniform 8px inset (`--space-terminalInset`), zero decorative borders or inner shadows inside the terminal viewport, cursor and selection colors strictly bound to active theme tokens.

## Screen Catalog
1. **Welcome / First Run**: 3-step onboarding card (Create key → Add host → Connect) with primary CTA "Generate SSH key".
2. **Key Vault**: Key list with SHA-256 fingerprint & algorithm badge (`Ed25519` / `ECDSA P-256`), copyable OpenSSH public key block, `authorized_keys` one-liner card, drag-and-drop private key import dialog, and Argon2id passphrase lock/unlock controls.
3. **Hosts**: Left folder/tag filter, searchable host grid (alias, `user@host:port`, last connected, status dot, favorite star), `~/.ssh/config` import dialog, ProxyJump chain drawer, and one-time key deployment (`ssh-copy-id`) flow.
4. **Host-Key Verification Modal**: Neutral TOFU state for unknown hosts with SHA-256 fingerprint, and blocking high-alert danger state (`KEY CHANGED`) when a pinned host key differs, requiring explicit override confirmation.
5. **Workspace**: Draggable/renamable tab bar with live status dots, horizontal/vertical resizable split panes, collapsible slim left rail, distraction-free terminal viewport, and toggleable 1-line status bar (latency, throughput, cipher, reconnect state).
6. **Reconnecting Banner & Pending Input Indicator**: Non-blocking top banner (`Reconnecting (attempt N)…`, `Offline`, `Session Resumed`) plus a subtle badge showing queued keystrokes (`pending input: X B`).
7. **Immersive Full-Screen Mode & Zen Mode**:
   - Full-Screen (`F11` / `Cmd/Ctrl+Shift+F`): 100% viewport terminal with zero persistent chrome, 3-second entry toast (`Press F11 or Esc to exit`), top-edge hover / `Alt` auto-hiding overlay bar (tab switcher, status dot, quick settings, exit button), Chromium `navigator.keyboard.lock(['Escape'])` when terminal is focused, and `100dvh` safe-area pseudo-fullscreen fallback where Fullscreen API is unavailable.
   - Zen Mode: Windowed single-pane distraction-free layout with status bar and side rail hidden.
8. **File Panel (Dual-Pane SFTP)**: Breadcrumb path bar, sortable columns (name, size, modified, permissions), search filter, drag-and-drop upload dropzone (`Drop to upload to <remotePath>`), transfer queue drawer (pause, resume, cancel, retry, throughput, ETA), and Storage Guard quota meter.
9. **Remote File Editor**: Tabbed code editor with line numbers, syntax highlighting, dirty indicator, and atomic "Save to host" over SFTP.
10. **Settings**: Appearance (theme gallery + live terminal preview + 16-color ANSI editor), Typography (font family, size, line height, letter spacing, ligatures), Layout presets, Surface (opacity, background image), Per-host overrides, Keybindings (with conflict detector), Security (vault passphrase, auto-lock timeout), Storage limits (sliders with hard caps), and Portable Preferences (JSON export/import).
11. **Command Palette (`Cmd/Ctrl+K`)**: Centered fuzzy-search modal with grouped actions and keyboard shortcut pills.
12. **Snippets & Session Recordings**: Variable-templated command snippets (`{{host}}`, `{{user}}`, custom placeholders) and local asciicast v2 session recorder with interactive timeline scrubber player.
13. **Mobile / Tablet Layout**: Responsive bottom navigation bar, collapsible drawer, and touch-friendly special-keys row (`Esc`, `Tab`, `Ctrl`, `Alt`, `↑`, `↓`, `←`, `→`, `|`, `/`, `~`).
