import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { resetHeldWritesStore } from '@/lib/held-writes';
import { resetPwaState } from '@/lib/pwa';

afterEach(() => {
  cleanup();
  resetHeldWritesStore({ clearStorage: true, resetUser: true });
  resetPwaState();
});
