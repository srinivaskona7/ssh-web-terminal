import { describe, expect, it } from 'vitest';
import { buildMetricsScript, controlService, parseMetricsOutput, parseProcessList, parseServiceList, serviceLogs } from '../control/server-control.js';
function fakeSession(stdout, exitCode = 0, stderr = '') {
    const commands = [];
    const session = {
        transport: 'cloudflare-relay',
        host: 'example.test',
        user: 'ops',
        port: 22,
        isConnected: () => true,
        exec: async (command) => {
            commands.push(command);
            return { stdout, stderr, exitCode };
        }
    };
    return { session, commands };
}
describe('metrics probe', () => {
    it('computes CPU and network deltas from two samples', () => {
        const stdout = [
            '@@CTL:cpu 100 900|200 950',
            '@@CTL:net 1000 2000|1400 2800',
            '@@CTL:load 0.10 0.20 0.30',
            '@@CTL:mem 8000 2000 5500|swap 0',
            '@@CTL:uptime 3600.42',
            '@@CTL:reboot no',
            '@@CTL:df / 100000 40000 60000|/data 200000 100000 100000'
        ].join('\n');
        const metrics = parseMetricsOutput(stdout, 123);
        expect(metrics.cpuPercent).toBe(50);
        expect(metrics.loadAverage).toEqual([0.1, 0.2, 0.3]);
        expect(metrics.memory).toEqual({
            totalMiB: 8000,
            usedMiB: 2000,
            availableMiB: 5500,
            swapUsedMiB: 0
        });
        expect(metrics.uptimeSeconds).toBe(3600);
        expect(metrics.rebootRequired).toBe(false);
        expect(metrics.network).toEqual({ rxKiBps: 1000, txKiBps: 2000 });
        expect(metrics.disks).toHaveLength(2);
        expect(metrics.disks[0]).toMatchObject({ mount: '/', usedPercent: 40 });
        expect(metrics.collectedAt).toBe(123);
    });
    it('returns null fields instead of guesses when a probe is missing', () => {
        const metrics = parseMetricsOutput('@@CTL:reboot yes\n');
        expect(metrics.cpuPercent).toBeNull();
        expect(metrics.memory).toBeNull();
        expect(metrics.network).toBeNull();
        expect(metrics.loadAverage).toBeNull();
        expect(metrics.uptimeSeconds).toBeNull();
        expect(metrics.disks).toEqual([]);
        expect(metrics.rebootRequired).toBe(true);
    });
    it('builds one script carrying every marker', () => {
        const script = buildMetricsScript();
        for (const marker of ['cpu', 'net', 'load', 'mem', 'uptime', 'df']) {
            expect(script).toContain(`@@CTL:${marker}`);
        }
        expect(script).toContain('sleep 0.4');
    });
});
describe('process and service parsing', () => {
    it('parses ps output and ignores the header-less noise', () => {
        const processes = parseProcessList('  812 root      12.5  1.2 01:02:03 /usr/bin/sshd: /usr/sbin/sshd\nbogus line\n  900 app 0.4 0.1 1-00:00:00 node server.js\n');
        expect(processes).toHaveLength(2);
        expect(processes[0]).toMatchObject({ pid: 812, user: 'root', cpuPercent: 12.5 });
        expect(processes[1]?.command).toBe('node server.js');
    });
    it('parses systemctl list-units rows, including the failed marker', () => {
        const services = parseServiceList([
            '● nginx.service loaded failed failed A high performance web server',
            'ssh.service loaded active running OpenBSD Secure Shell server',
            ''
        ].join('\n'));
        expect(services).toHaveLength(2);
        const nginx = services[0];
        expect(nginx).toMatchObject({ name: 'nginx.service', active: 'failed' });
    });
});
describe('service actions', () => {
    it('rejects names that could inject shell syntax', async () => {
        const { session } = fakeSession('');
        await expect(controlService(session, 'nginx; rm -rf /', 'restart', true)).rejects.toThrow(/Invalid service name/);
        await expect(serviceLogs(session, '$(id)')).rejects.toThrow(/Invalid service name/);
    });
    it('runs sudo -n and quotes the unit name', async () => {
        const { session, commands } = fakeSession('');
        await controlService(session, 'nginx.service', 'restart', true);
        expect(commands[0]).toBe("sudo -n systemctl restart 'nginx.service'");
    });
    it('surfaces the privilege requirement instead of hanging', async () => {
        const { session } = fakeSession('', 1, 'sudo: a password is required');
        await expect(controlService(session, 'nginx.service', 'stop', true)).rejects.toThrow(/password is required/);
    });
});
//# sourceMappingURL=server-control.test.js.map