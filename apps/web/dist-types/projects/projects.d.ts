import type { RemoteSession } from '../session/remote-session.js';
/**
 * Project detection, build and deployment planning.
 *
 * Detection is read-only. Dependency installation and build commands are
 * always presented for review; nothing runs merely because a folder was
 * opened.
 */
export type ProjectType = 'node' | 'python' | 'go' | 'rust' | 'static' | 'docker' | 'compose' | 'unknown';
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
/**
 * Quote a directory for `cd`, keeping `~` expandable by the shell. Quoting the
 * whole path would send a literal `~/app`, which does not exist.
 */
export declare function shellDirectory(dir: string): string;
export declare function detectProject(session: RemoteSession, directory: string): Promise<DetectedProject>;
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
    healthCheck?: {
        url: string;
        command: string;
    };
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
export declare function buildDeploymentPlan(project: DetectedProject, options: DeploymentOptions): DeploymentPlan;
//# sourceMappingURL=projects.d.ts.map