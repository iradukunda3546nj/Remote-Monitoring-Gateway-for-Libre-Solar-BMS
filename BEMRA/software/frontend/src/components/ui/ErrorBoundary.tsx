import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Changing the key (e.g. route path) resets the boundary. */
  resetKey?: string;
}
interface State {
  error: Error | null;
}

/** Contains rendering failures to one workspace instead of blanking the whole control room. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('BEMRA view crashed', error, info.componentStack);
  }

  override componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-box" role="alert">
        <strong>This view failed to render.</strong>
        <code>{this.state.error.message}</code>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
          Retry
        </button>
      </div>
    );
  }
}
