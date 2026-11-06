/**
 * Session double for DevOps tool tests. Replies are keyed by the exact command
 * text, so a tool that sends anything it did not preview fails the test with
 * "unexpected command" instead of receiving a plausible answer.
 */
import type { WorkspaceRemoteSession } from '../../../../session/adapters.js';

export interface FakeReply {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface FakeSession {
  session: WorkspaceRemoteSession;
  /** Every command sent, in order. */
  commands: string[];
  /** The timeout passed with each command. */
  timeouts: Array<number | undefined>;
}

export function fakeSession(replies: Record<string, FakeReply | Error>, user = 'ops'): FakeSession {
  const commands: string[] = [];
  const timeouts: Array<number | undefined> = [];
  const session: WorkspaceRemoteSession = {
    transport: 'go-gateway',
    host: 'server.test',
    user,
    port: 22,
    isConnected: () => true,
    exec: async (command, options) => {
      commands.push(command);
      timeouts.push(options?.timeoutMs);
      if (!Object.prototype.hasOwnProperty.call(replies, command)) {
        throw new Error(`fake session: unexpected command ${command}`);
      }
      const reply = replies[command]!;
      if (reply instanceof Error) throw reply;
      return { stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', exitCode: reply.exitCode ?? 0 };
    }
  };
  return { session, commands, timeouts };
}

/** Only these commands answer; the reply map is built from a tool's preview. */
export function repliesFor(commands: string[], replies: Array<FakeReply | Error>): Record<string, FakeReply | Error> {
  if (commands.length !== replies.length) {
    throw new Error(`fake session: ${commands.length} commands but ${replies.length} replies`);
  }
  const map: Record<string, FakeReply | Error> = {};
  commands.forEach((command, index) => {
    map[command] = replies[index]!;
  });
  return map;
}
