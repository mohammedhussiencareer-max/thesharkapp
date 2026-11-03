import { describe, expect, it } from 'vitest';
import {
  buildDatedWrite,
  defaultEffectiveMode,
  effectiveFromPayload,
  impactLine,
  needsBackdatedReason,
  nextVersionStart,
} from '@/items/effective';

const shift = '2026-07-15T06:00:00.000Z';
const now = Date.parse('2026-07-15T09:00:00.000Z');

describe('effective time', () => {
  it('defaults to the open shift, otherwise now', () => {
    expect(defaultEffectiveMode(shift)).toBe('shift');
    expect(defaultEffectiveMode(null)).toBe('now');
  });

  it('sends null for now and a timestamp for a shift or a picked time', () => {
    expect(effectiveFromPayload('now', shift, null)).toBeNull();
    expect(effectiveFromPayload('shift', shift, null)).toBe(shift);
    expect(
      effectiveFromPayload('custom', shift, '2026-07-01T00:00:00.000Z'),
    ).toBe('2026-07-01T00:00:00.000Z');
  });

  it('requires a reason only when the chosen instant is earlier than now', () => {
    expect(needsBackdatedReason('now', shift, null, now)).toBe(false);
    expect(needsBackdatedReason('shift', shift, null, now)).toBe(true);
    expect(
      needsBackdatedReason('custom', null, '2026-08-01T00:00:00.000Z', now),
    ).toBe(false);
    expect(
      needsBackdatedReason('custom', null, '2026-07-01T00:00:00.000Z', now),
    ).toBe(true);
  });

  it('requires a reason for an explicit or shift start inside the current minute', () => {
    const submitted = Date.parse('2026-07-15T09:00:45.000Z');
    const sameMinute = '2026-07-15T09:00:30.000Z';
    expect(needsBackdatedReason('now', sameMinute, null, submitted)).toBe(
      false,
    );
    expect(needsBackdatedReason('shift', sameMinute, null, submitted)).toBe(
      true,
    );
    expect(needsBackdatedReason('custom', null, sameMinute, submitted)).toBe(
      true,
    );

    const versions: {
      effectiveFrom: string;
      effectiveTo: string | null;
    }[] = [];
    const explicit = buildDatedWrite({
      mode: 'custom',
      shiftStart: null,
      customIso: sameMinute,
      versions,
      nowIso: '2026-07-15T09:00:45.000Z',
      token: 'token',
      reason: '',
      requestId: 'req-same-minute',
    });
    expect(explicit).toEqual({
      ok: false,
      error: 'اكتب سبب التغيير بأثر رجعي',
    });

    const shiftStart = buildDatedWrite({
      mode: 'shift',
      shiftStart: sameMinute,
      customIso: null,
      versions,
      nowIso: '2026-07-15T09:00:45.000Z',
      token: 'token',
      reason: '',
      requestId: 'req-shift-minute',
    });
    expect(shiftStart).toEqual({
      ok: false,
      error: 'اكتب سبب التغيير بأثر رجعي',
    });

    const serverNow = buildDatedWrite({
      mode: 'now',
      shiftStart: sameMinute,
      customIso: null,
      versions,
      nowIso: '2026-07-15T09:00:45.000Z',
      token: 'token',
      reason: '',
      requestId: 'req-now-minute',
    });
    expect(serverNow.ok && serverNow.write.effectiveFrom).toBeNull();
    expect(serverNow.ok && serverNow.write.reason).toBeNull();
    expect(serverNow.ok && serverNow.write.effectiveTo).toBeNull();
  });

  it('keeps the end of a finite version the edit starts inside', () => {
    const versions = [
      {
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: '2026-06-01T00:00:00.000Z',
      },
      {
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        effectiveTo: null,
      },
    ];
    const written = buildDatedWrite({
      mode: 'custom',
      shiftStart: null,
      customIso: '2026-03-01T00:00:00.000Z',
      versions,
      nowIso: '2026-07-15T09:00:00.000Z',
      token: 'token',
      reason: 'تصحيح',
      requestId: 'req-finite',
    });
    expect(written.ok && written.write.effectiveTo).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('stays open when the edit starts inside an open version', () => {
    const versions = [
      {
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
      },
    ];
    expect(
      nextVersionStart(versions, null, '2026-07-15T09:00:00.000Z'),
    ).toBeNull();
    const written = buildDatedWrite({
      mode: 'custom',
      shiftStart: null,
      customIso: '2026-08-01T00:00:00.000Z',
      versions,
      nowIso: '2026-07-15T09:00:00.000Z',
      token: 'token',
      reason: '',
      requestId: 'req-open',
    });
    expect(written.ok && written.write.effectiveTo).toBeNull();
  });

  it('stops at the next version when the edit starts inside a gap', () => {
    const versions = [
      {
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: '2026-03-01T00:00:00.000Z',
      },
      {
        effectiveFrom: '2026-06-01T00:00:00.000Z',
        effectiveTo: '2026-08-01T00:00:00.000Z',
      },
    ];
    const written = buildDatedWrite({
      mode: 'custom',
      shiftStart: null,
      customIso: '2026-04-01T00:00:00.000Z',
      versions,
      nowIso: '2026-07-15T09:00:00.000Z',
      token: 'token',
      reason: 'تصحيح',
      requestId: 'req-gap',
    });
    expect(written.ok && written.write.effectiveTo).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('refuses a backdated write without a reason and keeps the next version', () => {
    const versions = [
      {
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        effectiveTo: null,
      },
    ];
    const missing = buildDatedWrite({
      mode: 'shift',
      shiftStart: shift,
      customIso: null,
      versions,
      nowIso: '2026-07-15T09:00:00.000Z',
      token: 'token',
      reason: '  ',
      requestId: 'req-1',
    });
    expect(missing).toEqual({
      ok: false,
      error: 'اكتب سبب التغيير بأثر رجعي',
    });

    const kept = buildDatedWrite({
      mode: 'custom',
      shiftStart: null,
      customIso: '2026-07-01T00:00:00.000Z',
      versions,
      nowIso: '2026-07-15T09:00:00.000Z',
      token: 'token',
      reason: 'تصحيح',
      requestId: 'req-1',
    });
    expect(kept).toEqual({
      ok: true,
      write: {
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        effectiveTo: '2026-08-01T00:00:00.000Z',
        token: 'token',
        reason: 'تصحيح',
        requestId: 'req-1',
      },
    });
  });

  it('ends a now edit at the current minute so a sub-minute gap stays empty', () => {
    const versions = [
      {
        effectiveFrom: '2026-07-15T09:00:00.000Z',
        effectiveTo: '2026-07-15T09:00:30.000Z',
      },
      {
        effectiveFrom: '2026-07-15T09:01:00.000Z',
        effectiveTo: null,
      },
    ];
    const written = buildDatedWrite({
      mode: 'now',
      shiftStart: null,
      customIso: null,
      versions,
      nowIso: '2026-07-15T09:00:45.000Z',
      token: 'token',
      reason: '',
      requestId: 'req-subminute',
    });
    expect(written).toEqual({
      ok: true,
      write: {
        effectiveFrom: null,
        effectiveTo: '2026-07-15T09:00:30.000Z',
        token: 'token',
        reason: null,
        requestId: 'req-subminute',
      },
    });
  });

  it('sends a null start and no reason for now', () => {
    expect(impactLine(3, 1)).toBe('ممكن يأثر على 3 طلب في 1 وردية (تقدير)');
    const written = buildDatedWrite({
      mode: 'now',
      shiftStart: shift,
      customIso: null,
      versions: [],
      nowIso: '2026-07-15T09:00:00.000Z',
      token: 'token',
      reason: 'مش محتاج',
      requestId: 'req-2',
    });
    expect(written.ok && written.write.effectiveFrom).toBeNull();
    expect(written.ok && written.write.reason).toBeNull();
  });
});
