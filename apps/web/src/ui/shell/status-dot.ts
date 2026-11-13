import type { ConnectionState } from '../App';

/** Status dot modifier for a connection state. Green is reserved for a live session. */
export function statusDotClassFor(state: ConnectionState): string {
  switch (state) {
    case 'connected':
    case 'resumed':
      return '';
    case 'connecting':
    case 'reconnecting':
      return 'webssh-status-dot--reconnecting';
    case 'offline':
      return 'webssh-status-dot--offline';
    default:
      return 'webssh-status-dot--disconnected';
  }
}
