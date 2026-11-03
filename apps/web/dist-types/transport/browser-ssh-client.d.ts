import type { ControlMessage } from '@webssh/protocol';
import type { ConnectedSessionMetadata, LiveConnectParams } from './transport.js';
import { SftpClient } from './sftp-client.js';
export interface RelaySessionLoginResult {
    token: string;
    userId: string;
    expiresAt: number;
    expiresIn: number;
}
export declare function loginToCloudflareRelay(relayWsUrl: string, username: string, password: string): Promise<RelaySessionLoginResult>;
export declare const RELAY_RING_BUFFER_MAX_BYTES: number;
export declare class BrowserSshRelaySessionClient {
    private readonly params;
    private ws;
    private connected;
    private metadata;
    private rawBuffer;
    private bannerParsed;
    private serverVersion;
    private clientKexInitPayload;
    private serverKexInitPayload;
    private ecdhKeyPair;
    private clientEcdhPubRaw;
    private sessionId;
    private seqIn;
    private seqOut;
    private encryptedIn;
    private encryptedOut;
    private encKeyOut;
    private encKeyIn;
    private macKeyOut;
    private macKeyIn;
    private ivOut;
    private ivIn;
    private recvProcessing;
    private sendChain;
    private connectResolve;
    private connectReject;
    private nextLocalChannel;
    private channels;
    private pendingChannelOpen;
    private pendingChannelRequests;
    private opCounter;
    private ptySeq;
    private ringBuffer;
    private ringBufferBytes;
    private activeTunnels;
    constructor(params: LiveConnectParams);
    get isConnected(): boolean;
    get sessionMetadata(): ConnectedSessionMetadata | null;
    private buildRelayWsUrl;
    connect(): Promise<ConnectedSessionMetadata>;
    private probeRelayRejectionReason;
    private failConnect;
    private processInboundBytes;
    private tryReadPacket;
    private sendPacket;
    private sendClientKexInit;
    private verifyHostKeySignature;
    private deriveSshKey;
    private handlePacket;
    private sendUserauthRequest;
    private openRawSessionChannel;
<<<<<<< HEAD
    private requestChannelAcknowledgement;
=======
    /**
     * Send a channel request and wait for the server's CHANNEL_SUCCESS /
     * CHANNEL_FAILURE. Terminal readiness must never be reported before this
     * resolves — that was the root cause of "connected" terminals that never
     * received a shell prompt.
     */
    private sendChannelRequest;
    /** Wait until the peer's flow-control window admits `size` bytes. */
    private waitForWindow;
    private sendChannelData;
>>>>>>> 257250a (feat(web): add workspace modules, live server control and honest capability matrix)
    private openInteractivePtyChannel;
    /**
     * Open the `sftp` subsystem and speak real SFTP v3 over it. Returns a
     * cached client per channel; a session may open several.
     */
    private openSftpChannel;
    private sftpPromise;
    /** Lazily opened, shared SFTP client for this session. */
    getSftpClient(): Promise<SftpClient>;
    sendPtyText(channel: number, text: string): boolean;
    sendPtyBytes(channel: number, bytes: Uint8Array): boolean;
    resizeChannel(channel: number, cols: number, rows: number): void;
    openChannel(cols: number, rows: number): Promise<Extract<ControlMessage, {
        type: 'channel_opened';
    }>>;
    closeChannel(channel: number): void;
    execCommand(command: string, timeoutMs?: number): Promise<Extract<ControlMessage, {
        type: 'exec_result';
    }>>;
    /**
     * Execute a command and stream stdout/stderr as it arrives. Used by
     * discovery, installation jobs and build logs so the UI shows real
     * progress instead of waiting for a buffered blob.
     */
    execStream(command: string, options?: {
        onStdout?: (chunk: string) => void;
        onStderr?: (chunk: string) => void;
        timeoutMs?: number;
        /** Stop callback: return true to abort the remote command. */
        signal?: AbortSignal;
    }): Promise<Extract<ControlMessage, {
        type: 'exec_result';
    }>>;
    private appendToRingBuffer;
    getReplayFramesAfter(lastSeq: number): Array<{
        seq: number;
        channel: number;
        data: Uint8Array;
    }>;
    reconnectAndResume(lastSeq?: number): Promise<ConnectedSessionMetadata>;
    private openDirectTcpipChannel;
    /**
     * Send an HTTP/1.1 request through a real `direct-tcpip` channel and read the
     * response until the server closes. This is genuine remote-port reachability
     * — it does not bind a local socket, because a browser page cannot listen on
     * a localhost port.
     */
    private httpRequestOverTunnel;
    /** Reject-and-report helper: never return a fabricated success. */
    private sftpFailure;
    private uploadSessions;
    sftpOp(req: Omit<Extract<ControlMessage, {
        type: 'sftp_op';
    }>, 'type' | 'opId'>): Promise<Extract<ControlMessage, {
        type: 'sftp_result';
    }>>;
    tunnelOp(req: Omit<Extract<ControlMessage, {
        type: 'tunnel_op';
    }>, 'type' | 'opId'>): Promise<Extract<ControlMessage, {
        type: 'tunnel_result';
    }>>;
    close(): void;
}
//# sourceMappingURL=browser-ssh-client.d.ts.map