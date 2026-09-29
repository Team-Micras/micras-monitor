/**
 * Follow an exploration of Micras in the simulation through the monitor itself, headless, and
 * check what slice 8 promises: the maze updates by its revision, the state and its transitions
 * are right, STOP brakes the robot to IDLE, and SAVE outside IDLE is refused with its reason.
 *
 * ```
 * bun tools/check-micras-sim.ts --robot ws://127.0.0.1:8080 [--screens <dir>] [--minutes 25]
 * ```
 *
 * It serves the app with Vite, opens it at `?connect=<robot>` in Chromium and drives it with the
 * mouse and the keyboard, as a person would: Explore from IDLE (or follow an exploration already
 * running), Save during the run, wait for the search to end in IDLE, Explore again and press
 * Space. With `--screens` it saves the maze window during and after the search, dark and light.
 * It exits non-zero when a check fails. It is a manual check, not part of CI.
 *
 * @module
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';

const { values: args } = parseArgs({
  options: {
    robot: { type: 'string', default: 'ws://127.0.0.1:8080' },
    screens: { type: 'string' },
    minutes: { type: 'string', default: '25' },
    headed: { type: 'boolean', default: false },
  },
});

const deadline = Date.now() + Number(args.minutes) * 60_000;

interface Snapshot {
  readonly atMs: number;
  readonly state: string;
  readonly walls: number | null;
  readonly explored: number | null;
  readonly robotCell: string | null;
  readonly logStates: readonly string[];
  readonly timeline: readonly string[];
}

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const checks: Check[] = [];
const snapshots: Snapshot[] = [];
const started = Date.now();

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

function note(name: string, detail: string): void {
  console.log(`NOTE  ${name}: ${detail}`);
}

function elapsed(): string {
  return `${((Date.now() - started) / 1000).toFixed(1)} s`;
}

const LOGGED_STATE = /state ([A-Z_]+)$/;

function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

async function attribute(page: Page, selector: string, name: string): Promise<string | null> {
  const element = page.locator(selector);
  return (await element.count()) === 0 ? null : element.first().getAttribute(name);
}

async function snapshot(page: Page): Promise<Snapshot> {
  const maze = '[data-window="maze"] [data-maze]';
  const state = page.locator('[data-robot-state]');
  const logLines = await page.locator('ol[aria-label="Log"] li').allTextContents();
  return {
    atMs: Date.now() - started,
    state: (await state.count()) === 0 ? '' : ((await state.first().textContent()) ?? ''),
    walls: numberOrNull(await attribute(page, maze, 'data-walls')),
    explored: numberOrNull(await attribute(page, maze, 'data-explored')),
    robotCell: await attribute(page, maze, 'data-robot-cell'),
    logStates: logLines.flatMap((line) => LOGGED_STATE.exec(line.trim())?.[1] ?? []),
    timeline: await page
      .locator('ol[aria-label="State transitions"] li span.truncate')
      .allTextContents(),
  };
}

async function follow(page: Page, until: (latest: Snapshot) => boolean, what: string) {
  for (;;) {
    const latest = await snapshot(page);
    const previous = snapshots.at(-1);

    if (
      previous === undefined ||
      previous.state !== latest.state ||
      previous.explored !== latest.explored ||
      previous.walls !== latest.walls ||
      previous.logStates.length !== latest.logStates.length
    ) {
      snapshots.push(latest);
      console.log(
        `  ${elapsed()}  ${latest.state.padEnd(20)} maze ${latest.walls ?? '-'} walls, ${latest.explored ?? '-'} explored, robot ${latest.robotCell ?? '-'}`
      );
    }

    if (until(latest)) {
      return latest;
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }

    await page.waitForTimeout(100);
  }
}

async function screenshot(page: Page, name: string): Promise<void> {
  if (args.screens === undefined) {
    return;
  }

  const toggle = page.getByRole('button', { name: /Use the (light|dark) theme/ });

  for (const theme of ['dark', 'light'] as const) {
    if (
      ((await page.locator('html').getAttribute('class')) ?? '').split(' ').includes('dark') !==
      (theme === 'dark')
    ) {
      await toggle.click();
      await page.waitForTimeout(300);
    }

    await page
      .locator('[data-window="maze"]')
      .screenshot({ path: join(args.screens, `${name}-${theme}.png`) });
    await page.screenshot({ path: join(args.screens, `${name}-overview-${theme}.png`) });
  }

  await toggle.click();
}

async function answers(page: Page): Promise<readonly string[]> {
  return page.locator('[data-tone]').allInnerTexts();
}

async function send(page: Page, command: string): Promise<string> {
  const before = (await answers(page)).join('|');
  await page.locator(`[data-command="${command}"]`).click();
  const dialog = page.getByRole('dialog');

  if (
    await dialog.waitFor({ timeout: 500 }).then(
      () => true,
      () => false
    )
  ) {
    await dialog.getByRole('button').last().click();
  }

  for (let tries = 0; tries < 100; tries++) {
    const now = await answers(page);

    if (now.join('|') !== before && now.length > 0) {
      return now.at(-1) ?? '';
    }

    await page.waitForTimeout(100);
  }

  throw new Error(`No answer to ${command}`);
}

function firstIndexAfter(states: readonly string[], state: string, from: number): number {
  const index = states.indexOf(state, from);
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}

async function main(): Promise<void> {
  if (args.screens !== undefined) {
    await mkdir(args.screens, { recursive: true });
  }

  const server = await createServer({
    server: { port: 5190, strictPort: false },
    logLevel: 'warn',
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0] ?? 'http://localhost:5190/';
  const browser = await chromium.launch({ headless: !args.headed });

  try {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      colorScheme: 'dark',
    });
    console.log(`app ${url}, robot ${args.robot}`);
    await page.goto(`${url}?connect=${encodeURIComponent(args.robot)}`);

    const first = await follow(
      page,
      (latest) => latest.state !== '' && latest.state !== '—',
      'the state'
    );
    await follow(page, (latest) => latest.walls !== null, 'the maze');

    if (first.state === 'IDLE') {
      check('EXPLORE from IDLE', (await send(page, 'EXPLORE')).includes('accepted'), 'accepted');
    }

    await follow(page, (latest) => latest.state === 'RUN', 'RUN');
    const refusal = await send(page, 'SAVE');
    check(
      'SAVE outside IDLE is refused with its reason',
      refusal.includes('Refused — robot not idle'),
      refusal.trim()
    );

    const runStart = snapshots.length;
    await follow(
      page,
      (latest) => (latest.explored ?? 0) >= (snapshots[runStart - 1]?.explored ?? 0) + 60,
      'the maze to fill in'
    );
    await screenshot(page, 'maze-during');

    const done = await follow(page, (latest) => latest.state === 'IDLE', 'the end of the search');
    await page.waitForTimeout(3000);
    const after = await follow(page, () => true, 'the last read of the maze');
    await screenshot(page, 'maze-after');

    const explored = snapshots.slice(runStart).map((entry) => entry.explored ?? 0);
    const updates = new Set(explored).size;
    check(
      'the maze updates by revision during the search',
      updates >= 10 &&
        explored.every((value, index) => index === 0 || value >= explored[index - 1]),
      `${updates} distinct maps, ${explored[0]} → ${after.explored} cells explored, ${after.walls} walls`
    );

    const searchLog = done.logStates;
    check(
      'the robot log reports the transitions of the search',
      firstIndexAfter(searchLog, 'RUN', 0) <
        firstIndexAfter(searchLog, 'IDLE', firstIndexAfter(searchLog, 'RUN', 0)),
      searchLog.join(' → ')
    );
    const shown = snapshots
      .map((entry) => entry.state)
      .filter((state, index, all) => state !== all[index - 1] && state !== '' && state !== '—');
    check(
      'every state shown is one the robot logged',
      shown.every((state) => state === first.state || searchLog.includes(state)),
      shown.join(' → ')
    );
    const unseen = [...new Set(searchLog)].filter((state) => !shown.includes(state));
    note(
      'states of the search too short for the 10 Hz state stream',
      unseen.length === 0
        ? 'none'
        : `${unseen.join(', ')}: only in the robot log and not on the timeline`
    );

    check(
      'EXPLORE again from IDLE',
      (await send(page, 'EXPLORE')).includes('accepted'),
      'accepted'
    );
    await follow(page, (latest) => latest.state === 'RUN', 'RUN again');
    await page.waitForTimeout(4000);
    const beforeStop = await follow(page, () => true, 'the run');
    await page.keyboard.press('Space');
    const stopped = await follow(
      page,
      (latest) =>
        latest.state === 'IDLE' &&
        latest.logStates.slice(beforeStop.logStates.length).includes('IDLE'),
      'IDLE after STOP'
    );
    const stopLog = stopped.logStates.slice(beforeStop.logStates.length);
    check(
      'STOP brakes the robot through BRAKE to IDLE',
      stopLog.join(' ') === 'BRAKE IDLE',
      `log after STOP: ${stopLog.join(' → ')}`
    );
    const timeline = stopped.timeline;
    check(
      'the Robot window timeline ends BRAKE, IDLE',
      timeline.slice(-2).join(' ') === 'BRAKE IDLE',
      timeline.join(' → ')
    );
    check(
      'the Robot window timeline follows the robot log',
      timeline.join(' ') === stopped.logStates.slice(-timeline.length).join(' '),
      `log ${stopped.logStates.slice(-timeline.length).join(' → ')}`
    );
    const cellAtStop = beforeStop.robotCell;
    await page.waitForTimeout(3000);
    const rest = await follow(page, () => true, 'the rest');
    check(
      'the robot stays where it stopped',
      rest.state === 'IDLE' && rest.robotCell !== null,
      `cell ${cellAtStop} when Space was pressed, ${rest.robotCell} at rest`
    );
  } finally {
    await browser.close();
    await server.close();
  }
}

try {
  await main();
} catch (error) {
  check('the check ran to its end', false, error instanceof Error ? error.message : String(error));
}

const failed = checks.filter((entry) => !entry.passed);
console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed in ${elapsed()}`);
process.exitCode = failed.length === 0 ? 0 : 1;
