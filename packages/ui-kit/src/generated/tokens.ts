// Auto-generated from packages/ui-kit/tokens.json — DO NOT EDIT MANUALLY

export interface AnsiPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemeTokens {
  bgCanvas: string;
  bgSurface: string;
  bgElevated: string;
  bgOverlay: string;
  fgPrimary: string;
  fgSecondary: string;
  fgMuted: string;
  borderSubtle: string;
  borderStrong: string;
  accentPrimary: string;
  accentHover: string;
  statusSuccess: string;
  statusWarning: string;
  statusDanger: string;
  terminalBg: string;
  terminalFg: string;
  terminalCursor: string;
  terminalSelection: string;
  ansi: AnsiPalette;
}

export type ThemeId = 'dark' | 'light' | 'high-contrast' | 'solarized' | 'dracula' | 'nord' | 'gruvbox' | 'tokyo-night' | 'one-dark';

export const THEME_IDS: readonly ThemeId[] = ["dark","light","high-contrast","solarized","dracula","nord","gruvbox","tokyo-night","one-dark"] as const;

export const TOKENS = {
  "$schema": "https://webssh.studio/schemas/tokens-v1.json",
  "version": "1.0.0",
  "spacing": {
    "0": "0px",
    "1": "4px",
    "2": "8px",
    "3": "12px",
    "4": "16px",
    "5": "24px",
    "6": "32px",
    "7": "40px",
    "8": "48px",
    "terminalInset": "8px",
    "stopIcon": "11px",
    "separatorHeight": "18px"
  },
  "radius": {
    "none": "0px",
    "stopSquare": "3px",
    "sm": "6px",
    "md": "8px",
    "panel": "12px",
    "xl": "16px",
    "pill": "9999px"
  },
  "studio": {
    "outerBg": "#000000",
    "containerBg": "#131313",
    "containerBorder": "#262629",
    "terminalBg": "#282A36",
    "terminalFg": "#F0F0EC",
    "promptUser": "#F1FA8C",
    "promptHost": "#72C7F5",
    "promptDir": "#70DFE3",
    "promptArrow": "#80F29A",
    "cursorBg": "#AAAAAA",
    "toolbarMuted": "#88888D",
    "stopSquare": "#DC514E",
    "logoLime": "#A6E22E",
    "logoYellow": "#F1FA8C",
    "logoOrange": "#FFB86C",
    "logoCoral": "#FF6E67",
    "logoPink": "#FF79C6"
  },
  "border": {
    "hairline": "1px solid var(--color-border-subtle)",
    "strong": "1px solid var(--color-border-strong)",
    "danger": "1px solid var(--color-status-danger)",
    "focusRing": "2px solid var(--color-accent-primary)"
  },
  "elevation": {
    "0": "none",
    "1": "0 2px 8px rgba(0, 0, 0, 0.24)",
    "2": "0 8px 24px rgba(0, 0, 0, 0.36)",
    "3": "0 16px 48px rgba(0, 0, 0, 0.52)"
  },
  "motion": {
    "fast": "120ms cubic-bezier(0.16, 1, 0.3, 1)",
    "normal": "180ms cubic-bezier(0.16, 1, 0.3, 1)",
    "max": "200ms cubic-bezier(0.16, 1, 0.3, 1)"
  },
  "density": {
    "comfortable": {
      "controlHeight": "36px",
      "controlPadding": "var(--space-2) var(--space-3)",
      "fontSize": "var(--font-size-md)",
      "gap": "var(--space-2)"
    },
    "compact": {
      "controlHeight": "28px",
      "controlPadding": "var(--space-1) var(--space-2)",
      "fontSize": "var(--font-size-sm)",
      "gap": "var(--space-1)"
    }
  },
  "surface": {
    "app": "var(--color-bg-canvas)",
    "nav": "var(--color-bg-surface)",
    "workspace": "var(--color-bg-elevated)",
    "workspaceBorder": "var(--color-border-subtle)"
  },
  "typography": {
    "fontSans": "'WebSSH Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    "fontMono": "'WebSSH Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    "sizeXs": "11px",
    "sizeSm": "12px",
    "sizeMd": "13px",
    "sizeLg": "15px",
    "sizeXl": "18px",
    "size2xl": "22px",
    "lineHeightUi": "1.45",
    "lineHeightTerminal": "1.35",
    "lineHeightEditor": "1.6",
    "letterSpacingNormal": "0em",
    "letterSpacingTight": "-0.01em"
  },
  "themes": {
    "dark": {
      "bgCanvas": "#0b0d12",
      "bgSurface": "#11151d",
      "bgElevated": "#171c26",
      "bgOverlay": "rgba(17, 21, 29, 0.92)",
      "fgPrimary": "#e6edf3",
      "fgSecondary": "#9da7b3",
      "fgMuted": "#9aa4b2",
      "borderSubtle": "#232a38",
      "borderStrong": "#343e52",
      "accentPrimary": "#4f8cff",
      "accentHover": "#6ea1ff",
      "statusSuccess": "#2ea043",
      "statusWarning": "#d29922",
      "statusDanger": "#f85149",
      "terminalBg": "#0b0d12",
      "terminalFg": "#e6edf3",
      "terminalCursor": "#4f8cff",
      "terminalSelection": "rgba(79, 140, 255, 0.28)",
      "ansi": {
        "black": "#0b0d12",
        "red": "#ff7b72",
        "green": "#3fb950",
        "yellow": "#d29922",
        "blue": "#58a6ff",
        "magenta": "#bc8cff",
        "cyan": "#39c5cf",
        "white": "#b1bac4",
        "brightBlack": "#6e7681",
        "brightRed": "#ffa198",
        "brightGreen": "#56d364",
        "brightYellow": "#e3b341",
        "brightBlue": "#79c0ff",
        "brightMagenta": "#d2a8ff",
        "brightCyan": "#56d4dd",
        "brightWhite": "#ffffff"
      }
    },
    "light": {
      "bgCanvas": "#F4F7FB",
      "bgSurface": "#FFFFFF",
      "bgElevated": "#F0F3F6",
      "bgOverlay": "rgba(255, 255, 255, 0.94)",
      "fgPrimary": "#172033",
      "fgSecondary": "#57606A",
      "fgMuted": "#6E7781",
      "borderSubtle": "#DCE3EE",
      "borderStrong": "#8C959F",
      "accentPrimary": "#3157C8",
      "accentHover": "#2850AE",
      "statusSuccess": "#1a7f37",
      "statusWarning": "#9a6700",
      "statusDanger": "#cf222e",
      "terminalBg": "#ffffff",
      "terminalFg": "#1f2328",
      "terminalCursor": "#0969da",
      "terminalSelection": "rgba(9, 105, 218, 0.22)",
      "ansi": {
        "black": "#24292f",
        "red": "#cf222e",
        "green": "#116329",
        "yellow": "#4d2d00",
        "blue": "#0969da",
        "magenta": "#8250df",
        "cyan": "#1b7c83",
        "white": "#6e7781",
        "brightBlack": "#57606a",
        "brightRed": "#a40e26",
        "brightGreen": "#1a7f37",
        "brightYellow": "#633c01",
        "brightBlue": "#218bff",
        "brightMagenta": "#a475f9",
        "brightCyan": "#3192aa",
        "brightWhite": "#8c959f"
      }
    },
    "high-contrast": {
      "bgCanvas": "#000000",
      "bgSurface": "#0a0c10",
      "bgElevated": "#141820",
      "bgOverlay": "rgba(0, 0, 0, 0.96)",
      "fgPrimary": "#ffffff",
      "fgSecondary": "#f0f6fc",
      "fgMuted": "#c9d1d9",
      "borderSubtle": "#7a828e",
      "borderStrong": "#ffffff",
      "accentPrimary": "#71b7ff",
      "accentHover": "#91cbff",
      "statusSuccess": "#26cd4d",
      "statusWarning": "#f0b72f",
      "statusDanger": "#ff6a69",
      "terminalBg": "#000000",
      "terminalFg": "#ffffff",
      "terminalCursor": "#71b7ff",
      "terminalSelection": "rgba(113, 183, 255, 0.45)",
      "ansi": {
        "black": "#000000",
        "red": "#ff6a69",
        "green": "#26cd4d",
        "yellow": "#f0b72f",
        "blue": "#71b7ff",
        "magenta": "#cb9eff",
        "cyan": "#39c5cf",
        "white": "#ffffff",
        "brightBlack": "#9ea7b3",
        "brightRed": "#ff9492",
        "brightGreen": "#4ae168",
        "brightYellow": "#f7c843",
        "brightBlue": "#91cbff",
        "brightMagenta": "#dbb7ff",
        "brightCyan": "#56d4dd",
        "brightWhite": "#ffffff"
      }
    },
    "solarized": {
      "bgCanvas": "#002b36",
      "bgSurface": "#073642",
      "bgElevated": "#0d4352",
      "bgOverlay": "rgba(7, 54, 66, 0.94)",
      "fgPrimary": "#fdf6e3",
      "fgSecondary": "#eee8d5",
      "fgMuted": "#93a1a1",
      "borderSubtle": "#1b5162",
      "borderStrong": "#586e75",
      "accentPrimary": "#268bd2",
      "accentHover": "#4ca3e0",
      "statusSuccess": "#859900",
      "statusWarning": "#b58900",
      "statusDanger": "#dc322f",
      "terminalBg": "#002b36",
      "terminalFg": "#fdf6e3",
      "terminalCursor": "#268bd2",
      "terminalSelection": "rgba(38, 139, 210, 0.30)",
      "ansi": {
        "black": "#073642",
        "red": "#dc322f",
        "green": "#859900",
        "yellow": "#b58900",
        "blue": "#268bd2",
        "magenta": "#d33682",
        "cyan": "#2aa198",
        "white": "#eee8d5",
        "brightBlack": "#586e75",
        "brightRed": "#cb4b16",
        "brightGreen": "#859900",
        "brightYellow": "#b58900",
        "brightBlue": "#839496",
        "brightMagenta": "#6c71c4",
        "brightCyan": "#93a1a1",
        "brightWhite": "#fdf6e3"
      }
    },
    "dracula": {
      "bgCanvas": "#1e1f29",
      "bgSurface": "#282a36",
      "bgElevated": "#343746",
      "bgOverlay": "rgba(40, 42, 54, 0.94)",
      "fgPrimary": "#f8f8f2",
      "fgSecondary": "#d6d6d0",
      "fgMuted": "#a4b0d0",
      "borderSubtle": "#44475a",
      "borderStrong": "#6272a4",
      "accentPrimary": "#bd93f9",
      "accentHover": "#caa8fc",
      "statusSuccess": "#50fa7b",
      "statusWarning": "#f1fa8c",
      "statusDanger": "#ff5555",
      "terminalBg": "#282a36",
      "terminalFg": "#f8f8f2",
      "terminalCursor": "#ff79c6",
      "terminalSelection": "rgba(189, 147, 249, 0.28)",
      "ansi": {
        "black": "#21222c",
        "red": "#ff5555",
        "green": "#50fa7b",
        "yellow": "#f1fa8c",
        "blue": "#bd93f9",
        "magenta": "#ff79c6",
        "cyan": "#8be9fd",
        "white": "#f8f8f2",
        "brightBlack": "#6272a4",
        "brightRed": "#ff6e6e",
        "brightGreen": "#69ff94",
        "brightYellow": "#ffffa5",
        "brightBlue": "#d6acff",
        "brightMagenta": "#ff92df",
        "brightCyan": "#a4ffff",
        "brightWhite": "#ffffff"
      }
    },
    "nord": {
      "bgCanvas": "#242933",
      "bgSurface": "#2e3440",
      "bgElevated": "#3b4252",
      "bgOverlay": "rgba(46, 52, 64, 0.94)",
      "fgPrimary": "#eceff4",
      "fgSecondary": "#e5e9f0",
      "fgMuted": "#b0bac9",
      "borderSubtle": "#434c5e",
      "borderStrong": "#4c566a",
      "accentPrimary": "#88c0d0",
      "accentHover": "#8fbcbb",
      "statusSuccess": "#a3be8c",
      "statusWarning": "#ebcb8b",
      "statusDanger": "#bf616a",
      "terminalBg": "#2e3440",
      "terminalFg": "#eceff4",
      "terminalCursor": "#88c0d0",
      "terminalSelection": "rgba(136, 192, 208, 0.28)",
      "ansi": {
        "black": "#3b4252",
        "red": "#bf616a",
        "green": "#a3be8c",
        "yellow": "#ebcb8b",
        "blue": "#81a1c1",
        "magenta": "#b48ead",
        "cyan": "#88c0d0",
        "white": "#e5e9f0",
        "brightBlack": "#4c566a",
        "brightRed": "#bf616a",
        "brightGreen": "#a3be8c",
        "brightYellow": "#ebcb8b",
        "brightBlue": "#81a1c1",
        "brightMagenta": "#b48ead",
        "brightCyan": "#8fbcbb",
        "brightWhite": "#eceff4"
      }
    },
    "gruvbox": {
      "bgCanvas": "#1d2021",
      "bgSurface": "#282828",
      "bgElevated": "#3c3836",
      "bgOverlay": "rgba(40, 40, 40, 0.94)",
      "fgPrimary": "#fbf1c7",
      "fgSecondary": "#ebdbb2",
      "fgMuted": "#bdae93",
      "borderSubtle": "#504945",
      "borderStrong": "#665c54",
      "accentPrimary": "#83a598",
      "accentHover": "#8ec07c",
      "statusSuccess": "#b8bb26",
      "statusWarning": "#fabd2f",
      "statusDanger": "#fb4934",
      "terminalBg": "#1d2021",
      "terminalFg": "#ebdbb2",
      "terminalCursor": "#fe8019",
      "terminalSelection": "rgba(131, 165, 152, 0.28)",
      "ansi": {
        "black": "#282828",
        "red": "#cc241d",
        "green": "#98971a",
        "yellow": "#d79921",
        "blue": "#458588",
        "magenta": "#b16286",
        "cyan": "#689d6a",
        "white": "#a89984",
        "brightBlack": "#928374",
        "brightRed": "#fb4934",
        "brightGreen": "#b8bb26",
        "brightYellow": "#fabd2f",
        "brightBlue": "#83a598",
        "brightMagenta": "#d3869b",
        "brightCyan": "#8ec07c",
        "brightWhite": "#ebdbb2"
      }
    },
    "tokyo-night": {
      "bgCanvas": "#16161e",
      "bgSurface": "#1a1b26",
      "bgElevated": "#24283b",
      "bgOverlay": "rgba(26, 27, 38, 0.94)",
      "fgPrimary": "#c0caf5",
      "fgSecondary": "#a9b1d6",
      "fgMuted": "#9aa5ce",
      "borderSubtle": "#292e42",
      "borderStrong": "#414868",
      "accentPrimary": "#7aa2f7",
      "accentHover": "#89ddff",
      "statusSuccess": "#9ece6a",
      "statusWarning": "#e0af68",
      "statusDanger": "#f7768e",
      "terminalBg": "#1a1b26",
      "terminalFg": "#c0caf5",
      "terminalCursor": "#7aa2f7",
      "terminalSelection": "rgba(122, 162, 247, 0.28)",
      "ansi": {
        "black": "#15161e",
        "red": "#f7768e",
        "green": "#9ece6a",
        "yellow": "#e0af68",
        "blue": "#7aa2f7",
        "magenta": "#bb9af7",
        "cyan": "#7dcfff",
        "white": "#a9b1d6",
        "brightBlack": "#414868",
        "brightRed": "#f7768e",
        "brightGreen": "#9ece6a",
        "brightYellow": "#e0af68",
        "brightBlue": "#7aa2f7",
        "brightMagenta": "#bb9af7",
        "brightCyan": "#7dcfff",
        "brightWhite": "#c0caf5"
      }
    },
    "one-dark": {
      "bgCanvas": "#1e222a",
      "bgSurface": "#282c34",
      "bgElevated": "#323842",
      "bgOverlay": "rgba(40, 44, 52, 0.94)",
      "fgPrimary": "#dcdfe4",
      "fgSecondary": "#abb2bf",
      "fgMuted": "#9da5b4",
      "borderSubtle": "#3b4048",
      "borderStrong": "#4b5263",
      "accentPrimary": "#61afef",
      "accentHover": "#7cc0f5",
      "statusSuccess": "#98c379",
      "statusWarning": "#e5c07b",
      "statusDanger": "#e06c75",
      "terminalBg": "#282c34",
      "terminalFg": "#dcdfe4",
      "terminalCursor": "#61afef",
      "terminalSelection": "rgba(97, 175, 239, 0.28)",
      "ansi": {
        "black": "#282c34",
        "red": "#e06c75",
        "green": "#98c379",
        "yellow": "#e5c07b",
        "blue": "#61afef",
        "magenta": "#c678dd",
        "cyan": "#56b6c2",
        "white": "#abb2bf",
        "brightBlack": "#5c6370",
        "brightRed": "#e06c75",
        "brightGreen": "#98c379",
        "brightYellow": "#e5c07b",
        "brightBlue": "#61afef",
        "brightMagenta": "#c678dd",
        "brightCyan": "#56b6c2",
        "brightWhite": "#ffffff"
      }
    }
  }
} as const;

export const THEMES: Record<ThemeId, ThemeTokens> = TOKENS.themes;
