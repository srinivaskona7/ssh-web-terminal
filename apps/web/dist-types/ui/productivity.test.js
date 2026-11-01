import { describe, expect, it } from 'vitest';
import { AsciicastRecorder, BroadcastManager, CommandPaletteRegistry, KeybindingRegistry, SnippetLibrary, detectCommandCompletion, extractSnippetVariables, interpolateSnippet, parseAsciicastV2, scrubAsciicastOutput, translateSpecialKey } from './productivity';
describe('M7 Productivity & Security Extras (Palette, Snippets, Broadcast, Asciicast, Keybindings, OSC 133)', () => {
    it('ranks fuzzy command palette matches and executes commands', () => {
        let executed = false;
        const palette = new CommandPaletteRegistry();
        palette.register({
            id: 'view.fullscreen',
            title: 'Toggle Immersive Full-Screen Mode',
            category: 'View',
            shortcut: 'F11',
            run: () => {
                executed = true;
            }
        });
        palette.register({
            id: 'conn.new',
            title: 'New SSH Connection',
            category: 'Connection',
            run: () => { }
        });
        const matches = palette.search('immsv full');
        expect(matches).toHaveLength(1);
        expect(matches[0]?.id).toBe('view.fullscreen');
        palette.execute('view.fullscreen');
        expect(executed).toBe(true);
    });
    it('extracts and interpolates snippet variables', () => {
        const tpl = 'systemctl status {{service}} --lines={{lines}}';
        expect(extractSnippetVariables(tpl)).toEqual(['service', 'lines']);
        expect(interpolateSnippet(tpl, { service: 'nginx', lines: '50' })).toBe('systemctl status nginx --lines=50');
        const lib = new SnippetLibrary([
            { id: 's1', name: 'Nginx Status', command: tpl, tags: ['systemd', 'web'] }
        ]);
        expect(lib.list('systemd')).toHaveLength(1);
    });
    it('broadcasts input across multiple selected panes when enabled', () => {
        const broadcast = new BroadcastManager();
        broadcast.toggleTargetPane('pane-1');
        broadcast.toggleTargetPane('pane-2');
        broadcast.setEnabled(true);
        const received = {};
        const count = broadcast.dispatchInput('uptime', (paneId, data) => {
            received[paneId] = data;
        });
        expect(count).toBe(2);
        expect(received['pane-1']).toBe('uptime');
        expect(received['pane-2']).toBe('uptime');
    });
    it('records asciicast v2 with size cap and scrubs timeline playback', () => {
        const recorder = new AsciicastRecorder(80, 24, 'Prod Audit', 1024, 1000);
        expect(recorder.recordOutput('$ ', 1200)).toBe(true);
        expect(recorder.recordOutput('ls -la', 2500)).toBe(true);
        const cast = recorder.exportCast();
        const parsed = parseAsciicastV2(cast);
        expect(parsed.header.version).toBe(2);
        expect(parsed.events).toHaveLength(2);
        expect(scrubAsciicastOutput(parsed.events, 0.5)).toBe('$ ');
        expect(scrubAsciicastOutput(parsed.events, 10)).toBe('$ ls -la');
    });
    it('detects keybinding conflicts across normalized modifier order', () => {
        const kb = new KeybindingRegistry([
            { actionId: 'palette.open', description: 'Open Command Palette', shortcut: 'Cmd+K' },
            { actionId: 'term.clear', description: 'Clear Terminal', shortcut: 'Cmd+L' }
        ]);
        const conflicts = kb.rebind('term.clear', 'k+cmd');
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]?.actionIds).toEqual(['palette.open', 'term.clear']);
    });
    it('detects OSC 133 command completion exit codes and translates mobile special keys', () => {
        const esc = String.fromCharCode(27);
        const bel = String.fromCharCode(7);
        const notif = detectCommandCompletion(`output done${esc}]133;D;0${bel}`);
        expect(notif?.reason).toBe('osc133');
        expect(notif?.exitCode).toBe(0);
        expect(translateSpecialKey('Up')).toBe(`${esc}[A`);
    });
});
//# sourceMappingURL=productivity.test.js.map