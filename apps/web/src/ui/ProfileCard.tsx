import type { JSX } from 'preact';
import { Icon } from '@webssh/ui-kit';
import { PROFILE, visibleProfileLinks } from './profile';

/**
 * Creator card: monogram, name, role and the links that are actually
 * configured. Purely decorative chrome around real data — every value comes
 * from `profile.ts` and no link is invented here.
 */
export function ProfileCard(): JSX.Element {
  const links = visibleProfileLinks();
  return (
    <aside className="webssh-profile" data-testid="profile-card" aria-label="Author">
      <div className="webssh-profile-head">
        <span className="webssh-profile-avatar" aria-hidden="true">
          {PROFILE.monogram}
        </span>
        <div className="webssh-profile-meta">
          <span className="webssh-profile-name" data-testid="profile-name">
            {PROFILE.name}
          </span>
          <span className="webssh-profile-role">{PROFILE.role}</span>
        </div>
      </div>
      <p className="webssh-profile-tagline">{PROFILE.tagline}</p>
      {links.length > 0 ? (
        <div className="webssh-profile-links">
          {links.map((link) => (
            <a
              key={link.id}
              className="webssh-profile-link"
              href={link.href}
              {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              aria-label={link.label}
              title={link.label}
              data-testid={`profile-link-${link.id}`}
            >
              <Icon name={link.icon} />
              <span>{link.label}</span>
            </a>
          ))}
        </div>
      ) : null}
    </aside>
  );
}
