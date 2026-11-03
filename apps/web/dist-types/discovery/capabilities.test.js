import { describe, expect, it } from 'vitest';
import { buildDiscoveryScript, parseCapabilities, PROBED_TOOLS } from './capabilities.js';
const SAMPLE = [
    '@@WEBSSH:hostname',
    'web-01',
    '@@WEBSSH:uname',
    'Linux',
    '6.8.0-31-generic',
    'x86_64',
    '@@WEBSSH:osrelease',
    'NAME="Ubuntu"',
    'VERSION_ID="24.04"',
    '@@WEBSSH:cpu',
    '4',
    ' Intel(R) Xeon(R) Platinum',
    '@@WEBSSH:mem',
    '              total        used        free      shared  buff/cache   available',
    'Mem:           7982        1200        900         100        5882        6500',
    'Swap:          2047           0        2047',
    '@@WEBSSH:df',
    '/dev/root        40960 20000 20960  49% /',
    'tmpfs             100     0   100   0% /run',
    '@@WEBSSH:id',
    'uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),27(sudo)',
    '@@WEBSSH:groups',
    'ubuntu sudo docker',
    '@@WEBSSH:home',
    '/home/ubuntu',
    '/bin/bash',
    '@@WEBSSH:sudo',
    'yes',
    'nopasswd',
    '@@WEBSSH:pkg',
    'apt-get',
    '@@WEBSSH:init',
    'systemd',
    '@@WEBSSH:tools',
    'TOOL git /usr/bin/git',
    'TOOL python3 /usr/bin/python3',
    'TOOL docker /usr/bin/docker',
    '@@WEBSSH:versions',
    'VER git git version 2.43.0',
    'VER python3 Python 3.12.3',
    '@@WEBSSH:ports',
    'State  Recv-Q Send-Q Local Address:Port Peer Address:Port',
    'LISTEN 0      4096         0.0.0.0:22        0.0.0.0:*',
    'LISTEN 0      4096       127.0.0.1:5432      0.0.0.0:*',
    '@@WEBSSH:firewall',
    'ufw',
    'Status: active',
    '@@WEBSSH:time',
    'System clock synchronized: yes',
    '@@WEBSSH:reboot',
    'no',
    '@@WEBSSH:end'
].join('\n');
describe('server discovery', () => {
    it('probes every catalogued tool in the static script', () => {
        const script = buildDiscoveryScript();
        for (const tool of PROBED_TOOLS) {
            expect(script).toContain(tool.id);
        }
        // Read-only by construction.
        expect(script).not.toMatch(/\b(apt-get|dnf|yum|apk|pacman|zypper)\s+(install|add)/);
        expect(script).not.toMatch(/(^|\s)(rm|mkfs|dd)\s/);
    });
    it('parses an Ubuntu host into the capability model', () => {
        const caps = parseCapabilities(SAMPLE, { sftpAvailable: true });
        expect(caps.hostname).toBe('web-01');
        expect(caps.os).toMatchObject({ family: 'linux', distro: 'Ubuntu', version: '24.04', arch: 'x86_64' });
        expect(caps.cpu.cores).toBe(4);
        expect(caps.memory.totalMiB).toBe(7982);
        expect(caps.disks).toHaveLength(1);
        expect(caps.disks[0]).toMatchObject({ mount: '/', usePercent: 49 });
        expect(caps.user).toMatchObject({ name: 'ubuntu', uid: 1000, home: '/home/ubuntu', isRoot: false });
        expect(caps.user.groups).toContain('sudo');
        expect(caps.privilege).toEqual({ sudoAvailable: true, sudoNopasswd: true, isRoot: false });
        expect(caps.packages.manager).toBe('apt-get');
        expect(caps.init).toEqual({ manager: 'systemd', systemd: true });
        expect(caps.tools.git).toMatchObject({ state: 'installed', version: '2.43.0' });
        expect(caps.tools.python3?.version).toBe('3.12.3');
        expect(caps.tools.node?.state).toBe('unsupported');
        expect(caps.listeners.map((l) => l.port)).toEqual([22, 5432]);
        expect(caps.firewall).toEqual({ tool: 'ufw', active: true });
        expect(caps.time.synchronized).toBe(true);
        expect(caps.warnings).toEqual([]);
    });
    it('records an unavailable SFTP subsystem as an explicit warning', () => {
        const caps = parseCapabilities(SAMPLE, { sftpAvailable: false });
        expect(caps.warnings.join(' ')).toMatch(/SFTP subsystem is unavailable/);
    });
    it('does not invent data when sections are missing', () => {
        const caps = parseCapabilities('', {});
        expect(caps.cpu.cores).toBe(0);
        expect(caps.memory.totalMiB).toBe(0);
        expect(caps.disks).toEqual([]);
        expect(caps.warnings.length).toBeGreaterThan(0);
    });
});
//# sourceMappingURL=capabilities.test.js.map