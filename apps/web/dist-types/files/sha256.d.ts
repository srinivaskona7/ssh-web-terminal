/**
 * Streaming incremental SHA-256 hasher for chunked SFTP transfers without loading entire files into memory.
 */
export declare class IncrementalSha256 {
    private h0;
    private h1;
    private h2;
    private h3;
    private h4;
    private h5;
    private h6;
    private h7;
    private readonly block;
    private blockLen;
    private totalBytes;
    private readonly w;
    update(chunk: Uint8Array): this;
    private compressBlock;
    digestHex(): string;
}
export declare function sha256Hex(bytes: Uint8Array): Promise<string>;
//# sourceMappingURL=sha256.d.ts.map