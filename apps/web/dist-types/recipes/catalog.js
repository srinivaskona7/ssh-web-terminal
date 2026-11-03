/**
 * Software catalog. Every entry installs from the distribution's maintained
 * package repositories — no `curl | sh`. Entries that need an external
 * repository are marked `requiresConfiguration` and explain what is missing
 * instead of pretending one click will work.
 */
const verifyCommand = (id, title, argv) => ({
    id,
    title,
    kind: 'exec',
    argv,
    allowFailure: false,
    timeoutMs: 30_000
});
function installStep(id, title, spec) {
    const stepsByManager = {};
    const build = (manager, args) => [
        { id: `${id}-update-index`, title: 'Refresh package index', kind: 'exec', argv: [manager, manager === 'apt-get' ? 'update' : 'makecache'], asRoot: true, allowFailure: true, timeoutMs: 5 * 60_000 },
        { id, title, kind: 'exec', argv: args, asRoot: true, timeoutMs: 15 * 60_000 }
    ];
    if (spec.apt)
        stepsByManager['apt-get'] = build('apt-get', ['apt-get', 'install', '-y', '--no-install-recommends', ...spec.apt]);
    if (spec.dnf)
        stepsByManager['dnf'] = build('dnf', ['dnf', 'install', '-y', ...spec.dnf]);
    if (spec.yum)
        stepsByManager['yum'] = build('yum', ['yum', 'install', '-y', ...spec.yum]);
    if (spec.apk)
        stepsByManager['apk'] = build('apk', ['apk', 'add', '--no-cache', ...spec.apk]);
    if (spec.pacman)
        stepsByManager['pacman'] = [
            { id: `${id}-sync`, title: 'Sync package databases', kind: 'exec', argv: ['pacman', '-Sy', '--noconfirm'], asRoot: true, allowFailure: true, timeoutMs: 5 * 60_000 },
            { id, title, kind: 'exec', argv: ['pacman', '-S', '--noconfirm', '--needed', ...spec.pacman], asRoot: true, timeoutMs: 15 * 60_000 }
        ];
    if (spec.zypper)
        stepsByManager['zypper'] = build('zypper', ['zypper', '--non-interactive', 'install', ...spec.zypper]);
    return { stepsByManager };
}
function removeStep(id, title, spec) {
    const byTool = (_manager, args) => [
        { id: `${id}-remove`, title, kind: 'exec', argv: args, asRoot: true, timeoutMs: 10 * 60_000 }
    ];
    const ordered = [];
    if (spec.apt)
        ordered.push(...byTool('apt-get', ['apt-get', 'remove', '-y', ...spec.apt]));
    else if (spec.dnf)
        ordered.push(...byTool('dnf', ['dnf', 'remove', '-y', ...spec.dnf]));
    else if (spec.yum)
        ordered.push(...byTool('yum', ['yum', 'remove', '-y', ...spec.yum]));
    else if (spec.apk)
        ordered.push(...byTool('apk', ['apk', 'del', ...spec.apk]));
    else if (spec.pacman)
        ordered.push(...byTool('pacman', ['pacman', '-R', '--noconfirm', ...spec.pacman]));
    else if (spec.zypper)
        ordered.push(...byTool('zypper', ['zypper', '--non-interactive', 'remove', ...spec.zypper]));
    return { remove: ordered };
}
function baseRecipe(recipe) {
    return { fields: [], ...recipe };
}
const PKG = {
    git: { apt: ['git'], dnf: ['git'], yum: ['git'], apk: ['git'], pacman: ['git'], zypper: ['git'] },
    python: { apt: ['python3', 'python3-venv', 'python3-pip'], dnf: ['python3', 'python3-pip'], yum: ['python3', 'python3-pip'], apk: ['python3', 'py3-pip'], pacman: ['python', 'python-pip'], zypper: ['python3', 'python3-pip'] },
    node: { apt: ['nodejs'], dnf: ['nodejs', 'npm'], yum: ['nodejs', 'npm'], apk: ['nodejs', 'npm'], pacman: ['nodejs', 'npm'], zypper: ['nodejs', 'npm'] },
    build: { apt: ['build-essential', 'gcc', 'make'], dnf: ['gcc', 'make'], yum: ['gcc', 'make'], apk: ['build-base'], pacman: ['base-devel'], zypper: ['gcc', 'make'] },
    go: { apt: ['golang-go'], dnf: ['golang'], yum: ['golang'], apk: ['go'], pacman: ['go'], zypper: ['go'] },
    rust: { apt: ['rustc', 'cargo'], dnf: ['rust', 'cargo'], yum: ['rust', 'cargo'], apk: ['rust', 'cargo'], pacman: ['rust'], zypper: ['rust', 'cargo'] },
    java: { apt: ['openjdk-17-jdk-headless'], dnf: ['java-17-openjdk-headless'], yum: ['java-17-openjdk-headless'], apk: ['openjdk17'], pacman: ['jdk17-openjdk'], zypper: ['java-17-openjdk'] },
    php: { apt: ['php-cli'], dnf: ['php-cli'], yum: ['php-cli'], apk: ['php83'], pacman: ['php'], zypper: ['php'] },
    ruby: { apt: ['ruby'], dnf: ['ruby'], yum: ['ruby'], apk: ['ruby'], pacman: ['ruby'], zypper: ['ruby'] },
    docker: { apt: ['docker.io'], dnf: ['docker'], yum: ['docker'], apk: ['docker'], pacman: ['docker'], zypper: ['docker'] },
    compose: { apt: ['docker-compose-v2'], dnf: ['docker-compose-plugin'], yum: ['docker-compose-plugin'], apk: ['docker-cli-compose'], pacman: ['docker-compose'], zypper: ['docker-compose'] },
    ansible: { apt: ['ansible-core'], dnf: ['ansible-core'], yum: ['ansible'], apk: ['ansible'], pacman: ['ansible'], zypper: ['ansible'] },
    nginx: { apt: ['nginx'], dnf: ['nginx'], yum: ['nginx'], apk: ['nginx'], pacman: ['nginx'], zypper: ['nginx'] },
    postgres: { apt: ['postgresql'], dnf: ['postgresql-server'], yum: ['postgresql-server'], apk: ['postgresql'], pacman: ['postgresql'], zypper: ['postgresql-server'] },
    redis: { apt: ['redis-server'], dnf: ['redis'], yum: ['redis'], apk: ['redis'], pacman: ['redis'], zypper: ['redis'] },
    htop: { apt: ['htop'], dnf: ['htop'], yum: ['htop'], apk: ['htop'], pacman: ['htop'], zypper: ['htop'] },
    jq: { apt: ['jq'], dnf: ['jq'], yum: ['jq'], apk: ['jq'], pacman: ['jq'], zypper: ['jq'] },
    tmux: { apt: ['tmux'], dnf: ['tmux'], yum: ['tmux'], apk: ['tmux'], pacman: ['tmux'], zypper: ['tmux'] },
    curl: { apt: ['curl'], dnf: ['curl'], yum: ['curl'], apk: ['curl'], pacman: ['curl'], zypper: ['curl'] },
    wget: { apt: ['wget'], dnf: ['wget'], yum: ['wget'], apk: ['wget'], pacman: ['wget'], zypper: ['wget'] },
    sqlite: { apt: ['sqlite3'], dnf: ['sqlite'], yum: ['sqlite'], apk: ['sqlite'], pacman: ['sqlite'], zypper: ['sqlite3'] },
    postgresClient: { apt: ['postgresql-client'], dnf: ['postgresql'], yum: ['postgresql'], apk: ['postgresql-client'], pacman: ['postgresql'], zypper: ['postgresql'] },
    redisClient: { apt: ['redis-tools'], dnf: ['redis'], yum: ['redis'], apk: ['redis'], pacman: ['redis'], zypper: ['redis'] }
};
const CATALOG = [
    baseRecipe({
        id: 'git',
        version: '1.0.0',
        name: 'Git',
        category: 'development',
        description: 'Distributed version control. Required for repository, build and deployment workflows.',
        documentationUrl: 'https://git-scm.com/doc',
        license: 'GPL-2.0',
        versionInstalled: '2.40',
        support: { minDiskMiB: 50 },
        privileges: 'sudo',
        ...installStep('git-install', 'Install Git', PKG.git),
        verify: [verifyCommand('git-verify', 'Verify Git', ['git', '--version'])],
        ...removeStep('git', 'Remove Git', PKG.git),
        rollback: 'supported'
    }),
    baseRecipe({
        id: 'python3',
        version: '1.0.0',
        name: 'Python 3 + pip + venv',
        category: 'development',
        description: 'Python interpreter with virtual environment and package tooling for automation and app hosting.',
        documentationUrl: 'https://docs.python.org/3/',
        license: 'PSF-2.0',
        versionInstalled: '3.11',
        support: { minDiskMiB: 150 },
        privileges: 'sudo',
        ...installStep('python-install', 'Install Python 3 tooling', PKG.python),
        verify: [
            verifyCommand('python-verify', 'Verify Python', ['python3', '--version']),
            verifyCommand('venv-verify', 'Verify venv module', ['python3', '-m', 'venv', '--help'])
        ],
        provides: { files: ['/usr/bin/python3'] },
        ...removeStep('python', 'Remove Python 3 packages', PKG.python),
        rollback: 'limited'
    }),
    baseRecipe({
        id: 'node',
        version: '1.0.0',
        name: 'Node.js',
        category: 'development',
        description: 'Node.js runtime from distribution packages. Distribution versions can lag upstream; the installed version is reported after install.',
        documentationUrl: 'https://nodejs.org/en/docs',
        license: 'MIT',
        versionInstalled: '20.0',
        support: { minDiskMiB: 200 },
        privileges: 'sudo',
        ...installStep('node-install', 'Install Node.js', PKG.node),
        verify: [
            verifyCommand('node-verify', 'Verify Node.js', ['node', '--version']),
            verifyCommand('npm-verify', 'Verify npm', ['npm', '--version'])
        ],
        ...removeStep('node', 'Remove Node.js packages', PKG.node),
        rollback: 'limited'
    }),
    baseRecipe({
        id: 'make',
        version: '1.0.0',
        name: 'Build toolchain (GCC + make)',
        category: 'build',
        description: 'C/C++ compiler and GNU make for native builds and Python/Node native modules.',
        documentationUrl: 'https://gcc.gnu.org/',
        license: 'GPL-3.0',
        versionInstalled: '11.0',
        support: { minDiskMiB: 300 },
        privileges: 'sudo',
        ...installStep('build-install', 'Install build toolchain', PKG.build),
        verify: [
            verifyCommand('gcc-verify', 'Verify GCC', ['gcc', '--version']),
            verifyCommand('make-verify', 'Verify make', ['make', '--version'])
        ],
        ...removeStep('build', 'Remove build toolchain', PKG.build),
        rollback: 'limited'
    }),
    baseRecipe({
        id: 'go',
        version: '1.0.0',
        name: 'Go',
        category: 'development',
        description: 'Go toolchain from distribution packages.',
        documentationUrl: 'https://go.dev/doc/',
        license: 'BSD-3-Clause',
        versionInstalled: '1.22',
        support: { minDiskMiB: 400 },
        privileges: 'sudo',
        ...installStep('go-install', 'Install Go', PKG.go),
        verify: [verifyCommand('go-verify', 'Verify Go', ['go', 'version'])],
        ...removeStep('go', 'Remove Go', PKG.go),
        rollback: 'limited'
    }),
    baseRecipe({
        id: 'rustc',
        version: '1.0.0',
        name: 'Rust toolchain',
        category: 'development',
        description: 'rustc and cargo from distribution packages.',
        documentationUrl: 'https://www.rust-lang.org/tools/install',
        license: 'MIT OR Apache-2.0',
        versionInstalled: '1.75',
        support: { minDiskMiB: 500 },
        privileges: 'sudo',
        ...installStep('rust-install', 'Install Rust toolchain', PKG.rust),
        verify: [
            verifyCommand('rustc-verify', 'Verify rustc', ['rustc', '--version']),
            verifyCommand('cargo-verify', 'Verify cargo', ['cargo', '--version'])
        ],
        ...removeStep('rust', 'Remove Rust packages', PKG.rust),
        rollback: 'limited'
    }),
    baseRecipe({
        id: 'java',
        version: '1.0.0',
        name: 'OpenJDK 17',
        category: 'development',
        description: 'Headless JDK 17 for JVM applications and build tools.',
        documentationUrl: 'https://openjdk.org/',
        license: 'GPL-2.0 WITH Classpath-exception-2.0',
        versionInstalled: '17.0',
        support: { minDiskMiB: 300 },
        privileges: 'sudo',
        ...installStep('java-install', 'Install OpenJDK 17', PKG.java),
        verify: [verifyCommand('java-verify', 'Verify Java', ['java', '-version'])],
        ...removeStep('java', 'Remove OpenJDK packages', PKG.java),
        rollback: 'limited'
    }),
    baseRecipe({
        id: 'php',
        version: '1.0.0',
        name: 'PHP CLI',
        category: 'development',
        description: 'PHP command-line runtime from distribution packages.',
        documentationUrl: 'https://www.php.net/docs.php',
        license: 'PHP-3.01',
        versionInstalled: '8.2',
        support: { minDiskMiB: 150 },
        privileges: 'sudo',
        ...installStep('php-install', 'Install PHP CLI', PKG.php),
        verify: [verifyCommand('php-verify', 'Verify PHP', ['php', '--version'])],
        ...removeStep('php', 'Remove PHP', PKG.php),
        rollback: 'limited'
    }),
    baseRecipe({
        id: 'ruby',
        version: '1.0.0',
        name: 'Ruby',
        category: 'development',
        description: 'Ruby runtime from distribution packages.',
        documentationUrl: 'https://www.ruby-lang.org/en/documentation/',
        license: 'Ruby',
        versionInstalled: '3.1',
        support: { minDiskMiB: 150 },
        privileges: 'sudo',
        ...installStep('ruby-install', 'Install Ruby', PKG.ruby),
        verify: [verifyCommand('ruby-verify', 'Verify Ruby', ['ruby', '--version'])],
        ...removeStep('ruby', 'Remove Ruby', PKG.ruby),
        rollback: 'limited'
    }),
    baseRecipe({
        id: 'docker',
        version: '1.0.0',
        name: 'Docker Engine',
        category: 'containers',
        description: 'Docker Engine from distribution packages. The daemon socket is never exposed through this workspace; container actions use the SSH user’s own permissions.',
        documentationUrl: 'https://docs.docker.com/engine/',
        license: 'Apache-2.0',
        versionInstalled: '24.0',
        support: { minRamMiB: 512, minDiskMiB: 1000 },
        privileges: 'sudo',
        ...installStep('docker-install', 'Install Docker Engine', PKG.docker),
        steps: [
            {
                id: 'docker-enable',
                title: 'Enable and start Docker',
                kind: 'exec',
                argv: ['systemctl', 'enable', '--now', 'docker'],
                asRoot: true,
                allowFailure: true
            },
            {
                id: 'docker-group',
                title: 'Show daemon status',
                kind: 'exec',
                argv: ['systemctl', 'is-active', 'docker'],
                asRoot: false,
                allowFailure: true
            }
        ],
        verify: [verifyCommand('docker-verify', 'Verify Docker CLI', ['docker', '--version'])],
        provides: { services: ['docker'], ports: [] },
        rebootRequired: false,
        ...removeStep('docker', 'Remove Docker Engine', PKG.docker),
        conflicts: ['podman'],
        rollback: 'limited'
    }),
    baseRecipe({
        id: 'docker-compose',
        version: '1.0.0',
        name: 'Docker Compose v2',
        category: 'containers',
        description: 'The `docker compose` plugin (v2) from distribution packages.',
        documentationUrl: 'https://docs.docker.com/compose/',
        license: 'Apache-2.0',
        versionInstalled: '2.20',
        support: { minDiskMiB: 100 },
        privileges: 'sudo',
        ...installStep('compose-install', 'Install Compose plugin', PKG.compose),
        verify: [verifyCommand('compose-verify', 'Verify Compose', ['docker', 'compose', 'version'])],
        conflicts: ['docker-compose'],
        ...removeStep('compose', 'Remove Compose plugin', PKG.compose),
        rollback: 'supported'
    }),
    baseRecipe({
        id: 'ansible',
        version: '1.0.0',
        name: 'Ansible',
        category: 'automation',
        description: 'Ansible automation engine from distribution packages.',
        documentationUrl: 'https://docs.ansible.com/',
        license: 'GPL-3.0',
        versionInstalled: '2.15',
        support: { minRamMiB: 512, minDiskMiB: 200 },
        privileges: 'sudo',
        ...installStep('ansible-install', 'Install Ansible', PKG.ansible),
        verify: [verifyCommand('ansible-verify', 'Verify Ansible', ['ansible', '--version'])],
        ...removeStep('ansible', 'Remove Ansible', PKG.ansible),
        rollback: 'limited'
    }),
    baseRecipe({
        id: 'nginx',
        version: '1.0.0',
        name: 'NGINX',
        category: 'services',
        description: 'Reverse proxy and web server. Configuration is not modified automatically.',
        documentationUrl: 'https://nginx.org/en/docs/',
        license: 'BSD-2-Clause',
        versionInstalled: '1.24',
        support: { minRamMiB: 256, minDiskMiB: 100 },
        privileges: 'sudo',
        ...installStep('nginx-install', 'Install NGINX', PKG.nginx),
        steps: [
            { id: 'nginx-enable', title: 'Enable and start NGINX', kind: 'exec', argv: ['systemctl', 'enable', '--now', 'nginx'], asRoot: true, allowFailure: true },
            { id: 'nginx-test', title: 'Validate configuration', kind: 'exec', argv: ['nginx', '-t'], asRoot: true, allowFailure: true }
        ],
        verify: [verifyCommand('nginx-verify', 'Verify NGINX', ['nginx', '-v'])],
        provides: { services: ['nginx'], ports: [80, 443], files: ['/etc/nginx/nginx.conf'] },
        ...removeStep('nginx', 'Remove NGINX', PKG.nginx),
        rollback: 'supported'
    }),
    baseRecipe({
        id: 'psql',
        version: '1.0.0',
        name: 'PostgreSQL server + client',
        category: 'data',
        description: 'PostgreSQL from distribution packages. This does not open network access or create databases; both require an explicit reviewed action.',
        documentationUrl: 'https://www.postgresql.org/docs/',
        license: 'PostgreSQL',
        versionInstalled: '15.0',
        support: { minRamMiB: 512, minDiskMiB: 500 },
        privileges: 'sudo',
        ...installStep('postgres-install', 'Install PostgreSQL', PKG.postgres),
        steps: [
            { id: 'postgres-init', title: 'Ensure the data directory is initialized', kind: 'exec', argv: ['postgresql-setup', '--initdb'], asRoot: true, allowFailure: true },
            { id: 'postgres-enable', title: 'Enable and start PostgreSQL', kind: 'exec', argv: ['systemctl', 'enable', '--now', 'postgresql'], asRoot: true, allowFailure: true }
        ],
        verify: [verifyCommand('psql-verify', 'Verify psql', ['psql', '--version'])],
        provides: { services: ['postgresql'], ports: [5432], persistentData: ['/var/lib/postgresql'] },
        ...removeStep('postgres', 'Remove PostgreSQL packages', PKG.postgres),
        rollback: 'limited'
    }),
    baseRecipe({
        id: 'redis-cli',
        version: '1.0.0',
        name: 'Redis server + client',
        category: 'data',
        description: 'Redis from distribution packages. No network exposure or configuration changes are made.',
        documentationUrl: 'https://redis.io/docs/',
        license: 'BSD-3-Clause',
        versionInstalled: '7.0',
        support: { minRamMiB: 256, minDiskMiB: 100 },
        privileges: 'sudo',
        ...installStep('redis-install', 'Install Redis', PKG.redis),
        steps: [
            { id: 'redis-enable', title: 'Enable and start Redis', kind: 'exec', argv: ['systemctl', 'enable', '--now', 'redis-server'], asRoot: true, allowFailure: true }
        ],
        verify: [verifyCommand('redis-verify', 'Verify redis-cli', ['redis-cli', '--version'])],
        provides: { services: ['redis-server'], ports: [6379], persistentData: ['/var/lib/redis'] },
        ...removeStep('redis', 'Remove Redis packages', PKG.redis),
        rollback: 'limited'
    }),
    baseRecipe({
        id: 'htop',
        version: '1.0.0',
        name: 'htop',
        category: 'observability',
        description: 'Interactive process and resource monitor.',
        documentationUrl: 'https://htop.dev/',
        license: 'GPL-2.0',
        versionInstalled: '3.0',
        support: {},
        privileges: 'sudo',
        ...installStep('htop-install', 'Install htop', PKG.htop),
        verify: [verifyCommand('htop-verify', 'Verify htop', ['htop', '--version'])],
        ...removeStep('htop', 'Remove htop', PKG.htop),
        rollback: 'supported'
    }),
    baseRecipe({
        id: 'jq',
        version: '1.0.0',
        name: 'jq',
        category: 'observability',
        description: 'Command-line JSON processor, used by many operational scripts.',
        documentationUrl: 'https://jqlang.github.io/jq/',
        license: 'MIT',
        versionInstalled: '1.6',
        support: {},
        privileges: 'sudo',
        ...installStep('jq-install', 'Install jq', PKG.jq),
        verify: [verifyCommand('jq-verify', 'Verify jq', ['jq', '--version'])],
        ...removeStep('jq', 'Remove jq', PKG.jq),
        rollback: 'supported'
    }),
    baseRecipe({
        id: 'tmux',
        version: '1.0.0',
        name: 'tmux',
        category: 'terminal',
        description: 'Terminal multiplexer for persistent remote sessions.',
        documentationUrl: 'https://github.com/tmux/tmux/wiki',
        license: 'ISC',
        versionInstalled: '3.2',
        support: {},
        privileges: 'sudo',
        ...installStep('tmux-install', 'Install tmux', PKG.tmux),
        verify: [verifyCommand('tmux-verify', 'Verify tmux', ['tmux', '-V'])],
        ...removeStep('tmux', 'Remove tmux', PKG.tmux),
        rollback: 'supported'
    }),
    baseRecipe({
        id: 'sqlite3',
        version: '1.0.0',
        name: 'SQLite',
        category: 'data',
        description: 'SQLite command-line shell and library.',
        documentationUrl: 'https://sqlite.org/docs.html',
        license: 'Public Domain',
        versionInstalled: '3.40',
        support: {},
        privileges: 'sudo',
        ...installStep('sqlite-install', 'Install SQLite', PKG.sqlite),
        verify: [verifyCommand('sqlite-verify', 'Verify SQLite', ['sqlite3', '--version'])],
        ...removeStep('sqlite', 'Remove SQLite', PKG.sqlite),
        rollback: 'supported'
    }),
    baseRecipe({
        id: 'kubectl',
        version: '1.0.0',
        name: 'kubectl',
        category: 'kubernetes',
        description: 'Kubernetes CLI. Distribution packages lag upstream and some distributions provide no package at all; this recipe is shown for planning and will not fabricate an install path.',
        documentationUrl: 'https://kubernetes.io/docs/tasks/tools/',
        license: 'Apache-2.0',
        versionInstalled: '1.30',
        support: {},
        privileges: 'sudo',
        requiresConfiguration: true,
        steps: [],
        verify: [verifyCommand('kubectl-verify', 'Verify kubectl', ['kubectl', 'version', '--client'])],
        rollback: 'none'
    }),
    baseRecipe({
        id: 'helm',
        version: '1.0.0',
        name: 'Helm',
        category: 'kubernetes',
        description: 'Helm package manager for Kubernetes. Requires a configured Helm repository or a distribution package; the workspace will not download and execute installer scripts.',
        documentationUrl: 'https://helm.sh/docs/',
        license: 'Apache-2.0',
        versionInstalled: '3.14',
        support: {},
        privileges: 'sudo',
        requiresConfiguration: true,
        steps: [],
        verify: [verifyCommand('helm-verify', 'Verify Helm', ['helm', 'version'])],
        rollback: 'none'
    }),
    baseRecipe({
        id: 'terraform',
        version: '1.0.0',
        name: 'Terraform',
        category: 'automation',
        description: 'Infrastructure-as-code CLI. Official distribution requires HashiCorp’s repository; this entry is plan-only until that repository is configured.',
        documentationUrl: 'https://developer.hashicorp.com/terraform/docs',
        license: 'BUSL-1.1',
        versionInstalled: '1.8',
        support: {},
        privileges: 'sudo',
        requiresConfiguration: true,
        steps: [],
        verify: [verifyCommand('terraform-verify', 'Verify Terraform', ['terraform', 'version'])],
        rollback: 'none'
    }),
    baseRecipe({
        id: 'k3s',
        version: '1.0.0',
        name: 'k3s (local Kubernetes)',
        category: 'kubernetes',
        description: 'Lightweight Kubernetes. The upstream installer is a downloadable shell script, so this workspace does not run it automatically. Cluster installation also needs resource, networking and workload review.',
        documentationUrl: 'https://docs.k3s.io/',
        license: 'Apache-2.0',
        versionInstalled: '1.29',
        support: { minRamMiB: 2048, minDiskMiB: 5000 },
        privileges: 'sudo',
        requiresConfiguration: true,
        steps: [],
        verify: [verifyCommand('k3s-verify', 'Verify k3s', ['k3s', '--version'])],
        rollback: 'none'
    })
];
export function listRecipes() {
    return CATALOG.slice();
}
export function getRecipe(id) {
    return CATALOG.find((r) => r.id === id);
}
export function searchRecipes(query, category) {
    const q = query.trim().toLowerCase();
    return CATALOG.filter((recipe) => {
        if (category && category !== 'all' && recipe.category !== category)
            return false;
        if (!q)
            return true;
        return (recipe.name.toLowerCase().includes(q) ||
            recipe.description.toLowerCase().includes(q) ||
            recipe.id.toLowerCase().includes(q) ||
            recipe.category.toLowerCase().includes(q));
    });
}
//# sourceMappingURL=catalog.js.map