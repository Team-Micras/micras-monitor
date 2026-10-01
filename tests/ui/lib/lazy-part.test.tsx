import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { lazyWithRetry } from '@/ui/lazy/lazy-with-retry';

import { LazyPart } from '@/ui/lib/lazy-part';

function Hello() {
  return <p>Hello</p>;
}

function failingOnce() {
  let calls = 0;
  return lazyWithRetry(() => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error('Failed to fetch dynamically imported module'))
      : Promise.resolve({ default: Hello });
  }).Component;
}

describe('LazyPart', () => {
  test('shows the fallback and reports the error when the code fails to load', async () => {
    const Part = failingOnce();
    const errors: number[] = [];
    const screen = await render(
      <LazyPart fallback={<p>Not loaded</p>} onError={() => errors.push(1)}>
        <Part />
      </LazyPart>
    );
    await expect.element(screen.getByText('Not loaded')).toBeVisible();
    expect(errors).toEqual([1]);
  });

  test('loads the code again when its reset key changes', async () => {
    const Part = failingOnce();
    const screen = await render(
      <LazyPart fallback={<p>Not loaded</p>} resetKey={0}>
        <Part />
      </LazyPart>
    );
    await expect.element(screen.getByText('Not loaded')).toBeVisible();

    await screen.rerender(
      <LazyPart fallback={<p>Not loaded</p>} resetKey={1}>
        <Part />
      </LazyPart>
    );
    await expect.element(screen.getByText('Hello')).toBeVisible();
  });

  test('keeps the fallback while its reset key stays', async () => {
    const Part = failingOnce();
    const screen = await render(
      <LazyPart fallback={<p>Not loaded</p>} resetKey={0}>
        <Part />
      </LazyPart>
    );
    await expect.element(screen.getByText('Not loaded')).toBeVisible();
    await screen.rerender(
      <LazyPart fallback={<p>Not loaded</p>} resetKey={0}>
        <Part />
      </LazyPart>
    );
    await expect.element(screen.getByText('Not loaded')).toBeVisible();
  });

  test('loads the code again on mounting when it asks for it', async () => {
    const Part = failingOnce();
    const first = await render(
      <LazyPart fallback={<p>Not loaded</p>}>
        <Part />
      </LazyPart>
    );
    await expect.element(first.getByText('Not loaded')).toBeVisible();
    await first.unmount();

    const second = await render(
      <LazyPart fallback={<p>Not loaded</p>} retryOnMount>
        <Part />
      </LazyPart>
    );
    await expect.element(second.getByText('Hello')).toBeVisible();
  });
});
