import { jsx as _jsx } from "preact/jsx-runtime";
import { useEffect, useRef, useState } from 'preact/hooks';
import { XtermPaneAdapter } from './xterm-adapter';
/**
 * One visible terminal, one channel. The pane owns its emulator lifecycle:
 * it mounts when the DOM node exists (not merely when the component renders),
 * feeds xterm input to its own PTY channel, resizes that same channel and
 * disposes exactly once. Nothing else in the app writes to this terminal.
 */
export function TerminalPane(props) {
    const [host, setHost] = useState(null);
    const adapterRef = useRef(null);
    const propsRef = useRef(props);
    propsRef.current = props;
    // Mount/unmount is keyed on the DOM node, so a pane that is rendered while
    // its container is not yet attached still mounts as soon as it is. A
    // mount-only effect with an empty dependency list silently skipped that.
    useEffect(() => {
        if (!host)
            return;
        const isJsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
        if (isJsdom)
            return;
        const current = propsRef.current;
        let disposed = false;
        const adapter = new XtermPaneAdapter({
            fontFamily: current.fontFamily,
            fontSize: current.fontSize,
            lineHeight: current.lineHeight,
            cursorStyle: current.cursorStyle,
            cursorBlink: current.cursorBlink,
            scrollback: current.scrollback,
            theme: current.theme,
            onData: (data) => {
                const { channelId, transport } = propsRef.current;
                if (channelId === null || !transport || !transport.isConnected)
                    return;
                transport.sendPtyText(channelId, data);
            },
            onResize: (cols, rows) => {
                const { channelId, transport } = propsRef.current;
                if (disposed || cols <= 0 || rows <= 0)
                    return;
                if (channelId === null || !transport || !transport.isConnected)
                    return;
                transport.resizeChannel(channelId, cols, rows);
            },
            onRendererChange: (mode) => {
                if (!disposed)
                    propsRef.current.onRendererChange?.(current.paneId, mode);
            }
        });
        adapterRef.current = adapter;
        propsRef.current.onAdapter(current.paneId, adapter);
        const fit = () => {
            if (disposed || host.clientWidth === 0 || host.clientHeight === 0)
                return;
            try {
                adapter.fitAddon.fit();
            }
            catch {
                // Detached or zero-sized container; a later resize will fit again.
            }
        };
        void adapter
            .mount(host, 'auto')
            .then((mode) => {
            if (disposed)
                return;
            propsRef.current.onRendererChange?.(current.paneId, mode);
            // xterm's helper textarea is the keyboard path; it must stay reachable
            // by assistive technology and focusable.
            const helper = host.querySelector('.xterm-helper-textarea');
            if (helper) {
                helper.setAttribute('aria-label', `${current.label} — keyboard input`);
                helper.removeAttribute('tabindex');
            }
            fit();
            return document.fonts?.ready.then(() => fit());
        })
            .catch(() => {
            // Keep the pane visible even when a renderer cannot initialise.
        });
        return () => {
            disposed = true;
            try {
                propsRef.current.onAdapter(current.paneId, null);
            }
            catch {
                // Ignore a registry that is already gone.
            }
            try {
                adapter.dispose();
            }
            catch {
                // Ignore dispose errors from a half-initialised emulator.
            }
            adapterRef.current = null;
        };
    }, [host]);
    // Refit when the pane becomes visible again (tab switch, split, zen,
    // fullscreen) or when the viewport changes for reasons ResizeObserver does
    // not report, such as a mobile keyboard or an orientation change.
    useEffect(() => {
        if (!props.active)
            return;
        const adapter = adapterRef.current;
        if (!adapter)
            return;
        const refit = () => {
            try {
                adapter.fitAddon.fit();
            }
            catch {
                // Ignore detached panes.
            }
        };
        const frame = requestAnimationFrame(refit);
        const onViewportResize = () => refit();
        window.addEventListener('resize', onViewportResize);
        const vv = window.visualViewport;
        vv?.addEventListener('resize', onViewportResize);
        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener('resize', onViewportResize);
            vv?.removeEventListener('resize', onViewportResize);
        };
    }, [props.active]);
    // Font, cursor and theme changes apply in place: recreating the emulator
    // would drop scrollback.
    useEffect(() => {
        const adapter = adapterRef.current;
        if (!adapter)
            return;
        try {
            adapter.terminal.options.fontFamily = props.fontFamily;
            adapter.terminal.options.fontSize = props.fontSize;
            adapter.terminal.options.cursorStyle = props.cursorStyle;
            adapter.terminal.options.cursorBlink = props.cursorBlink;
            adapter.terminal.options.theme = props.theme;
            adapter.fitAddon.fit();
        }
        catch {
            // Ignore option updates against a disposed emulator.
        }
    }, [
        props.fontFamily,
        props.fontSize,
        props.cursorStyle,
        props.cursorBlink,
        props.theme.background,
        props.theme.foreground,
        props.theme.cursor
    ]);
    return (_jsx("div", { ref: (el) => setHost(el), className: "webssh-xterm-pane", "data-testid": props.testId ?? 'xterm-pane', "data-pane-id": props.paneId, role: "group", "aria-label": props.label, onMouseDown: () => props.onFocusChange?.(props.paneId), style: { position: 'absolute', inset: '0' } }));
}
//# sourceMappingURL=TerminalPane.js.map