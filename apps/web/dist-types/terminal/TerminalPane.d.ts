import type { JSX } from 'preact';
import type { ITheme } from '@xterm/xterm';
import { XtermPaneAdapter, type TerminalRendererMode } from './xterm-adapter';
/**
 * The minimum transport surface a pane needs. Both the relay client and the Go
 * gateway client implement it, so a pane never knows which one it is bound to.
 */
export interface PaneTransport {
    readonly isConnected: boolean;
    sendPtyText(channel: number, text: string): boolean;
    resizeChannel(channel: number, cols: number, rows: number): void;
}
export interface TerminalPaneProps {
    paneId: string;
    channelId: number | null;
    transport: PaneTransport | null;
    active: boolean;
    label: string;
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    cursorStyle: 'block' | 'underline' | 'bar';
    cursorBlink: boolean;
    scrollback: number;
    theme: ITheme;
    /** Registers the live adapter so App can route incoming PTY bytes to it. */
    onAdapter: (paneId: string, adapter: XtermPaneAdapter | null) => void;
    onRendererChange?: (paneId: string, mode: TerminalRendererMode) => void;
    onFocusChange?: (paneId: string) => void;
    testId?: string;
}
/**
 * One visible terminal, one channel. The pane owns its emulator lifecycle:
 * it mounts when the DOM node exists (not merely when the component renders),
 * feeds xterm input to its own PTY channel, resizes that same channel and
 * disposes exactly once. Nothing else in the app writes to this terminal.
 */
export declare function TerminalPane(props: TerminalPaneProps): JSX.Element;
//# sourceMappingURL=TerminalPane.d.ts.map