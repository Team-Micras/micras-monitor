import { Component, type ErrorInfo, type ReactNode } from 'react';

import { retryFailedLoads } from '@/lazy/lazy-with-retry';

import { Button } from '../components/ui/button';

interface WindowErrorBoundaryProps {
  readonly children: ReactNode;
}

interface WindowErrorBoundaryState {
  readonly failed: boolean;
  /** Whether a retry has already failed too. */
  readonly again: boolean;
}

/**
 * Keeps a window whose code failed to load, or whose view threw, from taking the app down: the
 * window says so and offers a retry, which imports the code again, while the frame, the other
 * windows and every STOP control keep working.
 */
export class WindowErrorBoundary extends Component<
  WindowErrorBoundaryProps,
  WindowErrorBoundaryState
> {
  override state: WindowErrorBoundaryState = { failed: false, again: false };
  private retried = false;

  static getDerivedStateFromError(): Partial<WindowErrorBoundaryState> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('A window failed', error, info.componentStack);

    if (this.retried) {
      this.setState({ again: true });
    }
  }

  private readonly retry = () => {
    retryFailedLoads();
    this.retried = true;
    this.setState({ failed: false, again: false });
  };

  override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }

    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-muted-foreground"
      >
        <p>Couldn&apos;t load this window</p>
        {this.state.again ? (
          <p className="max-w-xs text-xs">
            Some browsers keep a failed load until the page reloads.
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={this.retry}>
            Retry
          </Button>
          {this.state.again ? (
            <Button variant="outline" size="sm" onClick={() => location.reload()}>
              Reload
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
}
