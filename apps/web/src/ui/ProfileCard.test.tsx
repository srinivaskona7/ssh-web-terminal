// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { ProfileCard } from './ProfileCard';
import { PROFILE, visibleProfileLinks, type Profile } from './profile';

function container(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('profile card', () => {
  it('renders the configured name and only the links that have a real target', () => {
    const el = container();
    render(<ProfileCard />, el);

    expect(el.querySelector('[data-testid="profile-name"]')?.textContent).toBe(PROFILE.name);

    const links = [...el.querySelectorAll<HTMLAnchorElement>('.webssh-profile-link')];
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual(['GitHub']);
    expect(links[0]?.getAttribute('href')).toBe('https://github.com/srinivaskona7');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
  });

  it('drops empty, relative and malformed targets instead of rendering a dead button', () => {
    const profile: Profile = {
      ...PROFILE,
      links: [
        { id: 'github', label: 'GitHub', href: 'https://github.com/x', icon: 'github', external: true },
        { id: 'linkedin', label: 'LinkedIn', href: '   ', icon: 'linkedin', external: true },
        { id: 'docs', label: 'Docs', href: '/docs', icon: 'file', external: false },
        { id: 'mail', label: 'Email', href: 'mailto:not-an-address', icon: 'mail', external: false },
        { id: 'mail2', label: 'Email', href: 'mailto:me@example.com', icon: 'mail', external: false }
      ]
    };

    expect(visibleProfileLinks(profile).map((link) => link.id)).toEqual(['github', 'mail2']);
  });
});
