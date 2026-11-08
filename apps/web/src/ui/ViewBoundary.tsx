import { Component, type ComponentChildren } from 'preact';
import { Button, Card } from '@webssh/ui-kit';
import { repairApplicationAssetCaches } from './ErrorBoundary';

interface Props { name: string; children: ComponentChildren }
interface State { error: Error | null }

/** Per-view error boundary: a failed tool must not take the whole workspace down. */
export class ViewBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(): void {}
  render(): ComponentChildren {
    if (!this.state.error) return this.props.children;
    return (
      <Card testId="view-boundary-card">
        <h2>{this.props.name} failed to load</h2>
        <p role="alert">{String(this.state.error.message || this.state.error).slice(0, 300)}</p>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button variant="primary" onClick={() => this.setState({ error: null })} testId="view-boundary-retry">Retry view</Button>
          <Button variant="default" onClick={() => { void repairApplicationAssetCaches().then(() => window.location.reload()); }} testId="view-boundary-reload">Reload app</Button>
        </div>
      </Card>
    );
  }
}
