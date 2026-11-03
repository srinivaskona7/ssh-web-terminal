import { posixQuote } from '../recipes/engine.js';
import type { RemoteSession } from '../session/remote-session.js';

/**
 * Project detection, build and deployment planning.
 *
 * Detection is read-only. Dependency installation and build commands are
 * always presented for review; nothing runs merely because a folder was
 * opened.
 */

export type ProjectType =
  | 'node'
  | 'python'
  | 'go'
  | 'rust'
  | 'static'
  | 'docker'
  | 'compose'
  | 'unknown';

export interface DetectedProject {
  type: ProjectType;
  directory: string;
  manifests: string[];
  packageManager?: 'npm' | 'yarn' | 'pnpm';
  buildCommand?: string;
  testCommand?: string;
  startCommand?: string;
  unitFiles: string[];
  notes: string[];
}

const MANIFESTS = [
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'index.html',
  'nginx.conf'
];

export async function detectProject(
  session: RemoteSession,
  directory: string
): Promise<DetectedProject> {
  const dir = directory.trim();
  if (!/^(?:\/|~\/)/.test(dir) || /[\u0000-\u001f]/.test(dir)) {
    throw new Error('Project directory must be an absolute path or start with ~/');
  }
  const checks = MANIFESTS.map((file) => `[ -e ${posixQuote(file)} ] && echo ${posixQuote(file)}`).join('; ');
  const result = await session.exec(
    `cd ${posixQuote(dir)} 2>/dev/null && { ${checks}; } || exit 1`,
    { timeoutMs: 20_000 }
  );
  if (result.exitCode !== 0) {
    throw new Error(`Cannot read project directory ${dir}: ${(result.stderr || result.stdout).trim() || 'not found'}`);
  }
  const manifests = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const has = (file: string): boolean => manifests.includes(file);
  const project: DetectedProject = {
    type: 'unknown',
    directory: dir,
    manifests,
    unitFiles: [],
    notes: []
  };

  if (has('compose.yaml') || has('compose.yml') || has('docker-compose.yml') || has('docker-compose.yaml')) {
    project.type = 'compose';
    const composeFile = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].find(has)!;
    project.buildCommand = `docker compose -f ${posixQuote(composeFile)} build`;
    project.startCommand = `docker compose -f ${posixQuote(composeFile)} up -d`;
    project.notes.push('Compose deployment restarts the declared services; review port and volume changes first.');
  } else if (has('Dockerfile')) {
    project.type = 'docker';
    project.buildCommand = 'docker build -t app:latest .';
    project.notes.push('A container image build and explicit run/restart step is required after building.');
  } else if (has('package.json')) {
    project.type = 'node';
    project.packageManager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    const install =
      project.packageManager === 'pnpm'
        ? 'pnpm install --frozen-lockfile'
        : project.packageManager === 'yarn'
          ? 'yarn install --frozen-lockfile'
          : has('package-lock.json')
            ? 'npm ci'
            : 'npm install';
    project.buildCommand = `${install} && ${project.packageManager} run build`;
    project.testCommand = `${project.packageManager} test`;
    project.startCommand = `${project.packageManager} start`;
    project.unitFiles.push('systemd unit or process manager entry required for a persistent service');
  } else if (has('pyproject.toml') || has('requirements.txt') || has('Pipfile')) {
    project.type = 'python';
    project.buildCommand = has('requirements.txt')
      ? 'python3 -m pip install -r requirements.txt'
      : 'python3 -m pip install .';
    project.testCommand = 'python3 -m pytest';
    project.notes.push('Create and use a virtual environment rather than installing into the system interpreter.');
  } else if (has('go.mod')) {
    project.type = 'go';
    project.buildCommand = 'go build ./...';
    project.testCommand = 'go test ./...';
  } else if (has('Cargo.toml')) {
    project.type = 'rust';
    project.buildCommand = 'cargo build --release';
    project.testCommand = 'cargo test';
  } else if (has('index.html')) {
    project.type = 'static';
    project.notes.push('Static assets can be served by an existing web server; no build step was detected.');
  }

  if (project.type === 'unknown' && manifests.length === 0) {
    project.notes.push('No recognised project manifest was found in this directory.');
  }
  return project;
}

export interface DeploymentStep {
  id: string;
  title: string;
  /** POSIX command. Values are already quoted by the planner. */
  command: string;
  /** Human explanation of what this step changes. */
  impact: 'none' | 'files' | 'service' | 'container' | 'network';
  allowFailure?: boolean;
}

export interface DeploymentPlan {
  project: DetectedProject;
  revisionCommand: string;
  steps: DeploymentStep[];
  healthCheck?: { url: string; command: string };
  rollback: 'supported' | 'limited' | 'none';
  notes: string[];
}

export interface DeploymentOptions {
  installDependencies: boolean;
  buildCommand?: string;
  startCommand?: string;
  serviceName?: string;
  healthUrl?: string;
  composeFile?: string;
}

export function buildDeploymentPlan(
  project: DetectedProject,
  options: DeploymentOptions
): DeploymentPlan {
  const dir = posixQuote(project.directory);
  const steps: DeploymentStep[] = [];
  const notes: string[] = [];

  steps.push({
    id: 'revision',
    title: 'Record source revision',
    command: `cd ${dir} && { git rev-parse HEAD 2>/dev/null || echo "no-git"; }`,
    impact: 'none'
  });

  if (options.installDependencies && project.buildCommand) {
    steps.push({
      id: 'dependencies',
      title: 'Install dependencies and build',
      command: `cd ${dir} && ${options.buildCommand ?? project.buildCommand}`,
      impact: 'files'
    });
  } else if (options.buildCommand) {
    steps.push({
      id: 'build',
      title: 'Build',
      command: `cd ${dir} && ${options.buildCommand}`,
      impact: 'files'
    });
  } else {
    notes.push('No build step will run. Enable dependency installation or provide a build command if the project needs one.');
  }

  const start = options.startCommand ?? project.startCommand;
  if (options.composeFile) {
    steps.push({
      id: 'compose-deploy',
      title: 'Apply Compose deployment',
      command: `cd ${dir} && docker compose -f ${posixQuote(options.composeFile)} up -d --remove-orphans`,
      impact: 'container'
    });
    notes.push('Compose does not provide application-level rollback; reverting requires the previous image tags/config.');
  } else if (options.serviceName) {
    steps.push({
      id: 'service-restart',
      title: `Restart ${options.serviceName}`,
      command: `sudo -n systemctl restart ${posixQuote(options.serviceName)}`,
      impact: 'service'
    });
    notes.push('Service restart may briefly interrupt traffic.');
  } else if (start) {
    steps.push({
      id: 'start',
      title: 'Start the application',
      command: `cd ${dir} && ${start}`,
      impact: 'service',
      allowFailure: false
    });
    notes.push('Starting a process in a deployment step only runs while the job runs; use a service manager for durability.');
  } else {
    notes.push('No start command or service was selected, so this deployment only builds the project.');
  }

  const healthCheck = options.healthUrl
    ? {
        url: options.healthUrl,
        command:
          `code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 ${posixQuote(options.healthUrl)}); ` +
          `echo "health: $code"; case "$code" in 2*) exit 0;; *) exit 1;; esac`
      }
    : undefined;

  return {
    project,
    revisionCommand: `cd ${dir} && { git rev-parse HEAD 2>/dev/null || echo "no-git"; }`,
    steps,
    healthCheck,
    rollback: project.type === 'compose' || project.type === 'docker' ? 'limited' : 'none',
    notes
  };
}
