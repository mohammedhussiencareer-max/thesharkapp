import { describe, expect, it } from 'vitest';
import {
  badOrderMessage,
  callFailedMessage,
  mapActivationError,
  ownerReadMessage,
  ownerRunMessage,
  readError,
  scalingNotReadyMessage,
  writeError,
} from '@/accounting/errors';
import { genericCatalogError } from '@/items/errors';
import { isUnknownOutcome } from '@/lib/write-outcome';

describe('accounting errors', () => {
  it('maps a read refusal without the database message', () => {
    const error = readError({
      code: '42501',
      message: 'permission denied for function accounting_processing_summary',
    });
    expect(error.message).toBe(ownerReadMessage);
    expect(error.message).not.toContain('permission');
    expect((error as { code?: string }).code).toBe('42501');
  });

  it('hides other read failures', () => {
    const error = readError({ code: 'XX000', message: 'secret detail' });
    expect(error.message).toBe(genericCatalogError);
    expect(error.message).not.toContain('secret');
  });

  it('keeps an unknown write code and drops the raw message', () => {
    const error = writeError({
      code: '57014',
      message: 'canceling statement due to statement timeout',
    });
    expect(error.message).toBe(callFailedMessage);
    expect(isUnknownOutcome(error)).toBe(true);
    expect((error as { code?: string }).code).toBe('57014');
  });

  it('maps the scaling gate to Arabic and keeps 55000', () => {
    const error = mapActivationError({
      code: '55000',
      message: 'scaling is not ready',
    });
    expect(error.message).toBe(scalingNotReadyMessage);
    expect((error as { code?: string }).code).toBe('55000');
    expect(error.message).not.toContain('scaling');
  });

  it('treats 42501 and 22023 as definite Arabic refusals', () => {
    const refused = writeError({ code: '42501', message: 'raw' });
    expect(refused.message).toBe(ownerRunMessage);
    expect(isUnknownOutcome(refused)).toBe(false);
    const bad = writeError({ code: '22023', message: 'raw' });
    expect(bad.message).toBe(badOrderMessage);
    expect(isUnknownOutcome(bad)).toBe(false);
  });
});
