/**
 * Shell plumbing shared by the network, security and system DevOps tools.
 *
 * A probe that needs a fallback, a glob or a loop runs as one `sh -c` script,
 * so it behaves the same whether the login shell is bash, dash, zsh or fish,
 * and so `preview()` can list exactly the commands `run()` sends. User values
 * never enter the script text: they are validated, then passed as positional
 * arguments through `posixQuote`.
 */
import { posixQuote } from '../../exec.js';

/** Starts a section in a probe script's output: `@@WEBSSH:<tag> <arg>`. */
export const SECTION_MARK = '@@WEBSSH:';

/**
 * Scripts print file contents with this prefix on every line, so a crafted
 * file cannot forge a section marker. Lines without it are script noise.
 */
export const CONTENT_PREFIX = '|';

/** Search path addition for sbin tools that non-root PATHs often lack. */
export const SBIN_PATH = 'PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"';

/**
 * The login shell parses the quoted script before `sh` sees it. fish reads
 * `\\` and `\'` as escapes even inside single quotes, and csh cannot quote a
 * newline, so a script with any of them would arrive altered.
 */
const LOGIN_SHELL_HAZARD = /\\\\|\\'|\n/;

/** `sh -c '<script>' sh 'arg1' ...` with every argument quoted. */
export function shScript(script: string, args: string[] = []): string {
  if (LOGIN_SHELL_HAZARD.test(script)) {
    throw new Error('Probe scripts must be one line without \\\\ or \\\' so every login shell passes them intact');
  }
  const tail = args.length > 0 ? ` sh ${args.map(posixQuote).join(' ')}` : '';
  return `sh -c ${posixQuote(script)}${tail}`;
}

export interface ScriptSection {
  tag: string;
  arg: string;
  lines: string[];
}

export function splitSections(stdout: string): { preamble: string[]; sections: ScriptSection[] } {
  const preamble: string[] = [];
  const sections: ScriptSection[] = [];
  let current: ScriptSection | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith(SECTION_MARK)) {
      const rest = line.slice(SECTION_MARK.length);
      const space = rest.indexOf(' ');
      current =
        space < 0
          ? { tag: rest.trim(), arg: '', lines: [] }
          : { tag: rest.slice(0, space), arg: rest.slice(space + 1).trim(), lines: [] };
      sections.push(current);
      continue;
    }
    (current ? current.lines : preamble).push(line);
  }
  return { preamble, sections };
}

/** File content lines of a section, prefix removed; script noise is dropped. */
export function contentLines(lines: string[]): string[] {
  return lines.filter((line) => line.startsWith(CONTENT_PREFIX)).map((line) => line.slice(CONTENT_PREFIX.length));
}

export function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}
