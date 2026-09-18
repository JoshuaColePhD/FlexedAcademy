import { defineConfig } from '@playwright/test'

// This suite deliberately needs an explicitly supplied disposable test account.
// It never creates one and never puts credentials, teacher data, or generated
// lesson text in source control. `npm run test:e2e` is a no-op when those vars
// are absent, while CI/staging can provide them as protected secrets.
/* Some sandboxes ship a prebuilt Chromium that does not match the build this
 * @playwright/test version would download, and cannot fetch one. Point at it
 * with PLAYWRIGHT_CHROMIUM_PATH rather than editing this file. */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  fullyParallel: false,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5174',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  reporter: [['list']],
})
