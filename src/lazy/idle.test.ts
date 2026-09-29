import { afterEach, describe, expect, test, vi } from 'vitest';

import { IDLE_TIMEOUT_MS, importWhenIdle, whenIdle } from './idle';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('whenIdle', () => {
  test('lets the browser postpone the task no longer than the timeout', () => {
    const request = vi.fn<(task: () => void, options?: { timeout?: number }) => number>(() => 1);
    vi.stubGlobal('requestIdleCallback', request);
    whenIdle(() => undefined);

    expect(request).toHaveBeenCalledWith(expect.any(Function), {
      timeout: IDLE_TIMEOUT_MS,
    });
  });
});

describe('importWhenIdle', () => {
  test('hands the module over, or tells that the import failed', async () => {
    vi.stubGlobal('requestIdleCallback', (task: () => void) => {
      task();
      return 1;
    });
    const use = vi.fn<(module: number) => void>();
    const onError = vi.fn<(error: unknown) => void>();
    const failure = new Error('chunk gone');
    importWhenIdle(() => Promise.resolve(7), use, onError);
    importWhenIdle(() => Promise.reject(failure), use, onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));

    expect(use).toHaveBeenCalledExactlyOnceWith(7);
  });
});
