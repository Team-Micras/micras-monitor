import { Component, Suspense, useState, type ReactNode } from 'react';

import { retryFailedLoads } from './lazy-with-retry';

interface LazyPartProps {
  /** What stands in while the code loads, and if it cannot load. */
  readonly fallback: ReactNode;
  /** A change of this value tries a failed load again. */
  readonly resetKey?: unknown;
  /** Whether a failed load is tried again as soon as this part mounts, such as an opened overlay. */
  readonly retryOnMount?: boolean;
  /** Called when the code fails to load. */
  readonly onError?: () => void;
  /**
   * Mounts the part the first time this is true, such as an overlay opened once, and keeps it
   * mounted from then on; without it the part is mounted at once.
   */
  readonly loadWhen?: boolean;
  readonly children: ReactNode;
}

function useEver(value: boolean): boolean {
  const [ever, setEver] = useState(value);

  if (value && !ever) {
    setEver(true);
  }

  return ever || value;
}

interface LoadGuardState {
  readonly failed: boolean;
}

class LoadGuard extends Component<LazyPartProps, LoadGuardState> {
  override state: LoadGuardState = { failed: false };

  constructor(props: LazyPartProps) {
    super(props);

    if (props.retryOnMount === true) {
      retryFailedLoads();
    }
  }

  static getDerivedStateFromError(): LoadGuardState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error('A part of the shell failed to load', error);
    this.props.onError?.();
  }

  override componentDidUpdate(previous: LazyPartProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      retryFailedLoads();
      this.#recover();
    }
  }

  #recover(): void {
    this.setState({ failed: false });
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Shows a part of the shell whose code loads on demand. While it loads, or if it fails, the
 * fallback stays in its place, so a chunk that does not arrive never takes the app down.
 */
export function LazyPart({
  fallback,
  resetKey,
  retryOnMount,
  onError,
  loadWhen = true,
  children,
}: LazyPartProps) {
  const loaded = useEver(loadWhen);

  if (!loaded) {
    return null;
  }

  return (
    <LoadGuard
      fallback={fallback}
      resetKey={resetKey}
      retryOnMount={retryOnMount}
      onError={onError}
    >
      <Suspense fallback={fallback}>{children}</Suspense>
    </LoadGuard>
  );
}
