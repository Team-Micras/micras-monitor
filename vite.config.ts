import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { VitePWA } from 'vite-plugin-pwa';
import { configDefaults, defineConfig } from 'vitest/config';

const PERFORMANCE_TESTS = ['src/**/*-performance.test.{ts,tsx}'];

function chromium() {
  return {
    enabled: true,
    headless: true,
    provider: playwright(),
    viewport: { width: 1440, height: 900 },
    instances: [{ browser: 'chromium' as const }],
  };
}

/**
 * How many test files run at once, so a full check stays near half the cores of the reference
 * notebook and well under 4 GB: each browser file is a Chromium page of 150–250 MB. The groups run
 * one after the other, unit tests first, and the performance tests alone, one file at a time.
 */
const WORKERS = { unit: 6, browser: 4, performance: 1, e2e: 1 } as const;

const DARK_COLOR = '#0a0a0a';

/**
 * The largest chunk shipped, the entry with React DOM, is about 380 kB before gzip; a warning past
 * this means one grew.
 */
const CHUNK_SIZE_WARNING_KB = 400;

/** The GitHub Pages site serves the app from `/micras-monitor/`; anywhere else it is the root. */
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['micras_monitor_logo.svg', 'apple-touch-icon.png'],
      manifest: {
        id: base,
        name: 'Micras Monitor',
        short_name: 'Micras',
        description: 'Live monitor and remote control for the Micras micromouse',
        display: 'standalone',
        orientation: 'any',
        start_url: base,
        scope: base,
        theme_color: DARK_COLOR,
        background_color: DARK_COLOR,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          { src: 'micras_monitor_logo.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      strategies: 'injectManifest',
      srcDir: 'sw',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: [
          '**/*.{js,css,html,svg,png,webmanifest}',
          'assets/geist-latin-wght-normal-*.woff2',
          'assets/geist-latin-ext-wght-normal-*.woff2',
          'assets/geist-mono-latin-wght-normal-*.woff2',
          'assets/geist-mono-latin-ext-wght-normal-*.woff2',
        ],
        globIgnores: ['sw.js'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    chunkSizeWarningLimit: CHUNK_SIZE_WARNING_KB,
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          maxWorkers: WORKERS.unit,
          sequence: { groupOrder: 0 },
          include: ['src/**/*.test.ts', 'robots/**/*.test.ts', 'tools/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...PERFORMANCE_TESTS],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          maxWorkers: WORKERS.e2e,
          sequence: { groupOrder: 3 },
          include: ['e2e/**/*.test.ts'],
          environment: 'node',
          testTimeout: 90_000,
          hookTimeout: 180_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          maxWorkers: WORKERS.browser,
          sequence: { groupOrder: 1 },
          include: [
            'src/app/**/*.test.tsx',
            'src/lazy/**/*.test.tsx',
            'src/*.test.tsx',
            'robots/**/*.test.tsx',
          ],
          exclude: [...configDefaults.exclude, ...PERFORMANCE_TESTS],
          globalSetup: ['tools/browser-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          expect: { poll: { timeout: 10_000 } },
          browser: chromium(),
        },
      },
      {
        extends: true,
        test: {
          name: 'performance',
          include: PERFORMANCE_TESTS,
          globalSetup: ['tools/browser-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          expect: { poll: { timeout: 10_000 } },
          maxWorkers: WORKERS.performance,
          sequence: { groupOrder: 2 },
          browser: chromium(),
        },
      },
    ],
  },
});
