import { ConfirmedRefusalError, StaleWriteError } from '@/items/errors';
import {
  abortClaimBeforeDispatch,
  canDispatchHeldWrite,
  claimFreshHeldWrite,
  claimReplayHeldWrite,
  clearHeldWrite,
  getHeldWrite,
  hasDurableHeldWrite,
  listHeldWritesByPrefix,
  listReloadMarkers,
  setHeldWritePhase,
  setReloadMarker,
  updateHeldWritePayload,
  type ClaimHeldWriteResult,
  type HeldWriteKind,
  type WriteSession,
} from '@/lib/held-writes';
import { isDefiniteRefusal } from '@/lib/write-outcome';

/**
 * Durable envelope for request-less writes (writes whose server RPC/statement
 * has no client `p_request_id`). Stores only the minimal intent needed to
 * compare server state / replay, plus a monotonic attempt counter so older
 * reads or verifications can never apply to a newer attempt.
 */
export type RequestlessEnvelope<TIntent> = {
  intent: TIntent;
  attempt: number;
  acknowledged?: true;
};

export type RequestlessPin<TIntent> = {
  subject: string;
  requestId: string;
  attempt: number;
  phase: 'unknown' | 'inflight';
  acknowledged: boolean;
  intent: TIntent;
  target: string;
};

export type RequestlessReadSnapshot<TIntent> = ReadonlyArray<
  RequestlessPin<TIntent>
>;

export type RequestlessApplyResult = {
  reconciledSubjects: ReadonlySet<string>;
  settledAcknowledgedSubjects: ReadonlySet<string>;
  absentSubjects: ReadonlySet<string>;
};

export type RequestlessFailureOutcome =
  | { status: 'definite_refusal' }
  | { status: 'reconciled_saved' }
  | { status: 'stale_conflict' }
  | { status: 'ambiguous_absent' }
  | { status: 'ambiguous_unverified' };

export type RequestlessReconcilerConfig<TIntent, TServerState> = {
  prefixes: readonly string[];
  reloadSubject: string;
  isIntent: (value: unknown) => value is TIntent;
  /** Target string covered by reads (e.g. 'items:reload', '2026-01-01', or '*'). */
  targetOf: (intent: TIntent) => string;
  /** Target stored on the reload marker; omit/undefined when reloadSubject itself is the sole target. */
  markerTargetOf?: (intent: TIntent) => string | undefined;
  /** True iff `serverState` already reflects `intent`. */
  matchesServerState: (serverState: TServerState, intent: TIntent) => boolean;
  /** Optional React notification hook called whenever verification or acknowledgement state changes. */
  onChange?: () => void;
};

function extractSqlState(error: unknown): string {
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return '';
    if (seen.has(current)) return '';
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim() !== '') return code.trim();
    current = (current as { cause?: unknown }).cause;
  }
  return '';
}

/**
 * Definitive server refusals for REQUEST-LESS writes (no client `request_id`
 * exists in the DB, so SQLSTATE `23505` is a real uniqueness violation rather
 * than a `request_id` replay race, alongside `22xxx`, `23xxx`, `P0001`,
 * `42501`, `40001`, `40P01`, `55000`, `0A000`, and `ConfirmedRefusalError`).
 * `StaleWriteError` (0-row compare-and-set) is intentionally excluded so
 * callers verify server state before reporting conflict.
 */
export function isRequestlessDefiniteRefusal(error: unknown): boolean {
  if (error instanceof StaleWriteError) return false;
  if (error instanceof ConfirmedRefusalError) return true;
  if (isDefiniteRefusal(error)) return true;
  return extractSqlState(error) === '23505';
}

function defaultTargetMatches(
  pinTarget: string,
  loadedTarget: string | undefined,
): boolean {
  if (pinTarget === '*') return true;
  if (loadedTarget === undefined) return true;
  return pinTarget === loadedTarget;
}

export function createRequestlessReconciler<TIntent, TServerState>(
  config: RequestlessReconcilerConfig<TIntent, TServerState>,
) {
  // Attempt-scoped absence verification: belongs strictly to ONE (requestId, attempt).
  const verifiedAbsent = new Map<
    string,
    { requestId: string; attempt: number }
  >();
  // In-memory tracking of acknowledged claims whose reload marker could not be
  // written to localStorage (quota). Keyed by subject.
  const acknowledgedClaims = new Map<
    string,
    { requestId: string; attempt: number; target: string }
  >();

  function notify(): void {
    config.onChange?.();
  }

  function packPayload(
    intent: TIntent,
    attempt: number,
    acknowledged?: true,
  ): RequestlessEnvelope<TIntent> {
    return {
      intent,
      attempt,
      ...(acknowledged ? { acknowledged: true } : {}),
    };
  }

  function unwrapPayload(raw: unknown): {
    intent: TIntent;
    attempt: number;
    acknowledged: boolean;
  } | null {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Partial<RequestlessEnvelope<unknown>>;
      if ('intent' in obj && config.isIntent(obj.intent)) {
        const attempt =
          typeof obj.attempt === 'number' &&
          Number.isInteger(obj.attempt) &&
          obj.attempt >= 1
            ? obj.attempt
            : 1;
        return {
          intent: obj.intent,
          attempt,
          acknowledged: obj.acknowledged === true,
        };
      }
    }
    if (config.isIntent(raw)) {
      return { intent: raw, attempt: 1, acknowledged: false };
    }
    return null;
  }

  function isAcknowledged(
    subject: string,
    requestId: string,
    attempt: number,
    payloadAck: boolean,
  ): boolean {
    if (payloadAck) return true;
    const entry = acknowledgedClaims.get(subject);
    return (
      entry !== undefined &&
      entry.requestId === requestId &&
      entry.attempt === attempt
    );
  }

  function listRecoverablePins(): RequestlessPin<TIntent>[] {
    const found: RequestlessPin<TIntent>[] = [];
    for (const prefix of config.prefixes) {
      for (const record of listHeldWritesByPrefix(prefix)) {
        if (record.phase !== 'unknown' && record.phase !== 'inflight') {
          continue;
        }
        const unwrapped = unwrapPayload(record.payload);
        if (!unwrapped) continue;
        const ack = isAcknowledged(
          record.subject,
          record.requestId,
          unwrapped.attempt,
          unwrapped.acknowledged,
        );
        if (record.phase === 'inflight' && !ack) continue;
        found.push({
          subject: record.subject,
          requestId: record.requestId,
          attempt: unwrapped.attempt,
          phase: record.phase,
          acknowledged: ack,
          intent: unwrapped.intent,
          target: config.targetOf(unwrapped.intent),
        });
      }
    }
    return found;
  }

  function hasAcknowledgedClaim(target?: string): boolean {
    for (const pin of listRecoverablePins()) {
      if (!pin.acknowledged) continue;
      if (target === undefined || defaultTargetMatches(pin.target, target)) {
        return true;
      }
    }
    return false;
  }

  function outstandingTargets(excludeTarget?: string): string[] {
    const targets = new Set<string>();
    for (const marker of listReloadMarkers(config.reloadSubject)) {
      if (
        marker.target &&
        marker.target !== '*' &&
        marker.target !== excludeTarget
      ) {
        targets.add(marker.target);
      }
    }
    for (const pin of listRecoverablePins()) {
      if (
        pin.target &&
        pin.target !== '*' &&
        pin.target !== config.reloadSubject &&
        pin.target !== excludeTarget
      ) {
        targets.add(pin.target);
      }
    }
    return [...targets];
  }

  function canReplay(pin: RequestlessPin<TIntent>): boolean {
    if (pin.phase !== 'unknown' || pin.acknowledged) return false;
    const checked = verifiedAbsent.get(pin.subject);
    return (
      checked !== undefined &&
      checked.requestId === pin.requestId &&
      checked.attempt === pin.attempt
    );
  }

  function invalidateForDispatch(subject: string): void {
    const removed = verifiedAbsent.delete(subject);
    if (removed) notify();
  }

  function snapshotBeforeRead(
    loadedTarget?: string,
  ): RequestlessReadSnapshot<TIntent> {
    return listRecoverablePins().filter((pin) =>
      defaultTargetMatches(pin.target, loadedTarget),
    );
  }

  function applyReadResult(
    snapshot: RequestlessReadSnapshot<TIntent>,
    serverState: TServerState,
    loadedTarget?: string,
  ): RequestlessApplyResult {
    const reconciledSubjects = new Set<string>();
    const settledAcknowledgedSubjects = new Set<string>();
    const absentSubjects = new Set<string>();
    let stateChanged = false;

    for (const snap of snapshot) {
      if (!defaultTargetMatches(snap.target, loadedTarget)) {
        continue;
      }
      // Re-check live record: subject, requestId, phase, and attempt MUST all match.
      const current = getHeldWrite(snap.subject);
      if (
        !current ||
        current.subject !== snap.subject ||
        current.requestId !== snap.requestId ||
        current.phase !== snap.phase
      ) {
        continue;
      }
      const unwrapped = unwrapPayload(current.payload);
      if (!unwrapped || unwrapped.attempt !== snap.attempt) {
        continue;
      }
      const currentlyAck = isAcknowledged(
        current.subject,
        current.requestId,
        unwrapped.attempt,
        unwrapped.acknowledged,
      );
      if (currentlyAck !== snap.acknowledged) {
        continue;
      }

      if (snap.acknowledged) {
        // Post-acknowledgement read succeeded for the exact acknowledged claim.
        clearHeldWrite(snap.subject, snap.requestId);
        if (acknowledgedClaims.delete(snap.subject)) stateChanged = true;
        if (verifiedAbsent.delete(snap.subject)) stateChanged = true;
        settledAcknowledgedSubjects.add(snap.subject);
        continue;
      }

      if (config.matchesServerState(serverState, snap.intent)) {
        clearHeldWrite(snap.subject, snap.requestId);
        if (verifiedAbsent.delete(snap.subject)) stateChanged = true;
        reconciledSubjects.add(snap.subject);
      } else {
        const prev = verifiedAbsent.get(snap.subject);
        if (
          !prev ||
          prev.requestId !== snap.requestId ||
          prev.attempt !== snap.attempt
        ) {
          verifiedAbsent.set(snap.subject, {
            requestId: snap.requestId,
            attempt: snap.attempt,
          });
          stateChanged = true;
        }
        absentSubjects.add(snap.subject);
      }
    }

    if (stateChanged) notify();
    return {
      reconciledSubjects,
      settledAcknowledgedSubjects,
      absentSubjects,
    };
  }

  function applyReadFailure(snapshot: RequestlessReadSnapshot<TIntent>): void {
    let changed = false;
    for (const snap of snapshot) {
      const checked = verifiedAbsent.get(snap.subject);
      if (
        checked &&
        checked.requestId === snap.requestId &&
        checked.attempt === snap.attempt
      ) {
        verifiedAbsent.delete(snap.subject);
        changed = true;
      }
    }
    if (changed) notify();
  }

  function markAcknowledged(
    subject: string,
    requestId: string,
    intent: TIntent,
    attempt: number,
  ): { markerPersisted: boolean } {
    const markerTarget = config.markerTargetOf
      ? config.markerTargetOf(intent)
      : undefined;
    const markerPersisted = setReloadMarker(
      config.reloadSubject,
      markerTarget,
      requestId,
    );
    const removedAbsent = verifiedAbsent.delete(subject);
    if (markerPersisted) {
      clearHeldWrite(subject, requestId);
      const removedAck = acknowledgedClaims.delete(subject);
      if (removedAbsent || removedAck) notify();
      return { markerPersisted: true };
    }
    // Quota failure storing marker: keep the exact acknowledged inflight claim
    // so a subsequent post-acknowledgement read settles it cleanly.
    acknowledgedClaims.set(subject, {
      requestId,
      attempt,
      target: config.targetOf(intent),
    });
    try {
      updateHeldWritePayload(
        subject,
        requestId,
        packPayload(intent, attempt, true),
      );
    } catch {
      // Storage may still be at quota; original durable inflight claim stays intact.
    }
    notify();
    return { markerPersisted: false };
  }

  async function claimFresh(
    subject: string,
    kind: HeldWriteKind,
    intent: TIntent,
    session: WriteSession | null,
  ): Promise<
    | {
        ok: true;
        requestId: string;
        attempt: number;
        releaseOnce: () => void;
      }
    | {
        ok: false;
        reason: Extract<ClaimHeldWriteResult<unknown>, { ok: false }>['reason'];
      }
  > {
    invalidateForDispatch(subject);
    const attempt = 1;
    const claim = await claimFreshHeldWrite<RequestlessEnvelope<TIntent>>(
      subject,
      () => packPayload(intent, attempt),
      { kind, session },
    );
    if (!claim.ok) {
      return { ok: false, reason: claim.reason };
    }
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        claim.release();
      }
    };
    return {
      ok: true,
      requestId: claim.record.requestId,
      attempt,
      releaseOnce,
    };
  }

  async function claimReplay(
    pin: RequestlessPin<TIntent>,
    session: WriteSession | null,
  ): Promise<
    | {
        ok: true;
        requestId: string;
        attempt: number;
        intent: TIntent;
        releaseOnce: () => void;
      }
    | {
        ok: false;
        reason: Extract<ClaimHeldWriteResult<unknown>, { ok: false }>['reason'];
      }
  > {
    invalidateForDispatch(pin.subject);
    const nextAttempt = pin.attempt + 1;
    const claim = await claimReplayHeldWrite<RequestlessEnvelope<TIntent>>(
      pin.subject,
      pin.requestId,
      {
        payload: packPayload(pin.intent, nextAttempt),
        session,
      },
    );
    if (!claim.ok) {
      return { ok: false, reason: claim.reason };
    }
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        claim.release();
      }
    };
    return {
      ok: true,
      requestId: claim.record.requestId,
      attempt: nextAttempt,
      intent: pin.intent,
      releaseOnce,
    };
  }

  function verifyCanDispatchOrAbort(
    subject: string,
    requestId: string,
    priorPhase: 'unknown' | null,
    session: WriteSession | null,
    releaseOnce: () => void,
  ): { ok: true } | { ok: false; missingPin: boolean } {
    if (canDispatchHeldWrite(subject, requestId, session)) {
      return { ok: true };
    }
    const missingPin = !hasDurableHeldWrite(subject, requestId);
    abortClaimBeforeDispatch(subject, requestId, priorPhase, releaseOnce);
    return { ok: false, missingPin };
  }

  /**
   * Shared failure settlement for request-less writes:
   * - Definite server refusal (including 23505, 22xxx, 23xxx, 42501) -> clear pin, no replay.
   * - StaleWriteError (0-row compare-and-set) -> re-read and settle from verified state
   *   (intent present -> saved; absent -> clear pin and report real conflict).
   * - Ambiguous failure -> keep `unknown`, snapshot before targeted read, apply result
   *   (or invalidate verification on failed read).
   */
  async function settleFailure(params: {
    subject: string;
    requestId: string;
    target: string;
    error: unknown;
    releaseOnce: () => void;
    readState: () => Promise<TServerState | null>;
    onReadData: (data: TServerState) => void;
    loadedTargetOf: (data: TServerState) => string | undefined;
  }): Promise<RequestlessFailureOutcome> {
    const {
      subject,
      requestId,
      target,
      error,
      releaseOnce,
      readState,
      onReadData,
      loadedTargetOf,
    } = params;

    if (isRequestlessDefiniteRefusal(error)) {
      clearHeldWrite(subject, requestId);
      if (verifiedAbsent.delete(subject)) notify();
      releaseOnce();
      return { status: 'definite_refusal' };
    }

    const isStale = error instanceof StaleWriteError;
    setHeldWritePhase(subject, requestId, 'unknown');
    if (verifiedAbsent.delete(subject)) notify();
    releaseOnce();

    const snap = snapshotBeforeRead(target);
    try {
      const fresh = await readState();
      if (fresh === null) {
        applyReadFailure(snap);
        return { status: 'ambiguous_unverified' };
      }
      onReadData(fresh);
      const outcome = applyReadResult(snap, fresh, loadedTargetOf(fresh));
      if (outcome.reconciledSubjects.has(subject)) {
        return { status: 'reconciled_saved' };
      }
      if (isStale) {
        // Re-read proved the intended edit did NOT land (real concurrent conflict).
        clearHeldWrite(subject, requestId);
        if (verifiedAbsent.delete(subject)) notify();
        return { status: 'stale_conflict' };
      }
      return { status: 'ambiguous_absent' };
    } catch {
      applyReadFailure(snap);
      return { status: 'ambiguous_unverified' };
    }
  }

  return {
    packPayload,
    unwrapPayload,
    listRecoverablePins,
    hasAcknowledgedClaim,
    outstandingTargets,
    canReplay,
    invalidateForDispatch,
    snapshotBeforeRead,
    applyReadResult,
    applyReadFailure,
    markAcknowledged,
    claimFresh,
    claimReplay,
    verifyCanDispatchOrAbort,
    settleFailure,
  };
}
