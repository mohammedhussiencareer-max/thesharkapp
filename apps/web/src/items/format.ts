function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function formatQty(value: number): string {
  const rounded = Math.round(finite(value) * 1000) / 1000;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  return normalized.toLocaleString('en-US', {
    maximumFractionDigits: 3,
    useGrouping: false,
  });
}

export function formatEgp(value: number): string {
  const rounded = Math.round(finite(value) * 100) / 100;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  return `${normalized.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  })} ج.م`;
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
