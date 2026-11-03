import { posixQuote } from '../recipes/engine.js';
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
/**
 * Quote a directory for `cd`, keeping `~` expandable by the shell. Quoting the
 * whole path would send a literal `~/app`, which does not exist.
 */
export function shellDirectory(dir) {
    if (dir === '~')
        return '"$HOME"';
    if (dir.startsWith('~/'))
        return `"$HOME"/${posixQuote(dir.slice(2))}`;
    return posixQuote(dir);
}
export async function detectProject(session, directory) {
    const dir = directory.trim();
    if (!/^(?:\/|~\/)/.test(dir) || /[\u0000-\u001f]/.test(dir)) {
        throw new Error('Project directory must be an absolute path or start with ~/');
    }
    const checks = MANIFESTS.map((file) => `[ -e ${posixQuote(file)} ] && echo ${posixQuote(file)}`).join('; ');
    const result = await session.exec(`cd ${shellDirectory(dir)} 2>/dev/null && { ${checks}; } || exit 1`, { timeoutMs: 20_000 });
    if (result.exitCode !== 0) {
        throw new Error(`Cannot read project directory ${dir}: ${(result.stderr || result.stdout).trim() || 'not found'}`);
    }
    const manifests = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const has = (file) => manifests.includes(file);
    const project = {
        type: 'unknown',
        directory: dir,
        manifests,
        unitFiles: [],
        notes: []
    };
    if (has('compose.yaml') || has('compose.yml') || has('docker-compose.yml') || has('docker-compose.yaml')) {
        project.type = 'compose';
        const composeFile = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].find(has);
        project.buildCommand = `docker compose -f ${posixQuote(composeFile)} build`;
        project.startCommand = `docker compose -f ${posixQuote(composeFile)} up -d`;
        project.notes.push('Compose deployment restarts the declared services; review port and volume changes first.');
    }
    else if (has('Dockerfile')) {
        project.type = 'docker';
        project.buildCommand = 'docker build -t app:latest .';
        project.notes.push('A container image build and explicit run/restart step is required after building.');
    }
    else if (has('package.json')) {
        project.type = 'node';
        project.packageManager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
        const install = project.packageManager === 'pnpm'
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
    }
    else if (has('pyproject.toml') || has('requirements.txt') || has('Pipfile')) {
        project.type = 'python';
        project.buildCommand = has('requirements.txt')
            ? 'python3 -m pip install -r requirements.txt'
            : 'python3 -m pip install .';
        project.testCommand = 'python3 -m pytest';
        project.notes.push('Create and use a virtual environment rather than installing into the system interpreter.');
    }
    else if (has('go.mod')) {
        project.type = 'go';
        project.buildCommand = 'go build ./...';
        project.testCommand = 'go test ./...';
    }
    else if (has('Cargo.toml')) {
        project.type = 'rust';
        project.buildCommand = 'cargo build --release';
        project.testCommand = 'cargo test';
    }
    else if (has('index.html')) {
        project.type = 'static';
        project.notes.push('Static assets can be served by an existing web server; no build step was detected.');
    }
    if (project.type === 'unknown' && manifests.length === 0) {
        project.notes.push('No recognised project manifest was found in this directory.');
    }
    return project;
}
export function buildDeploymentPlan(project, options) {
    const dir = shellDirectory(project.directory);
    const steps = [];
    const notes = [];
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
    }
    else if (options.buildCommand) {
        steps.push({
            id: 'build',
            title: 'Build',
            command: `cd ${dir} && ${options.buildCommand}`,
            impact: 'files'
        });
    }
    else {
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
    }
    else if (options.serviceName) {
        steps.push({
            id: 'service-restart',
            title: `Restart ${options.serviceName}`,
            command: `sudo -n systemctl restart ${posixQuote(options.serviceName)}`,
            impact: 'service'
        });
        notes.push('Service restart may briefly interrupt traffic.');
    }
    else if (start) {
        steps.push({
            id: 'start',
            title: 'Start the application',
            command: `cd ${dir} && ${start}`,
            impact: 'service',
            allowFailure: false
        });
        notes.push('Starting a process in a deployment step only runs while the job runs; use a service manager for durability.');
    }
    else {
        notes.push('No start command or service was selected, so this deployment only builds the project.');
    }
    const healthCheck = options.healthUrl
        ? {
            url: options.healthUrl,
            command: `code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 ${posixQuote(options.healthUrl)}); ` +
                `echo "health: $code"; case "$code" in 2*) true;; *) false;; esac`
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
//# sourceMappingURL=projects.js.map