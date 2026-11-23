import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { resetHeldWritesStore } from '@/lib/held-writes';
import { resetPwaState } from '@/lib/pwa';
import { makeAuditedLocks } from '@/test/held-write-locks';

// Reuse the real writer regression scenarios as the lock-order audit. These
// suites exercise submissions, refusals, ambiguous replies, and readback.
const auditedWriterSuites = new Set([
  'accounting/ProcessingPanel.test.tsx',
  'accounting/activation-action.test.tsx',
  'items/ConversionsPanel.test.tsx',
  'items/api.test.ts',
  'mapping/SubjectPanel.test.tsx',
  'order-decisions/DecisionCard.test.tsx',
  'packaging/PackagingEditor.test.tsx',
  'pages/ActivationPage.test.tsx',
  'pages/CountsPage.test.tsx',
  'pages/ExpensesPage.test.tsx',
  'pages/ItemsPage.test.tsx',
  'pages/MappingPage.test.tsx',
  'pages/OpeningPage.test.tsx',
  'pages/OrderDecisionsPage.test.tsx',
  'pages/PackagingPage.test.tsx',
  'pages/PurchasesPage.test.tsx',
  'pages/RecipeImportPage.test.tsx',
  'pages/RecipePage.test.tsx',
  'pages/RecipesPage.test.tsx',
  'pages/SalesPage.processing.test.tsx',
  'pages/SortingPage.test.tsx',
  'pages/WastePage.test.tsx',
  'recipes/api.test.ts',
]);
let audit: ReturnType<typeof makeAuditedLocks> | undefined;
let originalLocks: PropertyDescriptor | undefined;
let auditedNavigator: Navigator | undefined;

beforeEach(() => {
  const path = expect
    .getState()
    .testPath?.replaceAll('\\', '/')
    .split('/src/')
    .at(-1);
  if (!path || !auditedWriterSuites.has(path)) return;
  audit = makeAuditedLocks();
  auditedNavigator = navigator;
  originalLocks = Object.getOwnPropertyDescriptor(auditedNavigator, 'locks');
  Object.defineProperty(auditedNavigator, 'locks', {
    configurable: true,
    value: audit.locks,
  });
});

afterEach(() => {
  try {
    cleanup();
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
    resetPwaState();
    if (audit)
      expect(
        audit.nested,
        'writer requested another subject lock before releasing its current subject',
      ).toEqual([]);
  } finally {
    if (auditedNavigator) {
      if (originalLocks)
        Object.defineProperty(auditedNavigator, 'locks', originalLocks);
      else Reflect.deleteProperty(auditedNavigator, 'locks');
    }
    auditedNavigator = undefined;
    audit = undefined;
  }
});
