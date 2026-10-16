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

export function formatFactorInput(value: number): string {
  if (!Number.isFinite(value)) return '';
  return value.toLocaleString('en-US', {
    maximumFractionDigits: 9,
    useGrouping: false,
  });
}
