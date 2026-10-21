import type { AllocationDay } from '@/expenses/types';
import { formatIsoDate } from '@/lib/cairo';
import { addMoney, formatEgpText } from '@/lib/money';

const columns = [
  ['fixedShare', 'ثابت'],
  ['dailyTotal', 'يومي'],
  ['driverTotal', 'طيارين'],
  ['interest', 'فوائد'],
  ['depreciation', 'إهلاك'],
  ['total', 'الإجمالي'],
] as const;

function sumColumn(
  days: readonly AllocationDay[],
  key: (typeof columns)[number][0],
): string {
  return days.reduce((total, day) => addMoney(total, day[key]), '0.00');
}

export function AllocationTable({ days }: { days: readonly AllocationDay[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="pb-2 text-start text-lg font-semibold">
          توزيع الشهر
        </caption>
        <thead>
          <tr>
            <th className="border-b px-2 py-1 text-start" scope="col">
              التاريخ
            </th>
            {columns.map(([, label]) => (
              <th
                key={label}
                className="border-b px-2 py-1 text-start"
                scope="col"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.date}>
              <th className="border-b px-2 py-1 text-start" scope="row">
                {formatIsoDate(day.date)}
              </th>
              {columns.map(([key]) => (
                <td key={key} className="border-b px-2 py-1">
                  {formatEgpText(day[key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr aria-label="إجمالي الشهر">
            <th className="px-2 py-1 text-start" scope="row">
              الإجمالي
            </th>
            {columns.map(([key]) => (
              <td key={key} className="px-2 py-1">
                {formatEgpText(sumColumn(days, key))}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
