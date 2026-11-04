import type { JSX } from 'preact';
import type { WorkspaceRemoteSession } from '../session/adapters';
/**
 * A small workspace editor: browse a project over SFTP, edit files in the
 * browser, auto-save them atomically back to the server, and run commands.
 *
 * It is deliberately not a full IDE: no language servers, no debugger, no
 * extension host. The server only sees ordinary SFTP reads/writes and the
 * commands the user types, so nothing needs installing on the host.
 */
export declare function LightIde({ session, connectedLabel }: {
    session: WorkspaceRemoteSession | null;
    connectedLabel: string;
}): JSX.Element;
//# sourceMappingURL=LightIde.d.ts.map