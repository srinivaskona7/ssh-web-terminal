import type { RemoteSession } from '../session/remote-session.js';
/**
 * Python automation center: interpreter discovery, virtual environments,
 * reviewed execution, and cron scheduling.
 *
 * Generated scripts are always shown before they are scheduled, and scheduled
 * entries carry a marker comment so they can be listed and removed precisely.
 */
export declare const CRON_MARKER_PREFIX = "# webssh-job:";
export interface PythonEnvironment {
    version: string;
    path: string;
    venvAvailable: boolean;
    pipAvailable: boolean;
}
export interface CronEntry {
    id: string;
    schedule: string;
    command: string;
    comment?: string;
    raw: string;
    managed: boolean;
}
export declare function validateScriptPath(path: string): string;
export declare function validateVenvPath(path: string): string;
export declare function buildArgvLine(argv: string[]): string;
/** Validate a five-field cron expression. */
export declare function validateCronSchedule(schedule: string): string;
export declare function parseCrontab(text: string): CronEntry[];
export declare function addCronEntry(current: string, entry: {
    id: string;
    schedule: string;
    command: string;
    comment?: string;
}): string;
export declare function removeCronEntry(current: string, id: string): string;
/** Build the shell script a detached automation job runs. */
export declare function buildAutomationScript(input: {
    workdir: string;
    interpreter: string;
    script: string;
    args?: string[];
    env?: Record<string, string>;
}): string;
export declare class PythonAutomation {
    private readonly session;
    constructor(session: RemoteSession);
    detect(): Promise<PythonEnvironment | null>;
    createVenv(path: string): Promise<string>;
    installRequirements(venvPath: string, workdir: string, file?: string): Promise<string>;
    readCrontab(): Promise<CronEntry[]>;
    private writeCrontab;
    schedule(entry: {
        id: string;
        schedule: string;
        command: string;
        comment?: string;
    }): Promise<void>;
    unschedule(id: string): Promise<void>;
}
//# sourceMappingURL=python-automation.d.ts.map