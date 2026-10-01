/**
 * Follow an exploration of Micras in the simulation through the monitor itself, headless, and
 * check what slice 8 promises: the maze updates by its revision, the state and its transitions
 * are right, STOP brakes the robot to a standstill in IDLE, and SAVE outside IDLE is refused with
 * its reason.
 *
 * ```
 * bun run check:sim --robot ws://127.0.0.1:8080 [--screens <dir>] [--minutes 25]
 * ```
 *
 * It serves the app with Vite, opens it at `?connect=<robot>` in Chromium and drives it with the
 * mouse and the keyboard, as a person would: Explore from IDLE (or follow an exploration already
 * running), Save during the run, wait for the search to end in IDLE, Explore again and press
 * Space. It reads what the windows on screen show, through the attributes they carry. With
 * `--screens` it saves the maze window during and after the search, dark and light. It exits
 * non-zero when a check fails. It is a manual check, not part of CI.
 *
 * @module
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { chromium, type Locator, type Page } from 'playwright';
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
const REST_DISPLACEMENT_M = 0.005;
const REST_SPEED_M_S = 0.01;

/** What the windows on screen show at one moment. */
interface Snapshot {
  readonly state: string;
  readonly revision: number | null;
  readonly walls: number | null;
  readonly explored: number | null;
  readonly robotCell: string | null;
  readonly poseX: number | null;
  readonly poseY: number | null;
  readonly speed: number | null;
  /** When the robot sampled the speed shown, in microseconds of its clock. */
  readonly speedTimeUs: number | null;
  readonly logStates: readonly string[];
  readonly timeline: readonly string[];
  readonly answers: number;
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

function elapsed(): string {
  return `${((Date.now() - started) / 1000).toFixed(1)} s`;
}

const SNAPSHOT_SCRIPT = `(() => {
  const visible = (selector) =>
    [...document.querySelectorAll(selector)].find((element) => element.checkVisibility({ visibilityProperty: true }));
  const number = (value) => (value === undefined || value === '' ? null : Number(value));
  const maze = visible('[data-maze]');
  const typeView = maze?.closest('[data-revision]') ?? null;
  const answers = [...document.querySelectorAll('[data-answer]')].map((element) =>
    Number(element.dataset.answer)
  );
  return {
    state: visible('[data-robot-state]')?.textContent ?? '',
    revision: number(typeView?.dataset.revision),
    walls: number(maze?.dataset.walls),
    explored: number(maze?.dataset.explored),
    robotCell: maze?.dataset.robotCell ?? null,
    poseX: number(maze?.dataset.poseX),
    poseY: number(maze?.dataset.poseY),
    speed: number(visible('[data-series="pose/linear_speed"]')?.dataset.value),
    speedTimeUs: number(visible('[data-series="pose/linear_speed"]')?.dataset.time),
    logStates: [...document.querySelectorAll('ol[aria-label="Log"] li')].flatMap((item) => {
      const match = /state ([A-Z_]+)$/.exec(item.textContent.trim());
      return match === null ? [] : [match[1]];
    }),
    timeline: [
      ...document.querySelectorAll('ol[aria-label="State transitions"] li span.truncate'),
    ].map((item) => item.textContent),
    answers: Math.max(0, ...answers),
  };
})()`;

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate<Snapshot>(SNAPSHOT_SCRIPT);
}

function changed(previous: Snapshot | undefined, latest: Snapshot): boolean {
  return (
    previous === undefined ||
    previous.state !== latest.state ||
    previous.revision !== latest.revision ||
    previous.explored !== latest.explored ||
    previous.walls !== latest.walls ||
    previous.logStates.length !== latest.logStates.length ||
    previous.timeline.join() !== latest.timeline.join()
  );
}

async function follow(
  page: Page,
  until: (latest: Snapshot) => boolean,
  what: string
): Promise<Snapshot> {
  for (;;) {
    const latest = await snapshot(page);

    if (changed(snapshots.at(-1), latest)) {
      snapshots.push(latest);
      console.log(
        `  ${elapsed()}  ${latest.state.padEnd(20)} revision ${latest.revision ?? '-'}, maze ${latest.walls ?? '-'} walls, ${latest.explored ?? '-'} explored, robot ${latest.robotCell ?? '-'}`
      );
    }

    if (until(latest)) {
      return latest;
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }

    await page.waitForTimeout(50);
  }
}

function mazeWindow(page: Page): Locator {
  return page
    .locator('section[data-window]')
    .filter({ has: page.locator('[data-maze]'), visible: true })
    .first();
}

async function screenshot(page: Page, name: string): Promise<void> {
  if (args.screens === undefined) {
    return;
  }

  const toggle = page.getByRole('button', { name: /Use the (light|dark) theme/ });

  for (const theme of ['dark', 'light'] as const) {
    const dark = ((await page.locator('html').getAttribute('class')) ?? '').split(' ');

    if (dark.includes('dark') !== (theme === 'dark')) {
      await toggle.click();
      await page.waitForTimeout(300);
    }

    await mazeWindow(page).screenshot({ path: join(args.screens, `${name}-${theme}.png`) });
    await page.screenshot({ path: join(args.screens, `${name}-overview-${theme}.png`) });
  }

  await toggle.click();
}

async function send(page: Page, command: string): Promise<string> {
  const before = (await snapshot(page)).answers;
  await page.locator(`[data-command="${command}"]`).filter({ visible: true }).first().click();
  const dialog = page.getByRole('dialog');

  if (
    await dialog.waitFor({ timeout: 500 }).then(
      () => true,
      () => false
    )
  ) {
    await dialog.getByRole('button').last().click();
  }

  const answer = page.locator(`[data-answer="${before + 1}"]`);
  await answer.waitFor({ timeout: 10_000 });
  return (await answer.innerText()).replaceAll('\n', ' ');
}

function cellOf(cell: string | null): readonly [number, number] | null {
  const [x, y] = (cell ?? '').split(',').map(Number);
  return Number.isInteger(x) && Number.isInteger(y) ? [x, y] : null;
}

/**
 * Counts the changes of the map in a stretch of snapshots, and those without a new revision since
 * the previous change, seen in the same snapshot or the next (both are sampled ten times a second).
 */
function mapChanges(stretch: readonly Snapshot[]): { total: number; unannounced: number } {
  let total = 0;
  let unannounced = 0;
  let revisionAtMap = stretch[0]?.revision ?? null;

  stretch.forEach((latest, index) => {
    const previous = stretch[index - 1];

    if (previous === undefined || latest.walls === null || previous.walls === null) {
      return;
    }

    if (latest.walls !== previous.walls || latest.explored !== previous.explored) {
      total++;
      const announcer = [latest, stretch[index + 1]].find(
        (entry) => entry !== undefined && entry.revision !== revisionAtMap
      );
      unannounced += announcer === undefined ? 1 : 0;
      revisionAtMap = announcer?.revision ?? latest.revision;
    }
  });

  return { total, unannounced };
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
      const explore = await send(page, 'EXPLORE');
      check('EXPLORE from IDLE', explore.includes('accepted'), explore);
    }

    await follow(page, (latest) => latest.state === 'RUN', 'RUN');
    const refusal = await send(page, 'SAVE');
    check(
      'SAVE outside IDLE is refused with its reason',
      refusal.includes('Refused — robot not idle'),
      refusal
    );

    const runStart = snapshots.length - 1;
    await follow(
      page,
      (latest) => (latest.explored ?? 0) >= (snapshots[runStart]?.explored ?? 0) + 60,
      'the maze to fill in'
    );
    await screenshot(page, 'maze-during');

    await follow(page, (latest) => latest.state === 'IDLE', 'the end of the search');
    await page.waitForTimeout(3000);
    const done = await follow(page, () => true, 'the last read of the maze');
    await screenshot(page, 'maze-after');

    const search = snapshots.slice(runStart);
    const explored = search.flatMap((entry) => (entry.explored === null ? [] : [entry.explored]));
    const changes = mapChanges(search);
    check(
      'the maze grows during the search and never goes back',
      changes.total >= 10 &&
        explored.every((value, index) => index === 0 || value >= explored[index - 1]),
      `${changes.total} map changes, ${explored[0]} → ${done.explored} cells explored, ${done.walls} walls, revision ${search[0]?.revision} → ${done.revision}`
    );
    check(
      'every change of the map follows a change of its revision',
      changes.unannounced === 0,
      `${changes.unannounced} of ${changes.total} changes without a new revision`
    );

    const searchLog = done.logStates;
    check(
      'the robot log reports the search, SAVE included',
      searchLog.includes('RUN') && searchLog.includes('SAVE') && searchLog.at(-1) === 'IDLE',
      searchLog.join(' → ')
    );
    check(
      'the Robot window timeline of the search is the robot log',
      done.timeline.length > 0 &&
        done.timeline.join(' ') === searchLog.slice(-done.timeline.length).join(' '),
      `timeline ${done.timeline.join(' → ')}`
    );

    const explore = await send(page, 'EXPLORE');
    check('EXPLORE again from IDLE', explore.includes('accepted'), explore);
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
    check(
      'the Robot window timeline after STOP is the robot log',
      stopped.timeline.slice(-2).join(' ') === 'BRAKE IDLE' &&
        stopped.timeline.join(' ') === stopped.logStates.slice(-stopped.timeline.length).join(' '),
      `timeline ${stopped.timeline.join(' → ')}`
    );

    await page.waitForTimeout(500);
    const rest = await follow(page, () => true, 'the robot at rest');
    const revisionAtRest = rest.revision;
    await page.waitForTimeout(2000);
    const later = await follow(page, () => true, 'the robot still at rest');
    const moved =
      rest.poseX === null || rest.poseY === null || later.poseX === null || later.poseY === null
        ? Number.POSITIVE_INFINITY
        : Math.hypot(later.poseX - rest.poseX, later.poseY - rest.poseY);
    const fresh =
      later.speedTimeUs !== null &&
      beforeStop.speedTimeUs !== null &&
      later.speedTimeUs > beforeStop.speedTimeUs;
    const sampledAfter =
      later.speedTimeUs === null || beforeStop.speedTimeUs === null
        ? 'never sampled'
        : `sampled ${((later.speedTimeUs - beforeStop.speedTimeUs) / 1e6).toFixed(2)} s after Space`;
    check(
      'STOP stops the robot',
      moved < REST_DISPLACEMENT_M &&
        fresh &&
        later.speed !== null &&
        Math.abs(later.speed) < REST_SPEED_M_S,
      `moved ${(moved * 1000).toFixed(2)} mm in 2 s at rest, speed ${later.speed} m/s ${sampledAfter}`
    );
    const stopCell = cellOf(beforeStop.robotCell);
    const restCell = cellOf(later.robotCell);
    check(
      'the robot rests in the cell it was stopped in or the next one',
      stopCell !== null &&
        restCell !== null &&
        Math.abs(stopCell[0] - restCell[0]) + Math.abs(stopCell[1] - restCell[1]) <= 1,
      `cell ${beforeStop.robotCell} when Space was pressed, ${later.robotCell} at rest`
    );
    check(
      'the map does not change while the robot is at rest',
      later.walls === rest.walls &&
        later.explored === rest.explored &&
        later.revision === revisionAtRest,
      `revision ${revisionAtRest} → ${later.revision}, ${rest.walls} → ${later.walls} walls`
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
