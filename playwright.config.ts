import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run the real frontend against a MOCKED Supabase API
 * (see tests/e2e/mockSupabase.ts), so they need no project or credentials.
 * PW_CHROMIUM_PATH lets you use a pre-installed Chromium instead of `npx playwright install`.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npx vite --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_SUPABASE_URL: "https://mock-project.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "e2e-test-key",
    },
  },
});
