import { describe, expect, it } from 'vitest';
import { dockerfileLintTool, lintDockerfile, parseDockerfile, type DockerfileIssue } from './dockerfile-lint.js';
import { fakeSession } from './fake-session.js';

const doc = (...lines: string[]): string => lines.join('\n') + '\n';
const DIGEST = 'sha256:' + 'ab'.repeat(32);

/** `rule@line` pairs, the shape most assertions care about. */
const hits = (issues: DockerfileIssue[]): string[] => issues.map((issue) => `${issue.rule}@${issue.line}`).sort();

describe('parseDockerfile', () => {
  it('joins continuation lines, drops comment lines inside them, and keeps start line numbers', () => {
    const parsed = parseDockerfile(
      doc(
        'FROM debian:12',
        'RUN apt-get update && \\',
        '    # tools for the build',
        '    apt-get install -y make \\   ',
        '',
        '    && echo done',
        'CMD ["make"]'
      )
    );
    expect(parsed.instructions.map((i) => [i.keyword, i.line])).toEqual([
      ['FROM', 1],
      ['RUN', 2],
      ['CMD', 7]
    ]);
    expect(parsed.instructions[1]?.args).toBe('apt-get update &&     apt-get install -y make     && echo done');
  });

  it('honours the escape parser directive and only at the top of the file', () => {
    const windows = parseDockerfile(
      doc('# escape=`', 'FROM mcr.microsoft.com/windows/servercore:ltsc2022', 'RUN powershell -Command `', '    Write-Host hi')
    );
    expect(windows.escape).toBe('`');
    expect(windows.instructions[1]).toMatchObject({ keyword: 'RUN', args: 'powershell -Command     Write-Host hi' });

    const late = parseDockerfile(doc('# a comment first', '# escape=`', 'FROM alpine:3.19'));
    expect(late.escape).toBe('\\');
  });

  it('accepts lowercase instructions and CRLF line endings', () => {
    const parsed = parseDockerfile('from alpine:3.19\r\nrun apk add --no-cache curl\r\n');
    expect(parsed.instructions.map((i) => [i.keyword, i.args])).toEqual([
      ['FROM', 'alpine:3.19'],
      ['RUN', 'apk add --no-cache curl']
    ]);
  });

  it('reads heredoc bodies as part of the instruction, not as instructions', () => {
    const parsed = parseDockerfile(
      doc('FROM debian:12', 'RUN <<EOF', 'apt-get update', 'FROM is just text here', 'EOF', 'USER app')
    );
    expect(parsed.instructions.map((i) => i.keyword)).toEqual(['FROM', 'RUN', 'USER']);
    expect(parsed.instructions[1]?.heredocs).toEqual(['apt-get update\nFROM is just text here']);
    expect(parsed.instructions[2]?.line).toBe(6);
  });

  it('assigns instructions to stages and collects leading flags', () => {
    const parsed = parseDockerfile(
      doc(
        'ARG GO=1.22',
        'FROM --platform=$BUILDPLATFORM golang:${GO} AS build',
        'RUN --mount=type=cache,target=/root/.cache/go-build go build ./...',
        'FROM scratch',
        'COPY --from=build /out/app /app'
      )
    );
    expect(parsed.instructions.map((i) => [i.keyword, i.stage])).toEqual([
      ['ARG', -1],
      ['FROM', 0],
      ['RUN', 0],
      ['FROM', 1],
      ['COPY', 1]
    ]);
    expect(parsed.instructions[2]?.flags).toEqual(['--mount=type=cache,target=/root/.cache/go-build']);
  });
});

describe('lintDockerfile', () => {
  it('finds nothing wrong with a pinned, non-root, health-checked multi-stage build', () => {
    const report = lintDockerfile(
      doc(
        '# syntax=docker/dockerfile:1.7',
        'ARG NODE_VERSION=20.11.1',
        '',
        'FROM node:${NODE_VERSION}-bookworm-slim AS build',
        'WORKDIR /app',
        'COPY package.json package-lock.json ./',
        'RUN npm ci',
        'COPY . .',
        'RUN npm run build',
        '',
        `FROM gcr.io/distroless/nodejs20-debian12@${DIGEST} AS runtime`,
        'COPY --from=build /app/dist /app',
        'USER 10001:10001',
        'EXPOSE 8080',
        'HEALTHCHECK --interval=30s CMD ["/nodejs/bin/node", "/app/healthcheck.js"]',
        'CMD ["/app/server.js"]'
      )
    );
    expect(report.stages).toBe(2);
    expect(report.issues).toEqual([]);
  });

  it('reports every rule with its line number', () => {
    const report = lintDockerfile(
      doc(
        'FROM ubuntu',
        'FROM python:latest AS app',
        'RUN apt-get update && apt-get install -y curl \\',
        '    git',
        'ADD ./src /app',
        'ADD https://example.com/tool.tar.gz /opt/',
        'ADD vendor.tar.gz /opt/vendor/',
        'RUN curl -fsSL https://get.example.sh | sudo bash',
        'ENV API_TOKEN=abc123 LOG_LEVEL=debug',
        'ARG DB_PASSWORD=hunter2',
        'ARG GITHUB_TOKEN',
        'ENV GPG_KEY=0123456789ABCDEF',
        'ENV DB_PASSWORD_FILE=/run/secrets/db',
        'EXPOSE 22 8080',
        'COPY . /app',
        'RUN pip install -r requirements.txt',
        'USER root'
      )
    );
    expect(hits(report.issues)).toEqual(
      [
        'from-untagged@1',
        'from-latest@2',
        'apt-recommends@3',
        'apt-lists@3',
        'add-local@5',
        'curl-pipe-shell@8',
        'sudo@8',
        'secret-literal@9',
        'secret-literal@10',
        'expose-ssh@14',
        'copy-before-install@15',
        'user-root@17',
        'no-healthcheck@2'
      ].sort()
    );
    const severity = Object.fromEntries(report.issues.map((issue) => [`${issue.rule}@${issue.line}`, issue.severity]));
    expect(severity).toMatchObject({
      'from-untagged@1': 'warning',
      'from-latest@2': 'warning',
      'apt-recommends@3': 'info',
      'apt-lists@3': 'info',
      'add-local@5': 'info',
      'curl-pipe-shell@8': 'critical',
      'sudo@8': 'warning',
      'secret-literal@9': 'critical',
      'expose-ssh@14': 'warning',
      'copy-before-install@15': 'info',
      'user-root@17': 'warning',
      'no-healthcheck@2': 'info'
    });
  });

  it('never repeats a secret value in its finding', () => {
    const report = lintDockerfile(doc('FROM alpine:3.19', 'ENV DB_PASSWORD="p@ss word" SECRET_KEY changeme', 'USER app'));
    const secrets = report.issues.filter((issue) => issue.rule === 'secret-literal');
    expect(secrets.map((issue) => issue.message)).toEqual([expect.stringContaining('DB_PASSWORD')]);
    expect(JSON.stringify(report.issues)).not.toContain('p@ss');
    // Legacy `ENV NAME value` form is a single pair: everything after the name is the value.
    const legacy = lintDockerfile(doc('FROM alpine:3.19', 'ENV SECRET_KEY changeme now', 'USER app'));
    expect(hits(legacy.issues)).toContain('secret-literal@2');
    expect(JSON.stringify(legacy.issues)).not.toContain('changeme');
  });

  it('treats references, empty values and *_FILE paths as non-literal secrets', () => {
    const report = lintDockerfile(
      doc(
        'FROM alpine:3.19',
        'ARG API_KEY',
        'ENV API_KEY=$API_KEY SESSION_TOKEN=${SESSION_TOKEN} DB_PASSWORD="" PASSWORD_FILE=/run/secrets/pw',
        'ENV MONKEY=banana KEYBOARD=us PUBLIC_KEY_URL=https://example.com/key.asc',
        'USER app'
      )
    );
    expect(report.issues.filter((issue) => issue.rule === 'secret-literal')).toEqual([]);
  });

  it('accepts apt installs that skip recommends and clean lists, or cache them in a mount', () => {
    const report = lintDockerfile(
      doc(
        'FROM debian:12',
        'RUN apt-get update && \\',
        '    apt-get -y install --no-install-recommends curl && \\',
        '    rm -rf /var/lib/apt/lists/*',
        'RUN --mount=type=cache,target=/var/lib/apt/lists --mount=type=cache,target=/var/cache/apt \\',
        '    apt-get update && apt-get install -y --no-install-recommends gcc',
        'RUN apt install -y jq',
        'USER app'
      )
    );
    expect(hits(report.issues.filter((issue) => issue.rule.startsWith('apt')))).toEqual(['apt-lists@7', 'apt-recommends@7']);
  });

  it('checks heredoc and exec-form RUN bodies too', () => {
    const report = lintDockerfile(
      doc(
        'FROM debian:12',
        'RUN <<EOF',
        'set -e',
        'wget -qO- https://install.example.com | sh',
        'EOF',
        'RUN ["apt-get", "install", "-y", "curl"]',
        'USER app'
      )
    );
    expect(hits(report.issues)).toEqual(
      ['curl-pipe-shell@2', 'apt-recommends@6', 'apt-lists@6', 'no-healthcheck@1'].sort()
    );
  });

  it('distinguishes piping a download into a shell from other uses of curl', () => {
    const lint = (run: string): string[] =>
      lintDockerfile(doc('FROM alpine:3.19', `RUN ${run}`, 'USER app', 'HEALTHCHECK NONE'))
        .issues.filter((issue) => issue.rule === 'curl-pipe-shell')
        .map((issue) => issue.rule);
    expect(lint('curl -sSL https://x.example/i.sh | bash -s -- --yes')).toEqual(['curl-pipe-shell']);
    expect(lint('curl "https://x.example/i?a=1&b=2" | sh')).toEqual(['curl-pipe-shell']);
    expect(lint('curl -fsSL https://x.example/a.tgz | tar xz')).toEqual([]);
    expect(lint('curl -o /tmp/notes https://x.example/n && cat /tmp/notes | sh')).toEqual([]);
    expect(lint('echo "curl https://x | sh" > /README')).toEqual([]);
  });

  it('flags sudo only where it runs as a command', () => {
    const rules = (run: string): string[] =>
      lintDockerfile(doc('FROM debian:12', `RUN ${run}`, 'USER app'))
        .issues.filter((issue) => issue.rule === 'sudo')
        .map((issue) => issue.rule);
    expect(rules('sudo make install')).toEqual(['sudo']);
    expect(rules('make && sudo make install')).toEqual(['sudo']);
    expect(rules('apt-get install -y --no-install-recommends sudo && rm -rf /var/lib/apt/lists/*')).toEqual([]);
  });

  it('reports a missing USER on the final stage, following stages it builds on', () => {
    expect(hits(lintDockerfile(doc('FROM alpine:3.19', 'HEALTHCHECK CMD true')).issues)).toEqual(['no-user@1']);
    const inherited = lintDockerfile(
      doc('FROM alpine:3.19 AS base', 'USER app', 'HEALTHCHECK CMD true', 'FROM base AS final', 'CMD ["app"]')
    );
    expect(inherited.issues).toEqual([]);
    const backToRoot = lintDockerfile(doc('FROM alpine:3.19', 'USER app', 'USER 0:0', 'HEALTHCHECK CMD true'));
    expect(hits(backToRoot.issues)).toEqual(['user-root@3']);
  });

  it('notes HEALTHCHECK NONE as an explicit opt-out', () => {
    const report = lintDockerfile(doc('FROM alpine:3.19', 'USER app', 'HEALTHCHECK NONE'));
    expect(report.issues).toEqual([
      expect.objectContaining({ rule: 'no-healthcheck', line: 3, severity: 'info', message: expect.stringMatching(/NONE/) })
    ]);
  });

  it('skips tag checks for scratch and earlier stages, and says when a build argument hides the tag', () => {
    const report = lintDockerfile(
      doc('ARG BASE', 'FROM ${BASE} AS one', 'FROM scratch AS two', 'FROM one', 'USER app', 'HEALTHCHECK CMD true')
    );
    expect(hits(report.issues)).toEqual(['from-arg@2']);
    expect(report.issues[0]?.severity).toBe('info');
  });

  it('handles ADD sources: local files flagged, URLs and archives allowed, flags and JSON form parsed', () => {
    const report = lintDockerfile(
      doc(
        'FROM alpine:3.19',
        'ADD --chown=app:app config.yml /etc/app/',
        'ADD git@github.com:acme/repo.git /src',
        'ADD ["a b.txt", "/dst/"]',
        'ADD rootfs.tar.xz /',
        'USER app',
        'HEALTHCHECK CMD true'
      )
    );
    expect(hits(report.issues)).toEqual(['add-local@2', 'add-local@4']);
  });

  it('flags COPY of the whole context only when a dependency install comes after it in the same stage', () => {
    const report = lintDockerfile(
      doc(
        'FROM golang:1.22 AS build',
        'COPY go.mod go.sum ./',
        'RUN go mod download',
        'COPY . .',
        'RUN go build -o /out/app ./cmd/app',
        'FROM node:20-slim AS web',
        'COPY --from=build /out/app /usr/local/bin/app',
        'COPY ./ /web/',
        'RUN yarn install --frozen-lockfile',
        'USER node',
        'HEALTHCHECK CMD true'
      )
    );
    expect(hits(report.issues)).toEqual(['copy-before-install@8']);
  });

  it('flags only port 22 in EXPOSE', () => {
    const rules = (expose: string): string[] =>
      lintDockerfile(doc('FROM alpine:3.19', `EXPOSE ${expose}`, 'USER app', 'HEALTHCHECK CMD true')).issues.map(
        (issue) => issue.rule
      );
    expect(rules('22/tcp')).toEqual(['expose-ssh']);
    expect(rules('2222 8022 80/tcp')).toEqual([]);
  });

  it('reports unknown instructions and a file without FROM', () => {
    expect(hits(lintDockerfile(doc('FROM alpine:3.19', 'RUNN echo hi', 'USER app', 'HEALTHCHECK CMD true')).issues)).toEqual([
      'unknown-instruction@2'
    ]);
    expect(hits(lintDockerfile('root:x:0:0:root:/root:/bin/bash\n').issues)).toContain('no-from@1');
    expect(lintDockerfile('').issues.map((issue) => issue.rule)).toEqual(['no-from']);
  });
});

describe('dockerfileLintTool', () => {
  const path = '/srv/app/Dockerfile';
  const content = doc('FROM node:latest', 'COPY . .', 'RUN npm ci', 'CMD ["node", "server.js"]');

  it('previews the cat command it falls back to and runs exactly that without SFTP', async () => {
    const preview = dockerfileLintTool.preview({ path });
    expect(preview).toEqual(["cat -- '/srv/app/Dockerfile'"]);
    const { session, commands } = fakeSession({ [preview[0]!]: { stdout: content } });
    const result = await dockerfileLintTool.run(session, { path });
    expect(commands).toEqual(preview);
    expect(result.status).toBe('ok');
    expect(result.summary).toMatch(/4 issues/);
    expect(result.findings.map((finding) => finding.subject)).toContain('/srv/app/Dockerfile:1');
    expect(result.tables[0]?.rows.map((row) => row.line)).toEqual([1, 1, 1, 2]);
    expect(result.evidence[0]).toMatchObject({ command: preview[0], exitCode: 0 });
  });

  it('reads over SFTP when the session can, sending no command at all', async () => {
    const readFile = async (requested: string): Promise<string> => {
      expect(requested).toBe(path);
      return content;
    };
    const { session, commands } = fakeSession({}, { readFile });
    const result = await dockerfileLintTool.run(session, { path });
    expect(commands).toEqual([]);
    expect(result.status).toBe('ok');
    expect(result.evidence[0]?.command).toBe('SFTP read /srv/app/Dockerfile');
  });

  it('reports a missing or unreadable file as an error and fabricates no findings', async () => {
    const missing = fakeSession({
      "cat -- '/srv/app/Dockerfile'": { exitCode: 1, stderr: 'cat: /srv/app/Dockerfile: No such file or directory\n' }
    });
    const missingResult = await dockerfileLintTool.run(missing.session, { path });
    expect(missingResult).toMatchObject({ status: 'error', findings: [], tables: [] });
    expect(missingResult.summary).toMatch(/No such file/);

    const denied = fakeSession({
      "cat -- '/srv/app/Dockerfile'": { exitCode: 1, stderr: 'cat: /srv/app/Dockerfile: Permission denied\n' }
    });
    const deniedResult = await dockerfileLintTool.run(denied.session, { path });
    expect(deniedResult.status).toBe('error');
    expect(deniedResult.summary).toMatch(/Permission denied/);
    expect(deniedResult.notes.join(' ')).toMatch(/permission/i);
  });

  it('reports a file that is not a Dockerfile as an error', async () => {
    const { session } = fakeSession({ "cat -- '/srv/app/Dockerfile'": { stdout: 'just some notes\n' } });
    const result = await dockerfileLintTool.run(session, { path });
    expect(result.status).toBe('error');
    expect(result.summary).toMatch(/FROM/);
  });

  it('validates the path before it becomes a command', () => {
    const field = dockerfileLintTool.inputs?.find((input) => input.key === 'path');
    expect(field?.validate?.('-rf /')).toBe('Path must not start with a hyphen');
    expect(field?.validate?.(path)).toBeNull();
  });
});
