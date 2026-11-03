/**
 * Versioned automation templates. Each one builds a POSIX script from
 * reviewed inputs; the UI shows the generated script before anything runs.
 * Destructive templates default to a dry-run mode.
 */
export interface AutomationInput {
    workdir: string;
    target?: string;
    schedule?: string;
    retentionDays?: number;
    url?: string;
    dryRun?: boolean;
}
export interface AutomationTemplate {
    id: string;
    version: string;
    title: string;
    description: string;
    destructive: boolean;
    fields: Array<{
        id: keyof AutomationInput;
        label: string;
        placeholder?: string;
        required: boolean;
        default?: string | number | boolean;
    }>;
    build(input: AutomationInput): string;
}
export declare const AUTOMATION_TEMPLATES: AutomationTemplate[];
export declare function getAutomationTemplate(id: string): AutomationTemplate | undefined;
//# sourceMappingURL=templates.d.ts.map