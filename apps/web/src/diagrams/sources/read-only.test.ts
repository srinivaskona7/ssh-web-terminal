import { describe, expect, it } from 'vitest';
import { assertReadOnlyCommand, findReadOnlyViolation, ReadOnlyViolation } from './read-only.js';

const ALLOWED = [
  'kubectl config current-context',
  'kubectl get nodes,namespaces -o json --request-timeout=20s',
  'kubectl get pods -A -o json',
  'kubectl get pods -n kube-system -o json',
  'kubectl get secrets -A -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name',
  'kubectl get configmaps -n default -o name',
  'docker ps -a --format "{{json .}}"',
  "docker ps -a --no-trunc --format '{{json .}}'",
  'docker inspect --format "{{json .State.Status}}" web',
  'docker inspect -f "{{.Name}} {{.HostConfig.NetworkMode}}" web db',
  'docker network ls --format "{{json .}}"',
  'docker network inspect --format "{{json .Containers}}" bridge',
  'docker volume ls --format "{{json .}}"',
  'docker image ls --format "{{json .}}"',
  'systemctl list-units --type=service --all --no-legend --no-pager --plain',
  'systemctl show sshd.service nginx.service --no-pager -p Id,MainPID,ActiveState',
  'ss -tulpnH',
  'ss -tn state established',
  'ps -eo pid=,ppid=,comm=,cgroup=',
  'id -u',
  'ss -tulpnH | head -n 400',
  'systemctl list-units --all | wc -l'
];

const REFUSED: Array<[string, string]> = [
  ['kubectl delete pod web', 'delete'],
  ['kubectl apply -f x.yaml', 'apply'],
  ['kubectl exec web -- ls', 'exec'],
  ['kubectl get secret db -o json', 'secret json'],
  ['kubectl get secrets -n default -o json', 'secrets json'],
  ['kubectl get configmap app -o yaml', 'configmap yaml'],
  ['kubectl get secrets -o custom-columns=D:.data', 'data column'],
  ['kubectl get pods -o jsonpath={.items}', 'jsonpath'],
  ["kubectl 'delete' pod web", 'quoted verb'],
  ['kubectl get pods; rm -rf /', 'semicolon'],
  ['kubectl get pods && id', 'and'],
  ['kubectl get pods || id', 'or'],
  ['kubectl get pods > /tmp/x', 'redirect'],
  ['kubectl get pods $(id)', 'subshell'],
  ['kubectl get pods `id`', 'backtick'],
  ['kubectl get pods -o "$X"', 'expansion in double quotes'],
  ['kubectl get pods --raw /api', 'raw'],
  ['kubectl get pods --token abc', 'token flag'],
  ['kubectl get pods --kubeconfig /x', 'kubeconfig'],
  ['docker rm -f web', 'rm'],
  ['docker run alpine', 'run'],
  ['docker exec web ls', 'exec'],
  ['docker inspect web', 'inspect without format'],
  ['docker inspect --format "{{json .Config.Env}}" web', 'Config.Env'],
  ['docker inspect --format "{{json .Config}}" web', 'Config'],
  ['docker inspect --format "{{json .}}" web', 'whole object'],
  ['docker inspect --format "{{index .Config.Env 0}}" web', 'index action'],
  ['docker inspect --format "{{.Name}}" ../etc', 'bad name'],
  ['docker network rm bridge', 'network rm'],
  ['docker volume rm v', 'volume rm'],
  ['docker image rm x', 'image rm'],
  ['docker ps extra', 'positional'],
  ['systemctl restart sshd', 'restart'],
  ['systemctl show sshd', 'not a unit'],
  ['systemctl list-units foo.service', 'list-units unit'],
  ['systemctl daemon-reload', 'reload'],
  ['ss -K', 'ss kill'],
  ['ss -D /tmp/x', 'ss dump'],
  ['ss state bogus', 'ss state'],
  ['ps aux', 'ps'],
  ['ps -eo args', 'args column'],
  ['id', 'id bare'],
  ['rm -rf /', 'rm'],
  ['cat /etc/shadow', 'cat'],
  ['sh -c "id"', 'sh'],
  ['ss -tn | sh', 'pipe to shell'],
  ['head -n 3', 'filter first'],
  ['ss -tn | tee x', 'tee'],
  ['ss -tn | head -n', 'head arg'],
  ['ss -tn | wc -c', 'wc -c'],
  ['ss -tn |', 'trailing pipe'],
  ['| ss -tn', 'leading pipe'],
  ['', 'empty'],
  ['   ', 'blank'],
  ['ss -tn\nid -u', 'newline'],
  ["kubectl get 'pods", 'unterminated'],
  ['kubectl get "pods', 'unterminated double']
];

describe('assertReadOnlyCommand', () => {
  it.each(ALLOWED)('allows %s', (command) => {
    expect(findReadOnlyViolation(command)).toBeNull();
    expect(() => assertReadOnlyCommand(command)).not.toThrow();
  });

  it.each(REFUSED)('refuses %s (%s)', (command) => {
    expect(findReadOnlyViolation(command)).not.toBeNull();
    expect(() => assertReadOnlyCommand(command)).toThrow(ReadOnlyViolation);
  });

  it('names the command and reason on the error', () => {
    try {
      assertReadOnlyCommand('kubectl delete pod web');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ReadOnlyViolation);
      const violation = err as ReadOnlyViolation;
      expect(violation.command).toBe('kubectl delete pod web');
      expect(violation.reason).toContain('delete');
      expect(violation.message).toContain('read-only');
    }
  });

  it('refuses oversized commands', () => {
    expect(findReadOnlyViolation(`kubectl get pods -l ${'a'.repeat(40000)}`)).toContain('too long');
  });

  it('refuses a flag without its value', () => {
    expect(findReadOnlyViolation('kubectl get pods -n')).toContain('needs a value');
    expect(findReadOnlyViolation('kubectl get pods --no-headers=1')).toContain('does not take a value');
  });

  it('refuses malformed namespaces and resource lists', () => {
    expect(findReadOnlyViolation('kubectl get pods -n Bad_NS')).toContain('namespace');
    expect(findReadOnlyViolation('kubectl get Pods,')).toContain('resource list');
    expect(findReadOnlyViolation('kubectl get')).toContain('exactly one');
  });

  it('refuses malformed custom-columns and templates', () => {
    expect(findReadOnlyViolation('kubectl get pods -o custom-columns=a b')).not.toBeNull();
    expect(findReadOnlyViolation('docker ps --format "{{json ."')).toContain('malformed');
  });

  it('refuses ps -o in the middle of a group and without columns', () => {
    expect(findReadOnlyViolation('ps -oe pid=')).toContain('last');
    expect(findReadOnlyViolation('ps -eo')).toContain('column');
    expect(findReadOnlyViolation('ps -e')).toContain('-o');
  });
});
