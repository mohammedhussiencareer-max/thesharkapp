import { beforeEach, describe, expect, it } from 'vitest';
import { ConfirmedRefusalError } from '@/items/errors';
import {
  beginAction,
  hasAction,
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
});
