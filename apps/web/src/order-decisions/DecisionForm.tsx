import { useEffect, useRef, useState } from 'react';
import { messageFrom } from '@/items/errors';
import {
  abortActionBeforeDispatch,
  canDispatchAction,
  claimFreshAction,
  claimReplayAction,
  clearActionPostedReload,
  hasAction,
  hasDurableAction,
  markActionPostedReload,
  settleAction,
  subscribeHeldWrites,
  unknownAction,
} from '@/items/request-id';
import { UnknownSave } from '@/items/UnknownSave';
import {
  captureWriteSession,
  storageWriteFailedMessage,
  type WriteSession,
} from '@/lib/held-writes';
import { isOnline, offlineWriteMessage, useOnline } from '@/lib/online';
import { primaryButton } from '@/lib/page-style';
import { setOrderDisposition } from '@/order-decisions/api';
import { noteDecisionOrder } from '@/order-decisions/held-decisions';
import {
  decisionLabels,
  decisionSubject,
  draftFromReturned,
  keptQuantity,
  returnedFromDraft,
  unitText,
} from '@/order-decisions/format';
import type {
  Decision,
  DecisionNotice,
  DecisionWrite,
  QueueRow,
} from '@/order-decisions/types';

const reasonLimit = 300;

export const reloadFailedMessage =
  'تحديث الشاشة فشل — اضغط تحديث قبل ما تقرر تاني';

export const reasonRequiredMessage = 'اكتب سبب تغيير القرار';

export const reasonTooLongMessage = 'السبب أطول من 300 حرف';

export const returnedReviewMessage = 'راجع الكميات المرتجعة';

const field = 'rounded border border-neutral-300 px-3 py-2';

export type OrderDecisionDraft = {
  choice: Decision;
  reason: string;
  draft: Record<string, string>;
  clearReturned: boolean;
  rowVersion: string;
};

function draftsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

export function DecisionForm({
  row,
  savedDraft,
  onDraftChange,
  onNotice,
  onChanged,
}: {
  row: QueueRow;
  savedDraft?: OrderDecisionDraft;
  onDraftChange?: (orderId: string, next: OrderDecisionDraft | null) => void;
  onNotice: (notice: DecisionNotice | null) => void;
  onChanged: (orderId: string) => Promise<void>;
}) {
  const online = useOnline();
  const subject = decisionSubject(row.orderId);
  const rowVersion = `${row.token}:${row.eventId}`;
  const restored =
    savedDraft && savedDraft.rowVersion === rowVersion ? savedDraft : null;
  const [choice, setChoice] = useState<Decision>(
    () => restored?.choice ?? row.decision,
  );
  const [reason, setReason] = useState(() => restored?.reason ?? '');
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    restored ? { ...restored.draft } : draftFromReturned(row.returned),
  );
  const [clearReturned, setClearReturned] = useState(
    () => restored?.clearReturned ?? false,
  );
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [heldEpoch, setHeldEpoch] = useState(0);
  const flight = useRef(false);
  const held = heldEpoch < 0 ? null : unknownAction<DecisionWrite>(subject);

  useEffect(
    () => subscribeHeldWrites(() => setHeldEpoch((value) => value + 1)),
    [],
  );

  useEffect(() => {
    if (!onDraftChange) return;
    const baseDraft = draftFromReturned(row.returned);
    const dirty =
      choice !== row.decision ||
      reason !== '' ||
      clearReturned ||
      !draftsEqual(draft, baseDraft);
    onDraftChange(
      row.orderId,
      dirty
        ? {
            choice,
            reason,
            draft: { ...draft },
            clearReturned,
            rowVersion,
          }
        : null,
    );
  }, [
    choice,
    clearReturned,
    draft,
    onDraftChange,
    reason,
    row.decision,
    row.orderId,
    row.returned,
    rowVersion,
  ]);

  const unresolved = row.currentClass === 'unresolved_refund';
  const onlyMade = row.currentClass === null;
  const flipping = choice !== row.decision;
  const terminal =
    row.currentClass === 'canceled' ||
    row.currentClass === 'missing' ||
    row.currentClass === 'full_refund';
  const returnsApply =
    (choice === 'not_made' && row.currentClass === 'partial_refund') ||
    (choice === 'made' && terminal && row.returned.length > 0);
  const basisReady = row.basisStatus === 'ready';
  const returnsShown = returnsApply && basisReady;
  const retainedShown = !returnsShown && row.returned.length > 0;
  const clearing = (returnsShown || retainedShown) && clearReturned;
  const parsed =
    returnsShown && !clearReturned
      ? returnedFromDraft(row.basisItems, draft)
      : null;
  const reasonText = reason.trim();
  const reasonProblem = flipping
    ? reasonText.length === 0
      ? reasonRequiredMessage
      : reasonText.length > reasonLimit
        ? reasonTooLongMessage
        : null
    : null;
  const blocked = saving || held !== null || unresolved || !online;

  async function finish(
    action: DecisionWrite,
    session: WriteSession | null,
    isReplay: boolean,
    releaseLock: () => void,
  ): Promise<void> {
    if (
      flight.current ||
      !canDispatchAction(subject, action.requestId, session)
    ) {
      const missingPin = !hasDurableAction(subject, action.requestId);
      abortActionBeforeDispatch(
        subject,
        action.requestId,
        isReplay,
        releaseLock,
      );
      if (!isOnline()) setProblem(offlineWriteMessage);
      else if (missingPin) setProblem(storageWriteFailedMessage);
      return;
    }
    flight.current = true;
    setSaving(true);
    setProblem(null);
    onNotice(null);
    try {
      let saved: Awaited<ReturnType<typeof setOrderDisposition>>;
      let persisted = false;
      try {
        saved = await setOrderDisposition(action);
        persisted = true;
        if (saved.status === 'ok') {
          onDraftChange?.(row.orderId, null);
          markActionPostedReload(subject, action.requestId, subject);
        } else {
          settleAction(subject, action.requestId);
        }
      } catch (failure) {
        if (!persisted) {
          settleAction(subject, action.requestId, failure);
        }
        const message = messageFrom(failure);
        if (persisted || hasAction(subject)) {
          onNotice({ kind: 'failed', message });
          return;
        }
        const warning = await reload();
        onNotice({
          kind: 'failed',
          message: warning ? `${message} — ${warning}` : message,
        });
        return;
      } finally {
        releaseLock();
      }
      const warning = saved.status === 'ok' ? await reload() : null;
      if (saved.status === 'ok' && warning === null) {
        await clearActionPostedReload(subject, subject, action.requestId);
      }
      onNotice({ kind: 'saved', result: saved, warning });
    } finally {
      flight.current = false;
      setSaving(false);
    }
  }

  /** A failed reload never changes the held action; it only warns. */
  async function reload(): Promise<string | null> {
    try {
      await onChanged(row.orderId);
      return null;
    } catch {
      return reloadFailedMessage;
    }
  }

  function submit() {
    if (blocked || hasAction(subject)) return;
    if (reasonProblem) {
      setProblem(reasonProblem);
      return;
    }
    if (parsed && !parsed.ok) {
      setProblem(returnedReviewMessage);
      return;
    }
    const payloadDraft = {
      orderId: row.orderId,
      decision: choice,
      token: row.token,
      reason: flipping ? reasonText : null,
      returned: clearing ? [] : parsed?.ok === true ? parsed.lines : null,
    };
    const session = captureWriteSession();
    void (async () => {
      const claim = await claimFreshAction<DecisionWrite>(
        subject,
        (requestId) => ({
          requestId,
          ...payloadDraft,
        }),
        { session },
      );
      if (!claim.ok) {
        if (claim.reason === 'storage') {
          setProblem(storageWriteFailedMessage);
        } else if (claim.reason === 'session_invalid' && !isOnline()) {
          setProblem(offlineWriteMessage);
        }
        return;
      }
      noteDecisionOrder(row.orderId);
      await finish(claim.record.payload, session, false, claim.release);
    })();
  }

  function retry() {
    if (!held || flight.current || saving || !isOnline()) return;
    const targetId = held.requestId;
    const session = captureWriteSession();
    void (async () => {
      const claim = await claimReplayAction<DecisionWrite>(subject, targetId, {
        session,
      });
      if (!claim.ok) {
        if (claim.reason === 'missing' || claim.reason === 'storage') {
          setProblem(storageWriteFailedMessage);
        } else if (claim.reason === 'session_invalid' && !isOnline()) {
          setProblem(offlineWriteMessage);
        }
        return;
      }
      await finish(claim.record.payload, session, true, claim.release);
    })();
  }

  return (
    <form
      className="flex flex-col gap-3"
      aria-label="القرار"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {unresolved ? (
        <p role="alert">
          فيه مرتجع بمبلغ سالب — لازم يتصلح في الكاشير الأول قبل ما تقرر
        </p>
      ) : null}
      {held ? <UnknownSave disabled={saving} onRetry={retry} /> : null}
      <fieldset className="flex flex-col gap-1" disabled={blocked}>
        <legend className="font-semibold">الطلب اتعمل ولا لأ؟</legend>
        {(['made', 'not_made'] as const).map((value) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="radio"
              name={`decision-${row.orderId}`}
              value={value}
              checked={choice === value}
              disabled={onlyMade && value === 'not_made'}
              onChange={() => setChoice(value)}
            />
            {decisionLabels[value]}
          </label>
        ))}
      </fieldset>
      {onlyMade ? (
        <p>الطلب ده مبقاش ملغي ولا فيه مرتجع — تقدر تأكده بس</p>
      ) : null}
      {flipping ? (
        <label className="flex flex-col gap-1">
          سبب تغيير القرار
          <textarea
            className={field}
            rows={2}
            maxLength={reasonLimit}
            value={reason}
            disabled={blocked}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      ) : null}
      {returnsApply ? (
        basisReady ? (
          <fieldset className="flex flex-col gap-2" disabled={blocked}>
            <legend className="font-semibold">الكميات المرتجعة</legend>
            <p>
              {choice === 'made'
                ? 'اكتب إجمالي اللي رجع لكل صنف. المتبقي هو اللي بيتسجل هالك.'
                : 'اكتب إجمالي اللي رجع لكل صنف. المتبقي هو اللي بيتخصم.'}{' '}
              الحقل الفاضي معناه صفر مؤكد.
            </p>
            {row.returned.length > 0 ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={clearReturned}
                  onChange={(event) => setClearReturned(event.target.checked)}
                />
                امسح الكميات المرتجعة المؤكدة
              </label>
            ) : null}
            {row.basisItems.map((item) => {
              const itemProblem =
                parsed && !parsed.ok ? parsed.errors[item.stockItemId] : null;
              const value = draft[item.stockItemId] ?? '';
              const kept =
                parsed?.ok === true
                  ? keptQuantity(
                      item.quantity,
                      parsed.lines.find(
                        (line) => line.stockItemId === item.stockItemId,
                      )?.returned ?? '0',
                    )
                  : null;
              return (
                <div key={item.stockItemId} className="flex flex-col gap-1">
                  <label className="flex flex-col gap-1">
                    المرتجع من {item.name} ({unitText(item.baseUnit)})
                    <input
                      className={field}
                      inputMode="decimal"
                      dir="ltr"
                      value={value}
                      disabled={clearReturned}
                      aria-invalid={itemProblem ? true : undefined}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          [item.stockItemId]: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <span>
                    المحضّر <span dir="ltr">{item.quantity}</span>
                    {kept !== null ? (
                      <>
                        {' — '}المتبقي <span dir="ltr">{kept}</span>
                      </>
                    ) : null}
                  </span>
                  {itemProblem ? <span role="alert">{itemProblem}</span> : null}
                </div>
              );
            })}
          </fieldset>
        ) : (
          <p>مفيش أساس تحضير جاهز — الكميات المرتجعة مش متاحة</p>
        )
      ) : null}
      {retainedShown ? (
        <fieldset className="flex flex-col gap-2" disabled={blocked}>
          <legend className="font-semibold">الكميات المرتجعة المحفوظة</legend>
          <p>
            الكميات دي مش بتأثر على القرار ده، بس بتتحفظ معاه ولازم تناسب أساس
            التحضير الحالي. لو مبقتش مناسبة امسحها.
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={clearReturned}
              onChange={(event) => setClearReturned(event.target.checked)}
            />
            امسح الكميات المرتجعة المؤكدة
          </label>
        </fieldset>
      ) : null}
      {flipping && reasonProblem ? <p>{reasonProblem}</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}
      <button
        className={primaryButton}
        type="submit"
        disabled={blocked || reasonProblem !== null || parsed?.ok === false}
      >
        {flipping ? 'حفظ القرار' : 'تأكيد القرار'}
      </button>
    </form>
  );
}
