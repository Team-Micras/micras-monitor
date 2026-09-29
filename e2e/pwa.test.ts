import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { preview, type PreviewServer } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

interface Icon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose?: string;
}

interface Manifest {
  readonly name: string;
  readonly display: string;
  readonly start_url: string;
  readonly theme_color: string;
  readonly background_color: string;
  readonly icons: readonly Icon[];
}

function isManifest(value: unknown): value is Manifest {
  return typeof value === 'object' && value !== null && 'icons' in value && 'name' in value;
}

const WINDOW_TITLES = [
  'Plot',
  'Readouts',
  'Editor',
  'Type view',
  'Robot',
  'Commands',
  'Log',
  'Link',
];

let dist: string;
let server: PreviewServer;
let origin: string;
let browser: Browser;
const contexts: BrowserContext[] = [];

async function serve(outDir: string): Promise<PreviewServer> {
  return preview({
    configFile: false,
    root: process.cwd(),
    logLevel: 'silent',
    build: { outDir },
    preview: { port: 0, host: '127.0.0.1' },
  });
}

async function fresh(): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  return context.newPage();
}

async function controlled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 20_000,
  });
}

async function precached(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names.find((name) => name.includes('precache')) ?? '');
    return (await cache.keys()).length;
  });
}

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'micras-monitor-e2e-'));
  execFileSync('bunx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], {
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'pipe',
  });
  server = await serve(dist);
  origin = server.resolvedUrls?.local[0] ?? '';
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  await browser?.close();
  await server?.close();
  rmSync(dist, { recursive: true, force: true });
});

describe('the PWA', () => {
  test('serves a valid manifest whose icons exist, linked from the page', async () => {
    const page = await fresh();
    await page.goto(`${origin}?fake`);
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBeTruthy();

    const response = await page.request.get(new URL(href ?? '', origin).href);
    expect(response.ok()).toBe(true);
    const manifest: unknown = await response.json();
    if (!isManifest(manifest)) {
      throw new Error('the manifest has no name or icons');
    }

    expect(manifest.name).toBe('Micras Monitor');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.icons.some((icon) => icon.sizes === '192x192')).toBe(true);
    expect(manifest.icons.some((icon) => icon.sizes === '512x512')).toBe(true);
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);

    for (const icon of manifest.icons) {
      const file = await page.request.get(new URL(icon.src, origin).href);
      expect(file.ok()).toBe(true);
      expect(file.headers()['content-type']).toContain(icon.type);
    }

    const colors = await page
      .locator('meta[name="theme-color"]')
      .evaluateAll((metas) => metas.map((meta) => meta.getAttribute('media')));
    expect(colors).toEqual(
      expect.arrayContaining(['(prefers-color-scheme: dark)', '(prefers-color-scheme: light)'])
    );
  });

  test('registers the service worker, which precaches the shell and the latin fonts only', async () => {
    const page = await fresh();
    await page.goto(`${origin}?fake`);
    await controlled(page);

    const urls = await page.evaluate(async () => {
      const names = await caches.keys();
      const cache = await caches.open(names.find((name) => name.includes('precache')) ?? '');
      return (await cache.keys()).map((request) => new URL(request.url).pathname);
    });

    expect(urls).toEqual(expect.arrayContaining(['/index.html', '/manifest.webmanifest']));
    expect(urls.some((url) => /geist-latin-wght/.test(url))).toBe(true);
    expect(urls.some((url) => /geist-mono-latin-ext-wght/.test(url))).toBe(true);
    expect(urls.filter((url) => /cyrillic|vietnamese|symbols/.test(url))).toEqual([]);
    for (const chunk of ['plot-window', 'type-view-window', 'launcher', 'variable-drawer']) {
      expect(urls.some((url) => url.includes(chunk))).toBe(true);
    }
  });

  test('reloads offline and opens every window kind from the cache', async () => {
    const page = await fresh();
    await page.goto(`${origin}?fake`);
    await controlled(page);
    expect(await precached(page)).toBeGreaterThan(30);

    await page.context().setOffline(true);
    await page.reload();
    await page.getByRole('region', { name: 'Workspace Overview' }).waitFor();

    for (const title of WINDOW_TITLES) {
      const before = await page.locator('[data-window]').count();
      await page.keyboard.press('Control+k');
      await page.getByPlaceholder('Open a window or run an action…').fill(`open ${title}`);
      await page.keyboard.press('Enter');
      await expect.poll(() => page.locator('[data-window]').count()).toBeGreaterThan(before);
      await page.waitForTimeout(400);
      expect(await page.getByRole('alert').count()).toBe(0);
    }

    await page
      .getByRole('button', { name: /Connect/ })
      .first()
      .click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
    await page.getByText('· connected').waitFor();
  });

  test('offers an update without reloading, and refuses to reload while the robot runs', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'micras-monitor-e2e-update-'));
    cpSync(dist, copy, { recursive: true });
    const updating = await serve(copy);
    const url = updating.resolvedUrls?.local[0] ?? '';

    try {
      const page = await fresh();
      await page.goto(`${url}?fake`);
      await controlled(page);
      await page.reload();
      await controlled(page);
      await page.evaluate(() => {
        Reflect.set(window, '__firstLoad', true);
      });

      await page
        .getByRole('button', { name: /Connect/ })
        .first()
        .click();
      await page.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
      await page.keyboard.press('Escape');
      await page
        .locator('[data-robot-state]')
        .filter({ hasText: 'RUN' })
        .waitFor({ timeout: 20_000 });

      appendFileSync(join(copy, 'sw.js'), '\n// a newer build\n');
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        await registration?.update();
      });

      const notice = page.getByRole('status', { name: 'Update available' });
      await notice.waitFor({ timeout: 20_000 });
      const reload = notice.getByRole('button', { name: 'Reload' });
      expect(await reload.isDisabled()).toBe(true);
      await page.waitForTimeout(1500);
      expect(await page.evaluate(() => Reflect.get(window, '__firstLoad'))).toBe(true);

      await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
      await page.locator('[data-robot-state]').filter({ hasText: 'IDLE' }).waitFor();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('output button')].some(
            (button) =>
              button.textContent === 'Reload' &&
              button instanceof HTMLButtonElement &&
              !button.disabled
          ),
        undefined,
        { timeout: 10_000 }
      );

      await Promise.all([page.waitForEvent('load'), reload.click()]);
      expect(await page.evaluate(() => Reflect.get(window, '__firstLoad'))).toBeUndefined();
    } finally {
      await updating.close();
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
