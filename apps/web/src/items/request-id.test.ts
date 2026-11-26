import { getHeldWrite } from '@/lib/held-writes';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfirmedRefusalError } from '@/items/errors';
import {
  claimFreshAction,
  hasAction,
  heldAction,
  replaceActivationPayload,
  pinActivationReviewReload,
  resetHeldWrites,
  settleAction,
  unknownAction,
} from '@/items/request-id';

describe('settleAction', () => {
  beforeEach(() => {
    resetHeldWrites();
  });

  it('is a no-op when the held action has a different request id', async () => {
    const subject = 'pos-base:newer';
    const claim = await claimFreshAction(subject, (requestId) => ({
      requestId,
      label: 'write-2',
    }));
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    const held = claim.record.payload;
    claim.release();
    settleAction(subject, held.requestId, new Error('socket'));
    const before = unknownAction<typeof held>(subject);

    settleAction(
      subject,
      'older-request',
      new ConfirmedRefusalError('سطر الكاشير مش موجود'),
    );
    settleAction(subject, 'older-request');

    expect(hasAction(subject)).toBe(true);
    expect(unknownAction(subject)).toEqual(before);
    expect(before).toEqual(held);
  });

  it('replaces an activation payload and keeps the request id', async () => {
    const subject = 'activation';
    const claim = await claimFreshAction(subject, (requestId) => ({
      requestId,
      manifestHash: 'a'.repeat(32),
      explicitZeroItemIds: ['item-1'],
    }));
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    const held = claim.record.payload;
    claim.release();
    settleAction(subject, held.requestId, new Error('socket'));
    expect(unknownAction(subject)).toEqual(held);

    pinActivationReviewReload(subject, held.requestId);
    const pending = getHeldWrite(subject);
    expect(pending?.awaitingReviewReload).toBe(true);
    if (!pending) throw new Error('expected a pending review');

    replaceActivationPayload(
      subject,
      held.requestId,
      {
        requestId: held.requestId,
        manifestHash: 'b'.repeat(32),
        explicitZeroItemIds: [],
      },
      pending,
    );
    expect(unknownAction(subject)).toBeNull();
    expect(heldAction(subject)).toEqual({
      requestId: held.requestId,
      manifestHash: 'b'.repeat(32),
      explicitZeroItemIds: [],
    });
    expect(hasAction(subject)).toBe(true);
  });
});
