import { posixQuote } from '../recipes/engine.js';
import { validateGitRef, validateRemoteDirectory } from '../session/remote-session.js';
function gitArgv(dir, argv) {
    return ['git', '-C', posixQuote(dir), ...argv.map(posixQuote)].join(' ');
}
export class GitClient {
    session;
    dir;
    constructor(session, dir) {
        this.session = session;
        this.dir = dir;
        validateRemoteDirectory(dir);
    }
    async run(argv, timeoutMs = 60_000) {
        const result = await this.session.exec(gitArgv(this.dir, argv), { timeoutMs });
        if (result.exitCode !== 0) {
            throw new Error(`git ${argv[0]} failed: ${(result.stderr || result.stdout).trim()}`);
        }
        return result;
    }
    async isRepository() {
        const result = await this.session.exec(gitArgv(this.dir, ['rev-parse', '--is-inside-work-tree']));
        return result.exitCode === 0 && result.stdout.trim() === 'true';
    }
    async status() {
        const result = await this.run(['status', '--porcelain=v1', '-z', '--branch']);
        const parts = result.stdout.split('\0');
        const status = {
            branch: '',
            ahead: 0,
            behind: 0,
            files: [],
            clean: true
        };
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i] ?? '';
            if (!part)
                continue;
            if (part.startsWith('## ')) {
                const header = part.slice(3);
                const branchPart = header.split('...')[0]?.trim() ?? '';
                status.branch = branchPart.replace(/^No commits yet on /, '');
                const upstream = header.match(/\.\.\.(\S+)/);
                if (upstream)
                    status.upstream = upstream[1];
                const ahead = header.match(/ahead (\d+)/);
                const behind = header.match(/behind (\d+)/);
                if (ahead)
                    status.ahead = Number.parseInt(ahead[1], 10);
                if (behind)
                    status.behind = Number.parseInt(behind[1], 10);
                continue;
            }
            // Porcelain v1 -z: "XY path". Renames and copies are followed by a
            // second NUL-separated field holding the original path; without skipping
            // it, that path is parsed as a phantom file entry.
            const index = part[0] ?? ' ';
            const worktree = part[1] ?? ' ';
            const path = part.slice(3);
            status.files.push({ path, code: `${index}${worktree}`, index, worktree });
            if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
                i += 1;
            }
        }
        status.clean = status.files.length === 0;
        return status;
    }
    async diff(path, staged = false) {
        const argv = ['diff', '--no-color'];
        if (staged)
            argv.push('--cached');
        if (path)
            argv.push('--', path);
        const result = await this.session.exec(gitArgv(this.dir, argv), { timeoutMs: 60_000 });
        return result.stdout;
    }
    async branches() {
        const result = await this.run(['branch', '--format=%(refname:short)']);
        const branches = result.stdout
            .split('\n')
            .map((b) => b.trim())
            .filter(Boolean);
        const currentResult = await this.run(['rev-parse', '--abbrev-ref', 'HEAD']);
        return { current: currentResult.stdout.trim(), branches };
    }
    async log(limit = 50) {
        const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
        const result = await this.run([
            'log',
            `-n`,
            String(safeLimit),
            '--pretty=format:%H%x09%h%x09%an%x09%aI%x09%s'
        ]);
        return result.stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => {
            const [hash = '', shortHash = '', author = '', date = '', ...subject] = line.split('\t');
            return { hash, shortHash, author, date, subject: subject.join(' ') };
        });
    }
    async stage(paths) {
        if (paths.length === 0) {
            await this.run(['add', '-A']);
            return;
        }
        await this.run(['add', '--', ...paths]);
    }
    async unstage(paths) {
        await this.run(['reset', 'HEAD', '--', ...(paths.length ? paths : ['.'])]);
    }
    async commit(message) {
        const trimmed = message.trim();
        if (!trimmed)
            throw new Error('A commit message is required');
        if (trimmed.length > 5000)
            throw new Error('Commit message is too long');
        await this.run(['commit', '-m', trimmed]);
        const hash = (await this.run(['rev-parse', 'HEAD'])).stdout.trim();
        const summary = (await this.run(['show', '-s', '--format=%s', 'HEAD'])).stdout.trim();
        return { hash, summary };
    }
    async fetch(remote = 'origin') {
        const result = await this.run(['fetch', validateGitRef(remote)], 120_000);
        return result.stdout + result.stderr;
    }
    /** Fast-forward only. Never rewrites history or discards local changes. */
    async pull() {
        const result = await this.run(['pull', '--ff-only'], 180_000);
        return result.stdout + result.stderr;
    }
    /** Plain push only — force-push is not exposed anywhere in the UI. */
    async push(setUpstream = false) {
        const argv = ['push'];
        if (setUpstream)
            argv.push('-u', 'origin', 'HEAD');
        const result = await this.run(argv, 180_000);
        return result.stdout + result.stderr;
    }
    async checkout(branch) {
        await this.run(['checkout', validateGitRef(branch)]);
    }
    async createBranch(branch) {
        await this.run(['checkout', '-b', validateGitRef(branch)]);
    }
}
//# sourceMappingURL=git-client.js.map