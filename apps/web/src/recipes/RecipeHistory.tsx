import { formatCairo } from '@/lib/cairo';
import type { RecipeSchedule } from '@/recipes/types';

export function RecipeHistory({ schedule }: { schedule: RecipeSchedule }) {
  return (
    <section className="flex flex-col gap-2" aria-label="سجل النسخ">
      <h2 className="text-xl font-semibold">سجل النسخ</h2>
      {schedule.versions.length === 0 ? (
        <p>لسه مفيش نسخ للوصفة دي</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {schedule.versions.map((version) => (
            <li key={version.id}>
              {`من ${formatCairo(version.effectiveFrom)}${
                version.effectiveTo
                  ? ` إلى ${formatCairo(version.effectiveTo)}`
                  : ' وبعدها'
              } — ${version.lines.length} مكوّن`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
