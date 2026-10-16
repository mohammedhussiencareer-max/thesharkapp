const qtyFormat = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 3,
  useGrouping: false,
});

const egpFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false,
});

function finite(value: number): number {
  if (!Number.isFinite(value) || Object.is(value, -0)) return 0;
  return value;
}

export function formatQty(value: number): string {
  return qtyFormat.format(finite(value));
}

/** Display text for a stored numeric, keeping every significant digit. */
export function formatStoredFactor(value: number | string): string {
  const raw = typeof value === 'string' ? value.trim() : String(value);
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return raw;
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const parts = unsigned.split('.');
  const whole = parts[0] ?? '0';
  const fraction = parts[1] ?? '';
  const trimmedFraction = fraction.replace(/0+$/, '');
  const body =
    trimmedFraction.length > 0
      ? `${whole}.${trimmedFraction}`
      : whole.replace(/^0+(?=\d)/, '');
  return negative ? `-${body}` : body;
}

export function formatEgp(value: number): string {
  return `${egpFormat.format(finite(value))} ج.م`;
}

export function formatLossPercent(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%';
  const percent = Math.round(fraction * 100000) / 1000;
  return `${percent.toLocaleString('en-US', {
    maximumFractionDigits: 3,
    useGrouping: false,
  })}%`;
}
