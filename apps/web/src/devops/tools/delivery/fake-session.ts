/**
 * Scripted stand-in for `WorkspaceRemoteSession` in DevOps tool tests.
 *
 * Each command is answered from a table keyed by its exact text, so a tool that
 * sends anything other than what its preview promised fails loudly instead of
 * receiving a plausible default.
 */
import type { WorkspaceRemoteSession } from '../../../session/adapters.js';
import type { RemoteExecOptions, RemoteExecResult } from '../../../session/remote-session.js';

export type FakeReply =
  | Partial<RemoteExecResult>
  | Error
  | ((options: RemoteExecOptions) => Partial<RemoteExecResult> | Promise<Partial<RemoteExecResult>>);

export interface FakeSession {
  session: WorkspaceRemoteSession;
  /** Every command sent, in order. */
  commands: string[];
  options: RemoteExecOptions[];
}

export function fakeSession(
  replies: Record<string, FakeReply>,
  extra: Partial<WorkspaceRemoteSession> = {}
): FakeSession {
  const commands: string[] = [];
  const options: RemoteExecOptions[] = [];
  const session: WorkspaceRemoteSession = {
    transport: 'go-gateway',
    host: 'web-1.example.test',
    user: 'ops',
    port: 22,
    isConnected: () => true,
    exec: async (command, execOptions = {}) => {
      commands.push(command);
      options.push(execOptions);
      if (!Object.prototype.hasOwnProperty.call(replies, command)) {
        throw new Error(`fake session: unexpected command ${JSON.stringify(command)}`);
      }
      const reply = replies[command]!;
      if (reply instanceof Error) throw reply;
      const answer = typeof reply === 'function' ? await reply(execOptions) : reply;
      return { stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', exitCode: answer.exitCode ?? 0 };
    },
    ...extra
  };
  return { session, commands, options };
}

/** What a POSIX shell answers when the binary is not installed. */
export function notInstalled(binary: string): Partial<RemoteExecResult> {
  return { exitCode: 127, stderr: `bash: line 1: ${binary}: command not found\n` };
}
