import { useEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';

interface Props {
  value: string;
  language?: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
}

/**
 * Lazy-loaded Monaco editor for desktop. Falls back to a plain textarea on
 * mobile or when Monaco cannot initialise (GitHub Pages worker issues).
 */
export function MonacoEditor({ value, language = 'plaintext', onChange, readOnly }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<unknown>(null);

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const monaco = await import('monaco-editor');
        if (disposed || !hostRef.current) return;
        const editor = monaco.editor.create(hostRef.current, {
          value,
          language,
          readOnly: Boolean(readOnly),
          automaticLayout: true,
          theme: 'vs-dark'
        });
        editorRef.current = editor;
        editor.onDidChangeModelContent(() => {
          if (onChange) onChange(editor.getValue());
        });
      } catch {
        // Monaco unavailable (e.g. web workers blocked); render nothing extra
        // so the parent falls back to the textarea editor.
      }
    })();
    return () => {
      disposed = true;
      try {
        (editorRef.current as { dispose?: () => void } | null)?.dispose?.();
      } catch {
        // ignore
      }
    };
  }, []);

  return <div ref={hostRef} style={{ width: '100%', height: '100%', minHeight: '240px' }} data-testid="monaco-editor" />;
}
