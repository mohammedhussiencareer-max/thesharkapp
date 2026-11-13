import { beforeEach, describe, expect, it } from 'vitest';
import { ConfirmedRefusalError } from '@/items/errors';
import {
  beginAction,
  hasAction,
  heldAction,
  replaceActivationPayload,
  resetHeldWrites,
  settleAction,
  unknownAction,
} from '@/items/request-id';

describe('settleAction', () => {
  beforeEach(() => {
    resetHeldWrites();
  });

  it('is a no-op when the held action has a different request id', () => {
    const subject = 'pos-base:newer';
    const held = beginAction(subject, (requestId) => ({
      requestId,
      label: 'write-2',
    }));
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

  it('replaces an activation payload and keeps the request id', () => {
    const subject = 'activation';
    const held = beginAction(subject, (requestId) => ({
      requestId,
      manifestHash: 'a'.repeat(32),
      explicitZeroItemIds: ['item-1'],
    }));
    settleAction(subject, held.requestId, new Error('socket'));
    expect(unknownAction(subject)).toEqual(held);

    replaceActivationPayload(subject, held.requestId, {
      requestId: held.requestId,
      manifestHash: 'b'.repeat(32),
      explicitZeroItemIds: [],
    });
    expect(unknownAction(subject)).toBeNull();
    expect(heldAction(subject)).toEqual({
      requestId: held.requestId,
      manifestHash: 'b'.repeat(32),
      explicitZeroItemIds: [],
    });
    expect(hasAction(subject)).toBe(true);
  });
});
