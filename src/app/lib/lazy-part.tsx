import { Component, Suspense, type ReactNode } from 'react';

import { retryFailedLoads } from '@/lazy/lazy-with-retry';

interface LazyPartProps {
  /** What stands in while the code loads, and if it cannot load. */
  readonly fallback: ReactNode;
  /** A change of this value tries a failed load again. */
  readonly resetKey?: unknown;
  readonly children: ReactNode;
}

interface LoadGuardState {
  readonly failed: boolean;
  readonly key: unknown;
}

class LoadGuard extends Component<LazyPartProps, LoadGuardState> {
  override state: LoadGuardState = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromProps(
    props: LazyPartProps,
    state: LoadGuardState
  ): Partial<LoadGuardState> | null {
    if (props.resetKey === state.key) {
      return null;
    }

    if (state.failed) {
      retryFailedLoads();
    }

    return { failed: false, key: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<LoadGuardState> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error('A part of the shell failed to load', error);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Shows a part of the shell whose code loads on demand. While it loads, or if it fails, the
 * fallback stays in its place, so a chunk that does not arrive never takes the app down.
 */
export function LazyPart({ fallback, resetKey, children }: LazyPartProps) {
  return (
    <LoadGuard fallback={fallback} resetKey={resetKey}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </LoadGuard>
  );
}
