import type { ComponentChildren, JSX } from 'preact';
import { THEME_IDS, THEMES, type ThemeId } from './generated/tokens.js';
import { auditThemeContrast } from './contrast.js';
import { Icon } from './icons.js';

export interface ButtonProps {
  children?: ComponentChildren;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  title?: string;
  ariaLabel?: string;
  testId?: string;
  className?: string;
}

export function Button({
  children,
  variant = 'default',
  type = 'button',
  disabled,
  onClick,
  title,
  ariaLabel,
  testId,
  className = ''
}: ButtonProps): JSX.Element {
  const variantClass = variant === 'default' ? '' : `ui-btn--${variant}`;
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      data-testid={testId}
      className={`ui-btn ${variantClass} ${className}`.trim()}
    >
      {children}
    </button>
  );
}

export interface BadgeProps {
  children: ComponentChildren;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
  testId?: string;
}

export function Badge({ children, tone = 'neutral', testId }: BadgeProps): JSX.Element {
  const toneClass = tone === 'neutral' ? '' : `ui-badge--${tone}`;
  return (
    <span data-testid={testId} className={`ui-badge ${toneClass}`.trim()}>
      {children}
    </span>
  );
}

export interface CardProps {
  children: ComponentChildren;
  danger?: boolean;
  className?: string;
  testId?: string;
}

export function Card({ children, danger, className = '', testId }: CardProps): JSX.Element {
  return (
    <section
      data-testid={testId}
      className={`ui-card ${danger ? 'ui-card--danger' : ''} ${className}`.trim()}
    >
      {children}
    </section>
  );
}

export interface ModalProps {
  open: boolean;
  title: string;
  danger?: boolean;
  onClose: () => void;
  children: ComponentChildren;
  testId?: string;
}

export function Modal({ open, title, danger, onClose, children, testId }: ModalProps): JSX.Element | null {
  if (!open) return null;
  return (
    <div className="ui-modal-backdrop" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
      <div className={`ui-modal ${danger ? 'ui-modal--danger' : ''}`.trim()}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
          <h2 style={{ margin: 0, fontSize: 'var(--font-size-lg)' }}>{title}</h2>
          <Button variant="ghost" ariaLabel="Close dialog" onClick={onClose}>
            <Icon name="close" />
          </Button>
        </header>
        <div>{children}</div>
      </div>
    </div>
  );
}

export function Skeleton({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return <div className="ui-skeleton" role="status" aria-label={label} />;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ComponentChildren }): JSX.Element {
  return (
    <div className="ui-empty-state" role="region" aria-label={title}>
      <strong>{title}</strong>
      <span>{description}</span>
      {action ? <div>{action}</div> : null}
    </div>
  );
}

export function ErrorState({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }): JSX.Element {
  return (
    <div className="ui-error-state" role="alert">
      <strong>{title}</strong>
      <span>{message}</span>
      {onRetry ? (
        <Button variant="danger" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function ComponentGallery({ activeTheme, onSelectTheme }: { activeTheme: ThemeId; onSelectTheme: (t: ThemeId) => void }): JSX.Element {
  const audit = auditThemeContrast(THEMES[activeTheme]);
  return (
    <Card testId="component-gallery">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
        <h3 style={{ margin: 0 }}>UI-Kit Design Token Gallery</h3>
        <Badge tone={audit.passesAA ? 'success' : 'danger'}>
          WCAG AA {audit.passesAA ? 'PASS' : 'FAIL'} ({audit.terminalRatio}:1)
        </Badge>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
        {THEME_IDS.map((id) => (
          <Button
            key={id}
            variant={id === activeTheme ? 'primary' : 'default'}
            onClick={() => onSelectTheme(id)}
            testId={`gallery-theme-${id}`}
          >
            {id}
          </Button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <Button variant="primary">Primary Action</Button>
        <Button variant="default">Secondary</Button>
        <Button variant="danger">Danger Override</Button>
        <Badge tone="success">Connected</Badge>
        <Badge tone="warning">Reconnecting</Badge>
        <Badge tone="danger">Host Key Mismatch</Badge>
      </div>
    </Card>
  );
}
