export const DEFAULT_RECORDING_CAP_BYTES = 64 * 1024 * 1024; // 64 MiB
export const HARD_MAX_RECORDING_CAP_BYTES = 256 * 1024 * 1024; // 256 MiB
const NL = String.fromCharCode(10);
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/**
 * Fuzzy-scores a query against a target string. Returns -1 if not all characters appear in order.
 */
export function fuzzyScore(query, target) {
    const q = query.trim().toLowerCase();
    if (!q)
        return 1;
    const t = target.toLowerCase();
    let qIdx = 0;
    let score = 0;
    let consecutive = 0;
    for (let i = 0; i < t.length && qIdx < q.length; i++) {
        if (t[i] === q[qIdx]) {
            qIdx++;
            consecutive++;
            score += 10 + consecutive * 5 - i * 0.1;
        }
        else {
            consecutive = 0;
        }
    }
    return qIdx === q.length ? score : -1;
}
export class CommandPaletteRegistry {
    commands = new Map();
    register(item) {
        this.commands.set(item.id, item);
    }
    search(query) {
        const items = Array.from(this.commands.values());
        if (!query.trim()) {
            return items;
        }
        const scored = items
            .map((item) => {
            const haystack = [item.title, item.category, ...(item.keywords ?? [])].join(' ');
            return { item, score: fuzzyScore(query, haystack) };
        })
            .filter((x) => x.score >= 0)
            .sort((a, b) => b.score - a.score);
        return scored.map((s) => s.item);
    }
    execute(id) {
        const cmd = this.commands.get(id);
        if (!cmd) {
            throw new Error(`Command not found: ${id}`);
        }
        return cmd.run();
    }
}
export function extractSnippetVariables(template) {
    const vars = new Set();
    const re = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
    let match;
    while ((match = re.exec(template)) !== null) {
        if (match[1]) {
            vars.add(match[1]);
        }
    }
    return Array.from(vars);
}
export function interpolateSnippet(template, values) {
    return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
        return Object.prototype.hasOwnProperty.call(values, key) ? (values[key] ?? '') : `{{${key}}}`;
    });
}
export class SnippetLibrary {
    snippets = new Map();
    constructor(initial = []) {
        for (const s of initial) {
            this.snippets.set(s.id, s);
        }
    }
    upsert(snippet) {
        this.snippets.set(snippet.id, snippet);
        return snippet;
    }
    remove(id) {
        return this.snippets.delete(id);
    }
    list(query = '') {
        const q = query.trim().toLowerCase();
        return Array.from(this.snippets.values()).filter((s) => {
            if (!q)
                return true;
            return (s.name.toLowerCase().includes(q) ||
                s.command.toLowerCase().includes(q) ||
                s.tags.some((t) => t.toLowerCase().includes(q)));
        });
    }
}
export class BroadcastManager {
    enabled = false;
    targetPaneIds = new Set();
    setEnabled(enabled) {
        this.enabled = enabled;
    }
    isEnabled() {
        return this.enabled;
    }
    toggleTargetPane(paneId) {
        if (this.targetPaneIds.has(paneId)) {
            this.targetPaneIds.delete(paneId);
            return false;
        }
        this.targetPaneIds.add(paneId);
        return true;
    }
    getTargets() {
        return Array.from(this.targetPaneIds);
    }
    dispatchInput(input, writer) {
        if (!this.enabled)
            return 0;
        let count = 0;
        for (const paneId of this.targetPaneIds) {
            writer(paneId, input);
            count++;
        }
        return count;
    }
}
export class AsciicastRecorder {
    header;
    events = [];
    startTimeMs;
    maxBytes;
    currentBytes = 0;
    capped = false;
    constructor(width, height, title = 'WebSSH Session', maxBytes = DEFAULT_RECORDING_CAP_BYTES, startTimeMs = Date.now()) {
        this.startTimeMs = startTimeMs;
        this.maxBytes = Math.min(Math.max(1024, maxBytes), HARD_MAX_RECORDING_CAP_BYTES);
        this.header = {
            version: 2,
            width,
            height,
            timestamp: Math.floor(this.startTimeMs / 1000),
            title
        };
    }
    recordOutput(data, nowMs = Date.now()) {
        return this.appendEvent('o', data, nowMs);
    }
    recordInput(data, nowMs = Date.now()) {
        return this.appendEvent('i', data, nowMs);
    }
    appendEvent(kind, data, nowMs) {
        const elapsedSec = Number(Math.max(0, (nowMs - this.startTimeMs) / 1000).toFixed(4));
        const eventTuple = [elapsedSec, kind, data];
        const serialized = JSON.stringify(eventTuple) + NL;
        const byteLen = new TextEncoder().encode(serialized).byteLength;
        if (this.currentBytes + byteLen > this.maxBytes) {
            this.capped = true;
            return false;
        }
        this.currentBytes += byteLen;
        this.events.push(eventTuple);
        return true;
    }
    isCapped() {
        return this.capped;
    }
    getByteLength() {
        return this.currentBytes;
    }
    exportCast() {
        const lines = [JSON.stringify(this.header), ...this.events.map((e) => JSON.stringify(e))];
        return lines.join(NL) + NL;
    }
}
export function parseAsciicastV2(castText) {
    const lines = castText
        .split(NL)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    if (lines.length === 0) {
        throw new Error('Empty asciicast v2 recording');
    }
    const header = JSON.parse(lines[0]);
    if (header.version !== 2) {
        throw new Error(`Unsupported asciicast version: ${String(header.version)}`);
    }
    const events = [];
    for (let i = 1; i < lines.length; i++) {
        const parsed = JSON.parse(lines[i]);
        events.push(parsed);
    }
    const durationSec = events.length > 0 ? (events[events.length - 1]?.[0] ?? 0) : 0;
    return { header, events, durationSec };
}
export function scrubAsciicastOutput(events, targetTimeSec) {
    let out = '';
    for (const [ts, kind, text] of events) {
        if (ts > targetTimeSec)
            break;
        if (kind === 'o') {
            out += text;
        }
    }
    return out;
}
export function normalizeShortcut(shortcut) {
    return shortcut
        .trim()
        .toLowerCase()
        .split('+')
        .map((s) => s.trim())
        .sort()
        .join('+');
}
export class KeybindingRegistry {
    bindings = new Map();
    constructor(defaults = []) {
        for (const d of defaults) {
            this.bindings.set(d.actionId, d);
        }
    }
    rebind(actionId, newShortcut, description = actionId) {
        const existing = this.bindings.get(actionId);
        this.bindings.set(actionId, {
            actionId,
            description: existing?.description ?? description,
            shortcut: newShortcut
        });
        return this.detectConflicts();
    }
    detectConflicts() {
        const byShortcut = new Map();
        for (const b of this.bindings.values()) {
            const norm = normalizeShortcut(b.shortcut);
            const list = byShortcut.get(norm) ?? [];
            list.push(b.actionId);
            byShortcut.set(norm, list);
        }
        const conflicts = [];
        for (const [shortcut, actionIds] of byShortcut.entries()) {
            if (actionIds.length > 1) {
                conflicts.push({ shortcut, actionIds });
            }
        }
        return conflicts;
    }
    list() {
        return Array.from(this.bindings.values());
    }
}
/**
 * Inspects PTY output stream for OSC 133 command completion (`\x1b]133;D;<exitCode>\x07`) or bell (`\x07`).
 */
export function detectCommandCompletion(ptyChunk) {
    const osc133Prefix = `${ESC}]133;D`;
    const idx = ptyChunk.indexOf(osc133Prefix);
    if (idx >= 0) {
        const after = ptyChunk.slice(idx + osc133Prefix.length);
        const codeMatch = after.match(/^;([0-9]+)/);
        const exitCode = codeMatch && codeMatch[1] ? Number.parseInt(codeMatch[1], 10) : 0;
        return {
            exitCode,
            reason: 'osc133',
            timestamp: Date.now()
        };
    }
    if (ptyChunk.includes(BEL)) {
        return {
            exitCode: 0,
            reason: 'bell',
            timestamp: Date.now()
        };
    }
    return null;
}
export const SPECIAL_KEYS_ROW = ['Esc', 'Tab', 'Ctrl', 'Alt', 'Up', 'Down', 'Left', 'Right'];
export function translateSpecialKey(key) {
    switch (key) {
        case 'Esc':
            return ESC;
        case 'Tab':
            return String.fromCharCode(9);
        case 'Up':
            return `${ESC}[A`;
        case 'Down':
            return `${ESC}[B`;
        case 'Right':
            return `${ESC}[C`;
        case 'Left':
            return `${ESC}[D`;
        default:
            return '';
    }
}
//# sourceMappingURL=productivity.js.map