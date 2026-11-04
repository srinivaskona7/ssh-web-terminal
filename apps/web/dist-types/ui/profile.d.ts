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
export declare const PROFILE: Profile;
/** Configured links only, in the order declared above. */
export declare function visibleProfileLinks(profile?: Profile): ProfileLink[];
//# sourceMappingURL=profile.d.ts.map