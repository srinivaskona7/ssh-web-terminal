export const PROFILE = {
    name: 'Srinivas Kona',
    role: 'Builder · Platform & Automation',
    tagline: 'WebSSH Studio — a browser SSH workspace with a non-extractable key vault.',
    monogram: 'SK',
    links: [
        {
            id: 'github',
            label: 'GitHub',
            href: 'https://github.com/srinivaskona7',
            icon: 'github',
            external: true
        },
        { id: 'linkedin', label: 'LinkedIn', href: '', icon: 'linkedin', external: true },
        { id: 'mail', label: 'Email', href: '', icon: 'mail', external: false }
    ]
};
/** Configured links only, in the order declared above. */
export function visibleProfileLinks(profile = PROFILE) {
    return profile.links.filter((link) => {
        const href = link.href.trim();
        if (href.length === 0)
            return false;
        if (href.startsWith('mailto:'))
            return /^mailto:[^\s@]+@[^\s@]+$/.test(href);
        return /^https?:\/\/[^\s]+$/.test(href);
    });
}
//# sourceMappingURL=profile.js.map