import { defineConfig, devices } from '@playwright/test';

const basePath = process.env.VITE_BASE_PATH || '/ssh-web-terminal/';
const normalizedBase = basePath.startsWith('/') ? basePath : '/ssh-web-terminal/';
const previewPort = process.env.PLAYWRIGHT_PORT || '4273';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${previewPort}${normalizedBase}`,
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] }
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] }
    }
  ],
  webServer: [
    {
      command:
        'export PATH="/usr/local/go/bin:/opt/homebrew/bin:$HOME/go/bin:$PATH" && cd apps/gateway && GOPROXY=direct GOSUMDB=off ENABLE_TESTSSHD=1 LISTEN_ADDR=127.0.0.1:8080 TESTSSHD_PASSWORD=testpass123 go run ./cmd/gateway',
      url: 'http://127.0.0.1:8080/healthz',
      reuseExistingServer: !process.env.CI,
      timeout: 60000
    },
    {
      command: `VITE_BASE_PATH=${normalizedBase} npm run build && VITE_BASE_PATH=${normalizedBase} npm --workspace=@webssh/web run preview -- --port ${previewPort} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${previewPort}${normalizedBase}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60000
    }
  ]
});
