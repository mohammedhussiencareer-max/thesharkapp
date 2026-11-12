import { describe, expect, it } from 'vitest';
import {
  ConfirmedRefusalError,
  genericCatalogError,
  StaleWriteError,
} from '@/items/errors';
import {
  AlreadyCorrectedError,
  alreadyCorrectedMessage,
  alreadyCorrectedServerMessage,
  blockedItemIds,
  isAlreadyCorrected,
  isMissingCostBasis,
  isNotActivated,
  mapWasteError,
  MissingCostBasisError,
  missingCostMessage,
  notActivatedMessage,
  notActivatedServerMessage,
  syncRunningMessage,
} from '@/waste/errors';
import { itemA, itemB } from '@/waste/test-fixtures';

describe('waste errors', () => {
  it('already corrected is a known stale write with the 40001 code', () => {
    const error = new AlreadyCorrectedError();
    expect(error).toBeInstanceOf(StaleWriteError);
    expect(error.code).toBe('40001');
    expect(error.message).toBe(alreadyCorrectedMessage);
  });

  it('missing cost is a confirmed refusal that carries the item ids', () => {
    const error = new MissingCostBasisError([itemA]);
    expect(error).toBeInstanceOf(ConfirmedRefusalError);
    expect(error.itemIds).toEqual([itemA]);
    expect(error.message).toBe(missingCostMessage);
  });

  it('recognises the three refusals by code and exact text', () => {
    expect(
      isAlreadyCorrected({
        code: '40001',
        message: alreadyCorrectedServerMessage,
      }),
    ).toBe(true);
    expect(
      isAlreadyCorrected({ code: '40001', message: 'could not serialize' }),
    ).toBe(false);
    expect(
      isNotActivated({ code: '55000', message: notActivatedServerMessage }),
    ).toBe(true);
    expect(
      isNotActivated({ code: '55000', message: 'waste posting did not link' }),
    ).toBe(false);
    expect(
      isMissingCostBasis({ code: 'P0001', details: 'missing_cost_basis' }),
    ).toBe(true);
    expect(isMissingCostBasis({ code: 'P0001', details: 'other' })).toBe(false);
  });

  it('reads item ids from the hint and drops an unusable one', () => {
    expect(
      blockedItemIds({
        code: 'P0001',
        details: 'missing_cost_basis',
        hint: `${itemA}, ${itemB}`,
      }),
    ).toEqual([itemA, itemB]);
    expect(
      blockedItemIds({
        code: 'P0001',
        details: 'missing_cost_basis',
        hint: 'not-an-id',
      }),
    ).toEqual([]);
    expect(blockedItemIds({ code: '22023', hint: itemA })).toEqual([]);
  });

  it('maps the server refusals to Arabic', () => {
    expect(mapWasteError({ code: '42501', message: 'x' })).toContain('المالك');
    expect(
      mapWasteError({ code: '55000', message: notActivatedServerMessage }),
    ).toBe(notActivatedMessage);
    expect(
      mapWasteError({ code: 'P0001', details: 'missing_cost_basis' }),
    ).toBe(missingCostMessage);
    expect(
      mapWasteError({
        code: '22023',
        message: 'an explanation is required for the reason other',
      }),
    ).toContain('شرح');
    expect(
      mapWasteError({ code: '55P03', hint: 'a POS sync is running' }),
    ).toBe(syncRunningMessage);
    expect(
      mapWasteError({
        code: '22023',
        message: 'a voided waste document cannot be corrected',
      }),
    ).toContain('الملغي');
  });

  it('never shows raw server text', () => {
    expect(mapWasteError({ code: 'XX000', message: 'secret detail' })).toBe(
      genericCatalogError,
    );
    expect(mapWasteError({})).toBe(genericCatalogError);
  });
});
