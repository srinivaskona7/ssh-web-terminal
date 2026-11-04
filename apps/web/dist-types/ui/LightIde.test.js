import { jsx as _jsx } from "preact/jsx-runtime";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { LightIde } from './LightIde';
function entry(name, isDir = false) {
    return { name, path: `./${name}`, isDir, isSymlink: false, size: 0, modTime: 0 };
}
function fakeSession(files, execImpl) {
    const writes = [];
    const commands = [];
    const session = {
        transport: 'cloudflare-relay',
        host: 'example.test',
        user: 'ubuntu',
        port: 22,
        isConnected: () => true,
        exec: async (command) => {
            commands.push(command);
            return execImpl
                ? execImpl(command)
                : { stdout: `ran ${command}`, stderr: '', exitCode: 0 };
        },
        listDir: async (_path) => [entry('app.ts'), entry('src', true)],
        readFile: async (path) => {
            if (!(path in files))
                throw new Error(`No such file: ${path}`);
            return files[path];
        },
        writeFile: async (path, data) => {
            files[path] = new TextDecoder().decode(data);
            writes.push({ path, text: files[path] });
        }
    };
    return { session, writes, commands };
}
const container = () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Preact defers passive effects to the next frame, which jsdom turns into a
// ~100ms timer, so settle long enough for the mount-time folder refresh.
const settle = () => sleep(150);
const input = (el, testId) => {
    const found = el.querySelector(`[data-testid="${testId}"]`);
    expect(found, testId).toBeTruthy();
    return found;
};
describe('LightIde', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        localStorage.clear();
    });
    it('reports that SFTP is unavailable instead of pretending to browse', async () => {
        const el = container();
        render(_jsx(LightIde, { session: null, connectedLabel: "" }), el);
        expect(el.textContent).toContain('Not connected');
        input(el, 'ide-open-project').click();
        await settle();
        expect(el.querySelector('[data-testid="ide-list-error"]')?.textContent).toContain('Disconnected');
        expect(el.querySelector('[data-testid="ide-file-list"]')?.textContent).toContain('No entries');
    });
    it('lists the folder, opens a file, and auto-saves edits back over SFTP', async () => {
        const { session, writes } = fakeSession({ './app.ts': 'export const a = 1;\n' });
        const el = container();
        render(_jsx(LightIde, { session: session, connectedLabel: "ubuntu@example.test" }), el);
        await settle();
        expect(input(el, 'ide-entry-src').textContent).toContain('▸');
        expect(input(el, 'ide-entry-app.ts').textContent).not.toContain('▸');
        input(el, 'ide-entry-app.ts').click();
        await settle();
        const editor = input(el, 'ide-editor');
        expect(editor.value).toBe('export const a = 1;\n');
        expect(el.querySelector('[data-testid="ide-active-path"]')?.textContent).toBe('./app.ts');
        editor.value = 'export const a = 2;\n';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(1400);
        expect(writes).toEqual([{ path: './app.ts', text: 'export const a = 2;\n' }]);
        expect(el.querySelector('[data-testid="ide-status"]')?.textContent).toContain('Saved ./app.ts');
    });
    it('does not auto-save when the checkbox is off, but Save now still writes', async () => {
        const { session, writes } = fakeSession({ './app.ts': 'one\n' });
        const el = container();
        render(_jsx(LightIde, { session: session, connectedLabel: "ubuntu@example.test" }), el);
        await settle();
        input(el, 'ide-entry-app.ts').click();
        await settle();
        const autoSave = input(el, 'ide-auto-save');
        autoSave.checked = false;
        autoSave.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        const editor = input(el, 'ide-editor');
        editor.value = 'two\n';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(1400);
        expect(writes).toEqual([]);
        input(el, 'ide-save').click();
        await settle();
        expect(writes).toEqual([{ path: './app.ts', text: 'two\n' }]);
    });
    it('refuses to overwrite a file that changed on the server unless told to', async () => {
        const files = { './app.ts': 'original\n' };
        const { session, writes } = fakeSession(files);
        const el = container();
        render(_jsx(LightIde, { session: session, connectedLabel: "ubuntu@example.test" }), el);
        await settle();
        input(el, 'ide-entry-app.ts').click();
        await settle();
        files['./app.ts'] = 'edited elsewhere\n';
        const editor = input(el, 'ide-editor');
        editor.value = 'mine\n';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(1400);
        expect(writes).toEqual([]);
        expect(el.querySelector('[data-testid="ide-status"]')?.textContent).toContain('changed on the server');
        const overwrite = el.querySelector('[data-testid="ide-overwrite"]');
        expect(overwrite).toBeTruthy();
        overwrite.click();
        await settle();
        expect(writes).toEqual([{ path: './app.ts', text: 'mine\n' }]);
    });
    it('runs a command and shows its output', async () => {
        const { session } = fakeSession({ './app.ts': 'x\n' });
        const el = container();
        render(_jsx(LightIde, { session: session, connectedLabel: "ubuntu@example.test" }), el);
        await settle();
        const command = input(el, 'ide-command-input');
        command.value = 'ls -la';
        command.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        input(el, 'ide-run-command').click();
        await settle();
        const out = el.querySelector('[data-testid="ide-command-output"]')?.textContent ?? '';
        expect(out).toContain('$ ls -la');
        expect(out).toContain('ran ls -la');
        expect(out).toContain('(exit 0)');
    });
    it('duplicates the current line with Ctrl+D and reports find matches', async () => {
        const { session } = fakeSession({ './app.ts': 'alpha\nalpha beta\n' });
        const el = container();
        render(_jsx(LightIde, { session: session, connectedLabel: "ubuntu@example.test" }), el);
        await settle();
        input(el, 'ide-entry-app.ts').click();
        await settle();
        const editor = input(el, 'ide-editor');
        editor.selectionStart = 0;
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }));
        await settle();
        expect(editor.value.startsWith('alpha\nalpha')).toBe(true);
        expect(editor.value.split('\n').length).toBeGreaterThan(3);
        const find = input(el, 'ide-find-input');
        find.value = 'alpha';
        find.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        expect(el.querySelector('[data-testid="ide-match-count"]')?.textContent).toContain('match');
    });
    it('sends a run command through the project root when asked', async () => {
        const { session, commands } = fakeSession({ './app.ts': 'x\n' });
        const el = container();
        render(_jsx(LightIde, { session: session, connectedLabel: "ubuntu@example.test" }), el);
        await settle();
        const rootInput = input(el, 'ide-root-input');
        rootInput.value = '/srv/app';
        rootInput.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        input(el, 'ide-open-project').click();
        await settle();
        const command = input(el, 'ide-command-input');
        command.value = 'pwd';
        command.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        input(el, 'ide-run-command').click();
        await settle();
        expect(commands.some((c) => c === "cd '/srv/app' && pwd")).toBe(true);
    });
    it('remembers command history and recalls it with ArrowUp', async () => {
        const { session } = fakeSession({ './app.ts': 'x\n' });
        const el = container();
        render(_jsx(LightIde, { session: session, connectedLabel: "ubuntu@example.test" }), el);
        await settle();
        const command = input(el, 'ide-command-input');
        command.value = 'ls -la';
        command.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        input(el, 'ide-run-command').click();
        await settle();
        command.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        await settle();
        expect(command.value).toBe('ls -la');
    });
    it('quick-opens files found on the host and shows git status', async () => {
        const files = { './app.ts': 'x\n', './src/main.ts': 'y\n' };
        const { session } = fakeSession(files, async (cmd) => {
            if (cmd.startsWith('find '))
                return { stdout: './app.ts\n./src/main.ts\n', stderr: '', exitCode: 0 };
            if (cmd.startsWith('git ')) {
                return { stdout: '## main...origin/main\n M app.ts\n?? new.ts\n', stderr: '', exitCode: 0 };
            }
            return { stdout: '', stderr: '', exitCode: 0 };
        });
        const el = container();
        render(_jsx(LightIde, { session: session, connectedLabel: "ubuntu@example.test" }), el);
        await settle();
        const quick = input(el, 'ide-quick-open');
        quick.value = 'main';
        quick.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        input(el, 'ide-quick-open-run').click();
        await settle();
        const results = el.querySelector('[data-testid="ide-quick-results"]');
        expect(results?.textContent).toContain('./src/main.ts');
        input(el, 'ide-git-refresh').click();
        await settle();
        expect(el.querySelector('[data-testid="ide-git-status"]')?.textContent).toBe('main · 2 change(s)');
    });
    it('searches project text and lists the matching file and line', async () => {
        const files = { './app.ts': 'x\n', './src/main.ts': 'needle\n' };
        const { session, commands } = fakeSession(files, async (cmd) => {
            if (cmd.startsWith('grep ')) {
                return { stdout: './src/main.ts:1:needle\n', stderr: '', exitCode: 0 };
            }
            return { stdout: '', stderr: '', exitCode: 0 };
        });
        const el = container();
        render(_jsx(LightIde, { session: session, connectedLabel: "ubuntu@example.test" }), el);
        await settle();
        const query = input(el, 'ide-search-query');
        query.value = 'needle';
        query.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        input(el, 'ide-search-run').click();
        await settle();
        expect(el.querySelector('[data-testid="ide-search-results"]')?.textContent).toContain('./src/main.ts:1');
        expect(commands.some((c) => c.includes('grep -rn') && c.includes("'needle'") && c.includes("'.'"))).toBe(true);
    });
    it('shows the git diff for the open file', async () => {
        const { session, commands } = fakeSession({ './app.ts': 'x\n' }, async (cmd) => {
            if (cmd.includes(' diff ')) {
                return { stdout: '@@ -1 +1 @@\n-x\n+x\n', stderr: '', exitCode: 0 };
            }
            return { stdout: '', stderr: '', exitCode: 0 };
        });
        const el = container();
        render(_jsx(LightIde, { session: session, connectedLabel: "ubuntu@example.test" }), el);
        await settle();
        input(el, 'ide-entry-app.ts').click();
        await settle();
        input(el, 'ide-git-diff').click();
        await settle();
        const diff = el.querySelector('[data-testid="ide-diff"]')?.textContent ?? '';
        expect(diff).toContain('+x');
        expect(diff).toContain('-x');
        expect(commands.some((c) => c.includes("git -C '.' diff -- './app.ts'"))).toBe(true);
    });
    it('asks before a new file truncates an existing one', async () => {
        const files = { './app.ts': 'keep\n' };
        const { session, writes } = fakeSession(files);
        const prompt = vi.spyOn(window, 'prompt').mockReturnValue('app.ts');
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        try {
            const el = container();
            render(_jsx(LightIde, { session: session, connectedLabel: "ubuntu@example.test" }), el);
            await settle();
            input(el, 'ide-new-file').click();
            await settle();
            expect(confirm).toHaveBeenCalledTimes(1);
            expect(writes).toEqual([]);
            expect(files['./app.ts']).toBe('keep\n');
        }
        finally {
            prompt.mockRestore();
            confirm.mockRestore();
        }
    });
});
//# sourceMappingURL=LightIde.test.js.map