import { Component, Suspense, type ReactNode } from 'react';
import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import {
  lazyWithRetry,
  type LazyWithRetry,
  prefetchAll,
  retryFailedLoads,
} from '@/lazy/lazy-with-retry';

function Hello({ name }: { readonly name: string }) {
  return <p>Hello {name}</p>;
}

class Catch extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <p>failed</p> : this.props.children;
  }
}

function attempt(lazy: LazyWithRetry<typeof Hello>) {
  return render(
    <Catch>
      <Suspense fallback={null}>
        <lazy.Component name="Micras" />
      </Suspense>
    </Catch>
  );
}

function loader(failures: number) {
  const calls = { count: 0 };
  const load = () => {
    calls.count += 1;
    return calls.count <= failures
      ? Promise.reject(new Error('Failed to fetch dynamically imported module'))
      : Promise.resolve({ default: Hello });
  };
  return { calls, load };
}

describe('lazyWithRetry', () => {
  test('keeps a loaded component when a retry is asked for', async () => {
    const { calls, load } = loader(0);
    const lazy = lazyWithRetry(load);
    const screen = await render(
      <Suspense fallback={null}>
        <lazy.Component name="Micras" />
      </Suspense>
    );
    await expect.element(screen.getByText('Hello Micras')).toBeVisible();
    retryFailedLoads();
    expect(calls.count).toBe(1);
  });

  test('prefetches every declared component and swallows a failure', async () => {
    const good = loader(0);
    const bad = loader(1);
    lazyWithRetry(good.load);
    lazyWithRetry(bad.load);
    const before = { good: good.calls.count, bad: bad.calls.count };
    await expect(prefetchAll()).resolves.toBeUndefined();
    expect(good.calls.count).toBe(before.good + 1);
    expect(bad.calls.count).toBe(before.bad + 1);
  });

  test('imports the code again after a failed load only once a retry asks for it', async () => {
    const { calls, load } = loader(1);
    const lazy = lazyWithRetry(load);
    const first = await attempt(lazy);
    await expect.poll(() => lazy.failed()).toBe(true);
    await first.unmount();
    expect(calls.count).toBe(1);

    const withoutRetry = await attempt(lazy);
    await expect.poll(() => calls.count).toBe(1);
    await withoutRetry.unmount();

    retryFailedLoads();
    expect(lazy.failed()).toBe(false);
    const second = await attempt(lazy);
    await expect.element(second.getByText('Hello Micras')).toBeVisible();
    expect(calls.count).toBe(2);
    await second.unmount();
  });
});
