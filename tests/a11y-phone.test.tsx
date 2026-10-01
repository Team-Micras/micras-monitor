import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/core/robot';
import { micras } from '@/robots/micras';

import { App } from '@/ui/app';
import type { AppMonitor } from '@/ui/monitor-context';
import { createShellStore } from '@/ui/state/shell-store';
import type { Theme } from '@/ui/state/theme';
import '@/ui/styles.css';
import { seriousViolations } from '@tests/support/axe-check';
import { DEMO_TARGET, demoMonitor } from '@tests/support/sources/demo-monitor';

const monitors: AppMonitor[] = [];

beforeEach(async () => {
  await page.viewport(390, 844);
});

afterEach(async () => {
  monitors.splice(0).forEach((monitor) => monitor.disconnect());
  await page.viewport(1440, 900);
});

async function open(theme: Theme) {
  const monitor = demoMonitor();
  monitors.push(monitor);
  const screen = await render(
    <App
      monitor={monitor}
      robots={new RobotRegistry([micras])}
      store={createShellStore({ theme })}
      synthetic
    />
  );
  monitor.connect(DEMO_TARGET);
  await expect.element(screen.getByRole('region', { name: 'Status' })).toBeVisible();
  await expect.poll(() => document.querySelector('[data-battery]')?.textContent).toMatch(/^12\./);
  return screen;
}

describe('the phone view', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`in the ${theme} theme has no serious violation`, async () => {
      await open(theme);
      expect(await seriousViolations()).toEqual([]);
    });
  }

  test('has landmarks for its parts and one announcer for STOP', async () => {
    const screen = await open('dark');
    await expect.element(screen.getByRole('region', { name: 'Values' })).toBeVisible();
    expect(document.querySelectorAll('[data-announcer]')).toHaveLength(2);
    await screen.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect
      .poll(() => document.querySelector('[data-announcer="assertive"]')?.textContent)
      .toBe('Stop accepted');
  });
});
