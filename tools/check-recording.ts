/**
 * Record a long session of the simulated robot through the monitor itself, kill the tab in the
 * middle, and check what slice 9 promises: the reopened monitor recovers the recording with
 * nothing lost beyond the last 5 s, and the whole history opens and scrolls with the cost of
 * what is on screen.
 *
 * ```
 * bun run simulate --port 8080 &
 * bun tools/check-recording.ts --robot ws://127.0.0.1:8080 [--minutes 30] [--kill-at 15]
 *   [--memory-cap-mb <n>] [--view-cap-mb <n>] [--screens <dir>] [--headed]
 * ```
 *
 * It serves the app with Vite and drives Chromium with a profile of its own, so that the Origin
 * Private File System outlives the tab: it plots a few of the robot's variables, starts REC,
 * records until `--kill-at` minutes and kills the browser with SIGKILL, as the tab dying does.
 * A new browser on the same profile then recovers the recording, opens it, shows the whole
 * history and scrolls through it, while it records the rest of the session, to `--minutes`.
 * With `--memory-cap-mb` the stores keep that much at most, and with `--view-cap-mb` the store of
 * an opened session alone, so that blocks leave memory and come back from the file as the history
 * scrolls. It prints the numbers and exits non-zero when
 * a check fails. It is a manual check, not part of CI.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { chromium, type BrowserContext, type Page } from 'playwright';
import { createServer } from 'vite';

const { values: args } = parseArgs({
  options: {
    robot: { type: 'string', default: 'ws://127.0.0.1:8080' },
    minutes: { type: 'string', default: '30' },
    'kill-at': { type: 'string', default: '15' },
    'memory-cap-mb': { type: 'string' },
    'view-cap-mb': { type: 'string' },
    screens: { type: 'string' },
    headed: { type: 'boolean', default: false },
  },
});

const TOTAL_MS = Number(args.minutes) * 60_000;
const KILL_MS = Number(args['kill-at']) * 60_000;
const FLUSH_LOSS_US = 5_000_000;
const PLOTTED = ['imu/gyro_z', 'imu/accel_x', 'cmd/linear', 'response/left', 'response/right'];
const VIEWPORT = { width: 1600, height: 1000 };

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

interface RecordingProgress {
  readonly elapsedMs: number;
  readonly bytes: number;
  readonly samples: number;
  readonly memory: number;
}

interface SessionRow {
  readonly id: string;
  readonly samples: number;
  readonly durationUs: number;
  readonly bytes: number;
}

const AGGREGATE_ERRORS_SCRIPT = `addEventListener('error', (event) => {
  if (event.error instanceof AggregateError) {
    for (const cause of event.error.errors) {
      console.error(cause?.stack ?? String(cause));
    }
  }
});`;

const checks: Check[] = [];
const started = Date.now();

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

function log(text: string): void {
  console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(5)} s] ${text}`);
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function clock(us: number): string {
  const seconds = us / 1e6;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}

async function launch(profile: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, {
    headless: !args.headed,
    viewport: VIEWPORT,
    colorScheme: 'dark',
  });
}

function kill(profile: string): void {
  try {
    execFileSync('pkill', ['-9', '-f', `user-data-dir=${profile}`]);
  } catch {
    return;
  }
}

async function open(context: BrowserContext, url: string): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (error) => log(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      log(`console: ${message.text().slice(0, 400)}`);
    }
  });
  await page.addInitScript(AGGREGATE_ERRORS_SCRIPT);
  const query = new URLSearchParams({ connect: args.robot });

  for (const cap of ['memory-cap-mb', 'view-cap-mb'] as const) {
    const value = args[cap];

    if (value !== undefined) {
      query.set(cap, value);
    }
  }

  await page.goto(`${url}?${query.toString()}`, { timeout: 120_000 });
  await page.getByText('· connected').first().waitFor({ timeout: 120_000 });
  return page;
}

async function plotVariables(page: Page): Promise<void> {
  const plot = page
    .locator('[data-window]')
    .filter({ has: page.locator('[data-plot]') })
    .first();
  const drawer = page.locator('[data-variable]').first();
  await plot.locator('[data-plot]').click();

  for (const name of PLOTTED) {
    if (!(await drawer.isVisible())) {
      await page.keyboard.press('/');
      await drawer.waitFor();
    }

    await page.locator(`[data-variable="${name}"]`).click();
  }

  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
}

async function recMenu(page: Page, item: RegExp, attempt = 1): Promise<void> {
  const entry = page.getByRole('button', { name: item });

  if (!(await entry.isVisible())) {
    await page.locator('[data-rec]').click();
  }

  try {
    await entry.click({ timeout: 15_000 });
    await entry.waitFor({ state: 'hidden' });
    await page.waitForTimeout(400);
  } catch (error) {
    if (attempt >= 3) {
      throw error;
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await recMenu(page, item, attempt + 1);
  }
}

async function progress(page: Page): Promise<RecordingProgress> {
  const button = page.locator('[data-rec]');
  const [elapsed, bytes, samples, memory] = await Promise.all(
    ['data-elapsed-ms', 'data-recorded-bytes', 'data-recorded-samples', 'data-memory-used'].map(
      (name) => button.getAttribute(name)
    )
  );
  return {
    elapsedMs: Number(elapsed),
    bytes: Number(bytes),
    samples: Number(samples),
    memory: Number(memory),
  };
}

async function liveEndUs(page: Page): Promise<number> {
  return Number(await page.locator('[data-plot]').first().getAttribute('data-window-end-us'));
}

async function recordUntil(page: Page, untilMs: number, label: string): Promise<void> {
  while (Date.now() < untilMs) {
    await page.waitForTimeout(Math.min(60_000, Math.max(0, untilMs - Date.now())));
    const now = await progress(page);
    log(
      `${label}: ${(now.elapsedMs / 60_000).toFixed(1)} min, ${megabytes(now.bytes)}, ${now.samples} samples`
    );
  }
}

async function sessionRows(page: Page): Promise<SessionRow[]> {
  await recMenu(page, /Sessions/);
  const rows = page.locator('[data-session]');
  await rows.first().waitFor();
  const found: SessionRow[] = [];

  for (const row of await rows.all()) {
    const [id, samples, durationUs, bytes] = await Promise.all(
      ['data-session', 'data-samples', 'data-duration-us', 'data-bytes'].map((name) =>
        row.getAttribute(name)
      )
    );
    found.push({
      id: id ?? '',
      samples: Number(samples),
      durationUs: Number(durationUs),
      bytes: Number(bytes),
    });
  }

  await page.keyboard.press('Escape');
  return found;
}

async function plotWindow(page: Page): Promise<{ startUs: number; endUs: number; drawMs: number }> {
  const plot = page.locator('[data-plot]').first();
  const [start, end, draw] = await Promise.all([
    plot.getAttribute('data-window-start-us'),
    plot.getAttribute('data-window-end-us'),
    plot.getAttribute('data-draw-ms'),
  ]);
  return { startUs: Number(start), endUs: Number(end), drawMs: Number(draw) };
}

async function focusPlot(page: Page): Promise<void> {
  const plot = page.locator('[data-plot]').first();
  const box = await plot.boundingBox();

  if (box !== null) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}

async function screenshot(page: Page, name: string): Promise<void> {
  if (args.screens === undefined) {
    return;
  }

  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(`document.documentElement.classList.toggle('dark', ${scheme === 'dark'})`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(args.screens, `${name}-${scheme}.png`) });
  }
}

async function navigate(page: Page, label: string): Promise<void> {
  await focusPlot(page);
  const homeStarted = performance.now();
  await page.keyboard.press('Home');
  await page.waitForTimeout(50);
  const whole = await plotWindow(page);
  const homeMs = performance.now() - homeStarted;
  log(`${label}: whole history ${clock(whole.endUs - whole.startUs)} drawn in ${whole.drawMs} ms`);
  await screenshot(page, `${label}-whole`);

  for (let zoom = 0; zoom < 12; zoom++) {
    await page.keyboard.press('+');
  }

  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowLeft');

  for (let zoom = 0; zoom < 10; zoom++) {
    await page.keyboard.press('+');
  }

  const first = await plotWindow(page);
  const span = first.endUs - first.startUs;
  const draws: number[] = [];
  const scrollStarted = performance.now();
  let steps = 0;
  let last = first;

  while (last.endUs < whole.endUs && steps < 5000) {
    await page.keyboard.press('Shift+ArrowRight');
    last = await plotWindow(page);
    draws.push(last.drawMs);
    steps++;
  }

  const scrollMs = performance.now() - scrollStarted;
  const sorted = draws.toSorted((left, right) => left - right);
  const p95 = sorted[Math.floor(0.95 * (sorted.length - 1))] ?? 0;
  const viewing = page.locator('[data-viewing]');
  const [evicted, resident, reads] = await Promise.all(
    ['data-evicted-blocks', 'data-resident-blocks', 'data-block-reads'].map((name) =>
      viewing.getAttribute(name)
    )
  );
  log(
    `${label}: scrolled ${clock(whole.endUs - whole.startUs)} in windows of ${clock(span)}, ${steps} steps in ${(scrollMs / 1000).toFixed(1)} s; draw p50 ${sorted[Math.floor(sorted.length / 2)] ?? 0} ms, p95 ${p95} ms, max ${sorted.at(-1) ?? 0} ms; ${resident} blocks in memory and ${evicted} out of it, ${reads} read back from the file`
  );
  check(
    `${label}: the whole history shows at once`,
    whole.drawMs < 50 && homeMs < 2000,
    `${whole.drawMs} ms to draw, ${homeMs.toFixed(0)} ms from the key`
  );
  check(
    `${label}: scrolling the whole history costs what is on screen`,
    steps > 10 && p95 < 16,
    `${steps} steps, p95 ${p95} ms per draw`
  );

  const box = await page.locator('[data-plot]').first().boundingBox();

  if (box !== null) {
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
    await page.mouse.wheel(0, 400);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  }

  await page.waitForTimeout(500);
  await screenshot(page, `${label}-scrolled`);
}

async function main(): Promise<void> {
  if (args.screens !== undefined) {
    await mkdir(args.screens, { recursive: true });
  }

  const server = await createServer({
    server: { port: 5192, strictPort: false },
    logLevel: 'warn',
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0] ?? 'http://localhost:5192/';
  const profile = await mkdtemp(join(tmpdir(), 'micras-check-recording-'));
  log(`app ${url}, robot ${args.robot}, profile ${profile}`);

  try {
    let context = await launch(profile);
    let page = await open(context, url);
    await plotVariables(page);
    await recMenu(page, /Start recording/);
    const recordingStarted = Date.now();
    log('recording');
    await page.waitForTimeout(8000);
    await screenshot(page, 'rec');
    await page.locator('[data-rec]').click();
    await page.waitForTimeout(300);
    await screenshot(page, 'rec-menu');
    await page.keyboard.press('Escape');

    await recordUntil(page, recordingStarted + KILL_MS, 'first tab');
    const beforeKill = await progress(page);
    const endBeforeKillUs = await liveEndUs(page);
    kill(profile);
    const killedAt = Date.now();
    log(
      `killed the browser at ${(beforeKill.elapsedMs / 60_000).toFixed(2)} min: ${megabytes(beforeKill.bytes)} and ${beforeKill.samples} samples written`
    );
    await context.close().catch(() => undefined);

    context = await launch(profile);
    page = await open(context, url);
    const notice = page.locator('[data-recovered]');
    await notice.waitFor({ timeout: 30_000 });
    const recoveredId = (await notice.getAttribute('data-recovered')) ?? '';
    log(
      `recovered after ${((Date.now() - killedAt) / 1000).toFixed(1)} s: ${await notice.innerText()}`
    );
    await screenshot(page, 'recovered');
    await plotVariables(page);
    await recMenu(page, /Start recording/);
    const secondStarted = Date.now();

    const recovered = (await sessionRows(page)).find((row) => row.id === recoveredId);

    if (recovered === undefined) {
      throw new Error(`The recovered session ${recoveredId} is not in the list`);
    }

    await recMenu(page, /Sessions/);
    await page.waitForTimeout(300);
    await screenshot(page, 'sessions');
    const openStarted = performance.now();
    await page
      .locator(`[data-session="${recovered.id}"]`)
      .getByRole('button', { name: 'Open' })
      .click();
    await page.locator('[data-viewing]').waitFor();
    await page.locator('[data-plot][data-empty="false"]').first().waitFor();
    const openMs = performance.now() - openStarted;
    await page.waitForTimeout(500);
    const loadMs = Number(await page.locator('[data-viewing]').getAttribute('data-load-ms'));
    await focusPlot(page);
    await page.keyboard.press('Home');
    await page.waitForTimeout(100);
    const history = await plotWindow(page);
    const lostUs = endBeforeKillUs - history.endUs;
    log(
      `recovered session: ${megabytes(recovered.bytes)}, ${recovered.samples} samples, ${clock(recovered.durationUs)}, ${clock(history.startUs)} to ${clock(history.endUs)}; opened in ${openMs.toFixed(0)} ms (read and load ${loadMs} ms)`
    );
    check(
      'the recording survives the killed tab with nothing lost beyond the last 5 s',
      lostUs <= FLUSH_LOSS_US && recovered.samples >= beforeKill.samples,
      `${(lostUs / 1e6).toFixed(2)} s of the live end lost; ${recovered.samples} samples recovered, ${beforeKill.samples} written when the tab was killed`
    );
    check(
      'the recovered session opens quickly',
      openMs < 10_000,
      `${openMs.toFixed(0)} ms to the first plot, ${loadMs} ms to read and load ${megabytes(recovered.bytes)}`
    );
    await navigate(page, 'recovered');
    await page.getByRole('button', { name: 'Live' }).first().click();
    await page.waitForTimeout(500);

    await recordUntil(page, recordingStarted + TOTAL_MS, 'second tab');
    await recMenu(page, /Stop recording/);
    await page.waitForTimeout(1000);
    const rows = await sessionRows(page);
    const second = rows.find((row) => row.id !== recovered.id && row.samples > 0);

    if (second === undefined) {
      check('the second recording is saved', false, 'not in the list');
    } else {
      log(
        `second session: ${megabytes(second.bytes)}, ${second.samples} samples, ${clock(second.durationUs)}`
      );
      check(
        'the second recording is saved whole',
        second.durationUs >= (Date.now() - secondStarted - 10_000) * 1000,
        `${clock(second.durationUs)} over ${((Date.now() - secondStarted) / 60_000).toFixed(1)} min of recording`
      );
      await recMenu(page, /Sessions/);
      await page
        .locator(`[data-session="${second.id}"]`)
        .getByRole('button', { name: 'Open' })
        .click();
      await page.locator('[data-viewing]').waitFor();
      await page.waitForTimeout(500);
      await navigate(page, 'second');
    }

    await context.close();
  } finally {
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }

  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
