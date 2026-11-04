import type { IconName } from '@webssh/ui-kit';

/**
 * The creator card shown on the Welcome screen. Everything here is data, so
 * changing who the build belongs to never touches component code.
 *
 * Only links with a non-empty `href` are rendered: a placeholder address is
 * worse than a missing button, and nothing here is ever guessed.
 */
export interface ProfileLink {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  external: boolean;
}

export interface Profile {
  name: string;
  role: string;
  tagline: string;
  monogram: string;
  links: ProfileLink[];
}

export const PROFILE: Profile = {
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
export function visibleProfileLinks(profile: Profile = PROFILE): ProfileLink[] {
  return profile.links.filter((link) => {
    const href = link.href.trim();
    if (href.length === 0) return false;
    if (href.startsWith('mailto:')) return /^mailto:[^\s@]+@[^\s@]+$/.test(href);
    return /^https?:\/\/[^\s]+$/.test(href);
  });
}
