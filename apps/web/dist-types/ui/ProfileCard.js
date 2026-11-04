import { jsx as _jsx, jsxs as _jsxs } from "preact/jsx-runtime";
import { Icon } from '@webssh/ui-kit';
import { PROFILE, visibleProfileLinks } from './profile';
/**
 * Creator card: monogram, name, role and the links that are actually
 * configured. Purely decorative chrome around real data — every value comes
 * from `profile.ts` and no link is invented here.
 */
export function ProfileCard() {
    const links = visibleProfileLinks();
    return (_jsxs("aside", { className: "webssh-profile", "data-testid": "profile-card", "aria-label": "Author", children: [_jsxs("div", { className: "webssh-profile-head", children: [_jsx("span", { className: "webssh-profile-avatar", "aria-hidden": "true", children: PROFILE.monogram }), _jsxs("div", { className: "webssh-profile-meta", children: [_jsx("span", { className: "webssh-profile-name", "data-testid": "profile-name", children: PROFILE.name }), _jsx("span", { className: "webssh-profile-role", children: PROFILE.role })] })] }), _jsx("p", { className: "webssh-profile-tagline", children: PROFILE.tagline }), links.length > 0 ? (_jsx("div", { className: "webssh-profile-links", children: links.map((link) => (_jsxs("a", { className: "webssh-profile-link", href: link.href, ...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {}), "aria-label": link.label, title: link.label, "data-testid": `profile-link-${link.id}`, children: [_jsx(Icon, { name: link.icon }), _jsx("span", { children: link.label })] }, link.id))) })) : null] }));
}
//# sourceMappingURL=ProfileCard.js.map