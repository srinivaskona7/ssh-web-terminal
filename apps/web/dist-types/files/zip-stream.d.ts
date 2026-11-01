export declare function computeCrc32(bytes: Uint8Array, initial?: number): number;
export interface ZipEntryInput {
    relativePath: string;
    data: Uint8Array;
    modTimeUnix?: number;
}
/**
 * Generates a streaming ZIP archive (STORE method, UTF-8 filenames) from remote folder entries.
 */
export declare function buildStreamingZipArchive(entries: ZipEntryInput[]): Uint8Array;
//# sourceMappingURL=zip-stream.d.ts.map