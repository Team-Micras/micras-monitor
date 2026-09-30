import {
  Component,
  Suspense,
  useEffect,
  type ContextType,
  type ErrorInfo,
  type ReactNode,
} from 'react';

import { retryFailedLoads } from '@/lazy/lazy-with-retry';

import { Button } from '../components/ui/button';
import { AnnounceContext } from '../shell/announce';

interface WindowErrorBoundaryProps {
  readonly children: ReactNode;
  /** The window's name, for the announcement that it failed. */
  readonly title?: string;
}

interface WindowErrorBoundaryState {
  readonly failed: boolean;
  /** Whether a retry has already failed too. */
  readonly again: boolean;
}

function Loaded({ onLoaded }: { readonly onLoaded: () => void }) {
  useEffect(onLoaded, [onLoaded]);
  return null;
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
  static override contextType = AnnounceContext;
  declare context: ContextType<typeof AnnounceContext>;
  override state: WindowErrorBoundaryState = { failed: false, again: false };
  private retried = false;

  private readonly loaded = () => {
    this.retried = false;
  };

  static getDerivedStateFromError(): Partial<WindowErrorBoundaryState> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('A window failed', error, info.componentStack);
    this.context(`Couldn't load ${this.props.title ?? 'this window'}`);

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
      return (
        <Suspense fallback={null}>
          {this.props.children}
          <Loaded onLoaded={this.loaded} />
        </Suspense>
      );
    }

    return (
      <section
        aria-label="Window failed to load"
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
      </section>
    );
  }
}
