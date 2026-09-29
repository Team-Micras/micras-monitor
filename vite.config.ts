import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'robots/**/*.test.ts', 'tools/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: [
            'src/app/**/*.test.tsx',
            'src/lazy/**/*.test.tsx',
            'src/*.test.tsx',
            'robots/**/*.test.tsx',
          ],
          globalSetup: ['tools/browser-setup.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            viewport: { width: 1440, height: 900 },
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
