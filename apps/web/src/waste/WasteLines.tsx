import { factorSourceLabel, moneyText, unitCodeLabel } from '@/waste/format';

export type LineView = {
  lineNo: number;
  name: string;
  inputQuantity: string;
  inputUnit: string;
  factor: string;
  factorSource: string;
  baseUnit: string;
  baseQuantity: string;
  value?: string;
};

function Num({ value }: { value: string }) {
  return <span dir="ltr">{value}</span>;
}

/** Lines with the conversion the server saved, so a later change never rewrites them. */
export function WasteLines({
  lines,
  label,
}: {
  lines: readonly LineView[];
  label: string;
}) {
  return (
    <ul className="flex flex-col gap-1" aria-label={label}>
      {lines.map((line) => (
        <li key={line.lineNo}>
          {line.name} — <Num value={line.inputQuantity} />{' '}
          {unitCodeLabel(line.inputUnit)}
          {line.inputUnit !== line.baseUnit ? (
            <>
              {' = '}
              <Num value={line.baseQuantity} /> {unitCodeLabel(line.baseUnit)} (
              {factorSourceLabel(line.factorSource)}، المعامل{' '}
              <Num value={line.factor} />)
            </>
          ) : null}
          {line.value !== undefined ? (
            <>
              {' — '}القيمة <Num value={moneyText(line.value)} />
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
