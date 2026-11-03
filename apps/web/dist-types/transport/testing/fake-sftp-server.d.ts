export declare function concat(...arrays: Uint8Array[]): Uint8Array;
export declare function u32(value: number): Uint8Array;
export declare function u64(value: number): Uint8Array;
export declare function str(value: string | Uint8Array): Uint8Array;
export declare function attrs(size: number, mode: number): Uint8Array;
export interface FakeFile {
    data: Uint8Array;
    mode: number;
}
interface HandleEntry {
    kind: 'file' | 'dir';
    path: string;
    isWrite: boolean;
    entries?: string[];
}
export declare class FakeSftpServer {
    files: Map<string, FakeFile>;
    dirs: Set<string>;
    handles: Map<string, HandleEntry>;
    private nextHandle;
    private buffer;
    private sendToClient;
    /** Hook the transport: every SFTP reply is handed to this callback. */
    setSendTarget(fn: (data: Uint8Array) => void): void;
    send: (data: Uint8Array) => void;
    private reply;
    private status;
    private handle;
}
export {};
//# sourceMappingURL=fake-sftp-server.d.ts.map