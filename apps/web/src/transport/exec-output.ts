/** Most text a streamed command keeps for its resolved result; callbacks still see everything. */
export const MAX_RETAINED_EXEC_OUTPUT = 4 * 1024 * 1024;

/** Decodes one output stream across chunk boundaries so split UTF-8 sequences arrive whole. */
export class ExecOutputSink {
  private readonly decoder = new TextDecoder();
  private kept = '';

  constructor(
    private readonly onText?: (text: string) => void,
    private readonly retain = true
  ) {}

  push(bytes: Uint8Array): void {
    this.emit(this.decoder.decode(bytes, { stream: true }));
  }

  /** Flush any trailing partial sequence and return the retained text. */
  finish(): string {
    this.emit(this.decoder.decode());
    return this.kept;
  }

  private emit(text: string): void {
    if (!text) return;
    this.onText?.(text);
    if (this.retain && this.kept.length < MAX_RETAINED_EXEC_OUTPUT) {
      this.kept += text.slice(0, MAX_RETAINED_EXEC_OUTPUT - this.kept.length);
    }
  }
}

export function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}
