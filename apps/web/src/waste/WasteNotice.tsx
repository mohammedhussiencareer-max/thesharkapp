import { DifferencesList } from '@/order-decisions/DifferencesList';
import type { WasteKind, WasteNotice } from '@/waste/types';
import { WasteLines } from '@/waste/WasteLines';

const savedMessages: Record<WasteKind, string> = {
  record: 'اتسجل الهالك',
  correction: 'اتصحّح الهالك — اتسجل سجل جديد بدل القديم',
  void: 'اتلغى سجل الهالك',
};

/** The outcome of the last action, with the exact differences the server computed. */
export function WasteNoticeView({
  notice,
  names,
}: {
  notice: WasteNotice;
  names: Readonly<Record<string, string>>;
}) {
  if (notice.kind === 'failed') {
    return (
      <div className="flex flex-col gap-1" role="alert">
        <p>{notice.message}</p>
        {notice.itemIds && notice.itemIds.length > 0 ? (
          <ul aria-label="أصناف من غير تكلفة">
            {notice.itemIds.map((id) => (
              <li key={id}>{names[id] ?? id}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  const { result, warning } = notice;
  return (
    <div className="flex flex-col gap-2" role="status">
      <p>{savedMessages[result.kind]}</p>
      {result.lines.length > 0 ? (
        <WasteLines
          label="السطور المسجلة"
          lines={result.lines.map((line) => ({
            ...line,
            name: names[line.itemId] ?? line.itemId,
          }))}
        />
      ) : null}
      <DifferencesList
        differences={result.differences}
        label="الفروق الناتجة"
      />
      {warning ? <p role="alert">{warning}</p> : null}
    </div>
  );
}
