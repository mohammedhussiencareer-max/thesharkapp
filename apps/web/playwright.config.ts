import { defineConfig, devices } from '@playwright/test';

const browser = { ...devices['Desktop Chrome'] };

// Ledger writers and the accounting worker share advisory lock
// 7342750000000000001. Activation is append-only, so dormancy runs before
// the activate project records it. Processing then seeds one order.
// Ledger files run one at a time after that queue is empty. Expenses and
// the read-only specs do not take the lock, so they stay parallel.
const ledgerSpecs = [
  '**/items.spec.ts',
  '**/purchases.spec.ts',
  '**/counts.spec.ts',
  '**/sorting.spec.ts',
  '**/waste.spec.ts',
  '**/recipes.spec.ts',
  '**/recipe-import.spec.ts',
  '**/mapping.spec.ts',
  '**/packaging.spec.ts',
  '**/order-decisions.spec.ts',
];

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  projects: [
    {
      name: 'dormant',
      testMatch: '**/processing-dormant.spec.ts',
      workers: 1,
      use: browser,
    },
    {
      name: 'activate',
      testMatch: '**/activate-accounting.spec.ts',
      dependencies: ['dormant'],
      workers: 1,
      use: browser,
    },
    {
      name: 'processing',
      testMatch: '**/processing-panel.spec.ts',
      dependencies: ['activate'],
      workers: 1,
      use: browser,
    },
    {
      name: 'ledger',
      testMatch: ledgerSpecs,
      dependencies: ['processing'],
      fullyParallel: false,
      workers: 1,
      use: browser,
    },
    {
      name: 'chromium',
      testIgnore: [
        '**/processing-dormant.spec.ts',
        '**/activate-accounting.spec.ts',
        '**/processing-panel.spec.ts',
        ...ledgerSpecs,
      ],
      use: browser,
    },
  ],
  webServer: {
    command:
      'pnpm exec tsc -b && pnpm exec vite build --mode development && pnpm preview',
    url: 'http://127.0.0.1:4173',
    // Never reuse a running server: it could be a production preview that talks to the hosted project.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
