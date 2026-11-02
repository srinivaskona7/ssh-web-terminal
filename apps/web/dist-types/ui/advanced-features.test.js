import { describe, expect, it } from 'vitest';
import { DATABASE_TUNNEL_TEMPLATES, computeGhostAutocomplete, computeSideBySideDiff, detectDangerousCommand, formatChmodOctal, redactSecretsInText } from './advanced-features';
describe('Advanced Feature Suite — Smart Shell, SFTP Chmod/Diff, Tunnels & Safety Guard', () => {
    it('computes inline ghost-text autocomplete from history and built-in commands', () => {
        expect(computeGhostAutocomplete('hel')).toBe('p');
        expect(computeGhostAutocomplete('kubectl get', ['kubectl get nodes -o wide'])).toBe(' nodes -o wide');
        expect(computeGhostAutocomplete('')).toBe('');
    });
    it('detects destructive shell commands before execution', () => {
        expect(detectDangerousCommand('rm -rf /').dangerous).toBe(true);
        expect(detectDangerousCommand('mkfs.ext4 /dev/sda1').dangerous).toBe(true);
        expect(detectDangerousCommand('DROP DATABASE production;').dangerous).toBe(true);
        expect(detectDangerousCommand('ls -la /var/log').dangerous).toBe(false);
    });
    it('redacts secrets, AWS keys, JWTs, and Ed25519 keys when streamer redaction mode is active', () => {
        const raw = 'export AWS=AKIA1234567890ABCDEF token=supersecret123';
        const masked = redactSecretsInText(raw, true);
        expect(masked).not.toContain('AKIA1234567890ABCDEF');
        expect(masked).not.toContain('supersecret123');
        expect(redactSecretsInText(raw, false)).toBe(raw);
    });
    it('calculates chmod octal and symbolic strings accurately', () => {
        const rwxrXrX = formatChmodOctal({
            ownerRead: true,
            ownerWrite: true,
            ownerExec: true,
            groupRead: true,
            groupWrite: false,
            groupExec: true,
            publicRead: true,
            publicWrite: false,
            publicExec: true
        });
        expect(rwxrXrX).toEqual({ octal: '0755', symbolic: '-rwxr-xr-x' });
    });
    it('computes side-by-side line diff status for remote file editor', () => {
        const nl = String.fromCharCode(10);
        const diff = computeSideBySideDiff(['worker_processes auto;', 'worker_connections 1024;'].join(nl), ['worker_processes 8;', 'worker_connections 1024;', 'gzip on;'].join(nl));
        expect(diff[0]?.status).toBe('modified');
        expect(diff[1]?.status).toBe('unchanged');
        expect(diff[2]?.status).toBe('added');
        expect(DATABASE_TUNNEL_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    });
});
//# sourceMappingURL=advanced-features.test.js.map