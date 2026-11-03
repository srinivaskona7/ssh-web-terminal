/** Validate a working directory before it is embedded in a command. */
export function validateRemoteDirectory(dir) {
    const cleaned = dir.trim();
    if (!cleaned)
        throw new Error('A working directory is required');
    if (/[\u0000-\u001f]/.test(cleaned))
        throw new Error('Working directory contains control characters');
    if (cleaned.length > 1024)
        throw new Error('Working directory is too long');
    return cleaned;
}
/** Validate a ref/branch/tag name so it can be passed as a single argument. */
export function validateGitRef(ref) {
    const cleaned = ref.trim();
    if (!cleaned)
        throw new Error('A Git reference is required');
    if (/[\s~^:?*[\\\u0000-\u001f]/.test(cleaned) || cleaned.startsWith('-')) {
        throw new Error(`Invalid Git reference "${ref}"`);
    }
    return cleaned;
}
//# sourceMappingURL=remote-session.js.map