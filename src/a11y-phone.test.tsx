import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/robot-kit';
import { micras } from '@robots/micras';

import { App } from '@/app/app';
import { createDemoRobot } from '@/app/fake/demo-robot';
import type { FakeRobot } from '@/app/fake/fake-robot';
import { createShellStore } from '@/app/state/shell-store';
import type { Theme } from '@/app/state/theme';
import '@/app/styles.css';
import { seriousViolations } from './axe-check';

const robots: FakeRobot[] = [];

beforeEach(async () => {
  await page.viewport(390, 844);
});

afterEach(async () => {
  robots.splice(0).forEach((robot) => robot.disconnect());
  await page.viewport(1440, 900);
});

async function open(theme: Theme) {
  const robot = createDemoRobot({ connectMs: 5, handshakeMs: 10, configureMs: 5, commandMs: 5 });
  robots.push(robot);
  const screen = await render(
    <App
      ports={robot.ports}
      robots={new RobotRegistry([micras])}
      store={createShellStore({ theme })}
      synthetic
    />
  );
  robot.connect({ transport: 'websocket', url: 'ws://robot' });
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
