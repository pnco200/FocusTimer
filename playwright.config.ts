import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 7000 },
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chrome-desktop', use: { channel: 'chrome', viewport: { width: 1440, height: 1080 } } },
    { name: 'chrome-mobile', use: { ...devices['Pixel 7'], channel: 'chrome' } },
    { name: 'edge-desktop', use: { channel: 'msedge', viewport: { width: 1366, height: 900 } } },
  ],
  webServer: [
    { command: `"${process.execPath}" node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort`, url: 'http://127.0.0.1:4173', reuseExistingServer: false, timeout: 30000 },
    // Direct repository tests use the exact TS source through Vite; the app
    // scenarios above still run the built production bundle and service worker.
    { command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4174 --strictPort`, url: 'http://127.0.0.1:4174/e2e/fixtures/repository.html', reuseExistingServer: false, timeout: 30000 },
  ],
});
