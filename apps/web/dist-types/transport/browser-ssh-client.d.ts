import type { ControlMessage } from '@webssh/protocol';
import type { ConnectedSessionMetadata, LiveConnectParams } from './transport.js';
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
    private uploadBuffers;
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
    private requestChannelAcknowledgement;
    private openInteractivePtyChannel;
    sendPtyText(channel: number, text: string): boolean;
    sendPtyBytes(channel: number, bytes: Uint8Array): boolean;
    resizeChannel(channel: number, cols: number, rows: number): void;
    openChannel(cols: number, rows: number): Promise<Extract<ControlMessage, {
        type: 'channel_opened';
    }>>;
    closeChannel(channel: number): void;
    execCommand(command: string): Promise<Extract<ControlMessage, {
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