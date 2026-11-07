import { currentShiftStart } from '@/items/api';
import {
  ConfirmedRefusalError,
  CostingChangedError,
  genericCatalogError,
} from '@/items/errors';
import type { Json } from '@/lib/database.types';
import { exactDecimalOrNull } from '@/lib/decimal';
import { keysAfterFilter, readAllByKey, readAllByKeys } from '@/lib/paged';
import { supabase } from '@/lib/supabase';
import { isDefiniteRefusal, isPayloadRefusal } from '@/lib/write-outcome';
import { mapMappingError } from '@/mapping/errors';
import {
  isMapStatus,
  isMappingFamily,
  isOptionPolicy,
  isTargetKind,
  type BaseMappingWrite,
  type Coverage,
  type OrderCoverage,
  type OrderTypeCoverage,
  type ExceptionWrite,
  type HistoryRow,
  type LineResolution,
  type MappingCatalog,
  type MappingTarget,
  type ObservedBase,
  type ObservedOption,
  type OptionBinding,
  type OptionMappingWrite,
  type PolicyWrite,
  type ScheduleVersion,
  type SizeKey,
  type SubjectDetail,
  type SubjectSchedule,
  type Suggestion,
} from '@/mapping/types';
import { canonicalOrderTypeKey } from '@/packaging/format';
import { loadBasePackaging } from '@/packaging/api';
import { listRecipes, listStockOptions, listUnitsMeta } from '@/recipes/api';

function appDb() {
  if (!supabase) throw new Error(genericCatalogError);
  return supabase.schema('app');
}

type PostgrestError = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
};

function throwIfError(error: PostgrestError | null): void {
  if (!error) return;
  if (error.code === '40001' && error.message === 'configuration changed') {
    throw new CostingChangedError();
  }
  const message = mapMappingError(error);
  if (isPayloadRefusal(error)) throw new ConfirmedRefusalError(message);
  const mapped = new Error(message);
  if (isDefiniteRefusal(error)) Object.assign(mapped, { code: error.code });
  throw mapped;
}

function nullableText(value: string | null): string {
  return value as unknown as string;
}

function nullableJson(value: Json | null): Json {
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(genericCatalogError);
  }
  return value as Record<string, unknown>;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(genericCatalogError);
  return value.map(record);
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(genericCatalogError);
  return value;
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(genericCatalogError);
  }
  return value;
}

function countOf(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(genericCatalogError);
}

function ratioOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(genericCatalogError);
  }
  return value;
}

/** Requirement quantities are already rounded to 6 places. */
function plainDecimal(value: unknown): string {
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) {
    return value.trim();
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(genericCatalogError);
  }
  const text = String(value);
  if (!/e/i.test(text)) return text;
  return value.toFixed(20).replace(/\.?0+$/, '');
}

export const historyVersionColumns =
  'id, family, effective_from, effective_to, target_kind, recipe_id, stock_item_id, quantity_per_basis_text:quantity_per_basis::text, unit_code, exception_reason, option_policy, superseded_change_id';

/** Mapping quantities stay exact decimal text. A JSON number is refused. */
export function readMappingQuantity(value: unknown): string | null {
  if (value === undefined) return null;
  return exactDecimalOrNull(value, genericCatalogError);
}

function mappingQuantity(row: Record<string, unknown>): string | null {
  if (Object.prototype.hasOwnProperty.call(row, 'quantity_per_basis_text')) {
    return readMappingQuantity(row.quantity_per_basis_text);
  }
  return readMappingQuantity(row.quantity_per_basis);
}

export function sizeKeyOf(value: unknown): SizeKey {
  if (Array.isArray(value) && value.length === 1 && value[0] === 'none') {
    return ['none'];
  }
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value[0] === 'name' &&
    typeof value[1] === 'string' &&
    value[1].trim().length > 0
  ) {
    return ['name', value[1]];
  }
  throw new Error(genericCatalogError);
}

function versionOf(value: unknown): ScheduleVersion {
  const row = record(value);
  const family = requiredText(row.family);
  if (!isMappingFamily(family)) throw new Error(genericCatalogError);
  const targetKind = textOrNull(row.target_kind);
  if (targetKind !== null && !isTargetKind(targetKind)) {
    throw new Error(genericCatalogError);
  }
  const policy = textOrNull(row.option_policy);
  if (policy !== null && !isOptionPolicy(policy)) {
    throw new Error(genericCatalogError);
  }
  return {
    id: requiredText(row.id),
    family,
    effectiveFrom: requiredText(row.effective_from),
    effectiveTo: textOrNull(row.effective_to),
    targetKind,
    recipeId: textOrNull(row.recipe_id),
    stockItemId: textOrNull(row.stock_item_id),
    quantityPerBasis: mappingQuantity(row),
    unitCode: textOrNull(row.unit_code),
    exceptionReason: textOrNull(row.exception_reason),
    optionPolicy: policy,
  };
}

function scheduleOf(value: unknown): SubjectSchedule {
  const row = record(value);
  if (typeof row.token !== 'string' || typeof row.empty_token !== 'string') {
    throw new Error(genericCatalogError);
  }
  return {
    subjectId: textOrNull(row.subject_id),
    token: row.token,
    emptyToken: row.empty_token,
    versions: rows(row.versions).map((version) => versionOf(version)),
  };
}

function targetJson(target: MappingTarget | null): Json | null {
  if (target === null) return null;
  if (target.kind === 'recipe') return { recipe_id: target.recipeId };
  if (target.kind === 'unmapped' || target.kind === 'no_stock') {
    return { disposition: target.kind };
  }
  return {
    stock_item_id: target.stockItemId,
    quantity_per_basis: target.quantity.trim(),
    unit: target.unit,
  };
}

const baseKeys = ['pos_item_id', 'size_key_text'] as const;

export async function loadBases(): Promise<ObservedBase[]> {
  const list = await readAllByKeys<
    {
      pos_item_id: string;
      size_key: unknown;
      size_key_text: string;
      item_name: string | null;
      sale_count: number | string;
      last_ordered_at: string;
      latest_order_id: string;
      latest_line_id: string;
      map_status: string;
    },
    'pos_item_id' | 'size_key_text'
  >(
    baseKeys,
    (after, size) => {
      const query = appDb()
        .from('pos_observed_bases')
        .select(
          'pos_item_id, size_key, size_key_text, item_name, sale_count, last_ordered_at, latest_order_id, latest_line_id, map_status',
        );
      return (
        after === null ? query : query.or(keysAfterFilter(baseKeys, after))
      )
        .order('pos_item_id')
        .order('size_key_text')
        .limit(size);
    },
    genericCatalogError,
  );
  return list.map((row) => {
    if (!isMapStatus(row.map_status)) throw new Error(genericCatalogError);
    return {
      posItemId: row.pos_item_id,
      sizeKey: sizeKeyOf(row.size_key),
      sizeKeyText: row.size_key_text,
      itemName: row.item_name ?? '',
      saleCount: countOf(row.sale_count),
      lastOrderedAt: row.last_ordered_at,
      latestOrderId: row.latest_order_id,
      latestLineId: row.latest_line_id,
      mapStatus: row.map_status,
    };
  });
}

const optionKeys = ['pos_item_id', 'size_key_text', 'option_value'] as const;

async function loadOptions(base: ObservedBase): Promise<ObservedOption[]> {
  const list = await readAllByKeys<
    {
      pos_item_id: string;
      size_key_text: string;
      option_value: string;
      seen_count: number | string;
    },
    'pos_item_id' | 'size_key_text' | 'option_value'
  >(
    optionKeys,
    (after, size) => {
      const query = appDb()
        .from('pos_observed_options')
        .select('pos_item_id, size_key_text, option_value, seen_count')
        .eq('pos_item_id', base.posItemId)
        .eq('size_key_text', base.sizeKeyText);
      return (
        after === null ? query : query.or(keysAfterFilter(optionKeys, after))
      )
        .order('pos_item_id')
        .order('size_key_text')
        .order('option_value')
        .limit(size);
    },
    genericCatalogError,
  );
  return list.map((row) => ({
    posItemId: row.pos_item_id,
    sizeKeyText: row.size_key_text,
    optionValue: row.option_value,
    seenCount: countOf(row.seen_count),
  }));
}

export async function loadCoverage(
  fromIso: string,
  toIso: string,
): Promise<Coverage> {
  const { data, error } = await appDb().rpc('pos_mapping_coverage', {
    p_from: fromIso,
    p_to: toIso,
  });
  throwIfError(error);
  const row = record(data);
  const causes = record(row.causes);
  return {
    stockStart: textOrNull(row.stock_start),
    eligibleLines: countOf(row.eligible_lines),
    coveredLines: countOf(row.covered_lines),
    readyLines: countOf(row.ready_lines),
    incompleteLines: countOf(row.incomplete_lines),
    exceptionLines: countOf(row.exception_lines),
    coverage: ratioOf(row.coverage),
    causes: {
      canceled: countOf(causes.canceled),
      open: countOf(causes.open),
      missing: countOf(causes.missing),
      beforeStockStart: countOf(causes.before_stock_start),
    },
    orders: orderCoverageOf(row.orders),
    orderTypes: rows(row.order_types).map(orderTypeCoverageOf),
  };
}

function excludedOf(value: unknown): Coverage['causes'] {
  const row = record(value);
  return {
    canceled: countOf(row.canceled),
    open: countOf(row.open),
    missing: countOf(row.missing),
    beforeStockStart: countOf(row.before_stock_start),
  };
}

function orderCoverageOf(value: unknown): OrderCoverage {
  const row = record(value);
  const causes = record(row.causes);
  return {
    eligible: countOf(row.eligible),
    ready: countOf(row.ready),
    incomplete: countOf(row.incomplete),
    coverage: ratioOf(row.coverage),
    causes: {
      line: countOf(causes.line),
      packagingUnreviewed: countOf(causes.packaging_unreviewed),
      blocked: countOf(causes.blocked),
    },
    excluded: excludedOf(row.excluded),
  };
}

function orderTypeCoverageOf(
  value: Record<string, unknown>,
): OrderTypeCoverage {
  const key = canonicalOrderTypeKey(value.order_type_key);
  if (!key) throw new Error(genericCatalogError);
  const label = value.label;
  if (label !== null && typeof label !== 'string') {
    throw new Error(genericCatalogError);
  }
  return {
    key,
    label,
    seen: countOf(value.seen),
    eligible: countOf(value.eligible),
    covered: countOf(value.covered),
    unreviewed: countOf(value.unreviewed),
    blocked: countOf(value.blocked),
    coverage: ratioOf(value.coverage),
  };
}

export async function loadCatalog(): Promise<MappingCatalog> {
  const [recipes, items, units, shiftStart] = await Promise.all([
    listRecipes(),
    listStockOptions(),
    listUnitsMeta(),
    currentShiftStart(),
  ]);
  return {
    recipes: recipes.flatMap((recipe) =>
      recipe.kind === 'dish' || recipe.kind === 'cooking'
        ? [{ id: recipe.id, name: recipe.name, kind: recipe.kind }]
        : [],
    ),
    items: items
      .filter((item) => item.kind !== 'packaging' && item.kind !== 'fish_mixed')
      .map((item) => ({
        id: item.id,
        name: item.name,
        baseUnit: item.baseUnit,
      })),
    packagingItems: items
      .filter((item) => item.kind === 'packaging')
      .map((item) => ({
        id: item.id,
        name: item.name,
        baseUnit: item.baseUnit,
      })),
    units: units
      .map((unit) => ({ code: unit.code, label: unit.labelAr }))
      .sort((left, right) => left.label.localeCompare(right.label, 'ar')),
    shiftStart,
  };
}

async function loadBaseSchedule(base: ObservedBase): Promise<SubjectSchedule> {
  const { data, error } = await appDb().rpc('pos_base_schedule', {
    p_pos_item_id: base.posItemId,
    p_size_key: base.sizeKey,
  });
  throwIfError(error);
  return scheduleOf(data);
}

async function loadOptionSchedule(
  scope: 'global' | 'item',
  posItemId: string | null,
  sizeKey: SizeKey | null,
  optionValue: string,
): Promise<SubjectSchedule> {
  const { data, error } = await appDb().rpc('pos_option_schedule', {
    p_scope: scope,
    p_pos_item_id: nullableText(posItemId),
    p_size_key: nullableJson(sizeKey),
    p_option_value: optionValue,
  });
  throwIfError(error);
  return scheduleOf(data);
}

async function loadSuggestions(name: string): Promise<Suggestion[]> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return [];
  const { data, error } = await appDb().rpc('suggest_pos_mappings', {
    p_name: trimmed,
  });
  throwIfError(error);
  return rows(data).map((row) => {
    const via = row.via;
    if (via !== 'name' && via !== 'binding') {
      throw new Error(genericCatalogError);
    }
    return {
      recipeId: requiredText(row.recipe_id),
      name: requiredText(row.name),
      via,
    };
  });
}

async function loadResolution(base: ObservedBase): Promise<LineResolution> {
  const { data, error } = await appDb().rpc('resolve_line_requirements', {
    p_order_id: base.latestOrderId,
    p_line_id: base.latestLineId,
  });
  throwIfError(error);
  const row = record(data);
  if (typeof row.status !== 'string' || !isMapStatus(row.status)) {
    throw new Error(genericCatalogError);
  }
  const requirements =
    row.requirements === null || row.requirements === undefined
      ? []
      : rows(row.requirements).map((entry) => {
          if (
            typeof entry.stock_item_id !== 'string' ||
            typeof entry.base_unit !== 'string'
          ) {
            throw new Error(genericCatalogError);
          }
          return {
            stockItemId: entry.stock_item_id,
            baseUnit: entry.base_unit,
            quantity: plainDecimal(entry.quantity),
          };
        });
  return {
    status: row.status,
    issues: rows(row.issues).map((issue) => {
      if (typeof issue.code !== 'string') throw new Error(genericCatalogError);
      return { code: issue.code, expandIssue: textOrNull(issue.expand_issue) };
    }),
    requirements,
  };
}

async function loadHistory(subjectId: string): Promise<HistoryRow[]> {
  const list = await readAllByKey<{
    id: string;
    family: string;
    effective_from: string;
    effective_to: string | null;
    target_kind: string | null;
    recipe_id: string | null;
    stock_item_id: string | null;
    quantity_per_basis_text: string | null;
    unit_code: string | null;
    exception_reason: string | null;
    option_policy: string | null;
    superseded_change_id: number | null;
  }>((afterId, size) => {
    const query = appDb()
      .from('pos_map_versions')
      .select(historyVersionColumns)
      .eq('subject_id', subjectId);
    return (afterId === null ? query : query.gt('id', afterId))
      .order('id')
      .limit(size);
  }, genericCatalogError);
  return list
    .map((row) => {
      const version = versionOf(row);
      return { ...version, superseded: row.superseded_change_id !== null };
    })
    .sort((left, right) => {
      const from = right.effectiveFrom.localeCompare(left.effectiveFrom);
      if (from !== 0) return from;
      return right.id.localeCompare(left.id);
    });
}

export async function loadSubjectDetail(
  base: ObservedBase,
): Promise<SubjectDetail> {
  const [schedule, options, suggestions, resolution, packaging] =
    await Promise.all([
      loadBaseSchedule(base),
      loadOptions(base),
      loadSuggestions(base.itemName),
      loadResolution(base),
      loadBasePackaging(base.posItemId, base.sizeKey),
    ]);
  const optionBindings: OptionBinding[] = [];
  for (const option of options) {
    if (option.optionValue.trim().length === 0) continue;
    const [globalSchedule, itemSchedule] = await Promise.all([
      loadOptionSchedule('global', null, null, option.optionValue),
      loadOptionSchedule(
        'item',
        base.posItemId,
        base.sizeKey,
        option.optionValue,
      ),
    ]);
    optionBindings.push(
      {
        scope: 'global',
        optionValue: option.optionValue,
        schedule: globalSchedule,
      },
      {
        scope: 'item',
        optionValue: option.optionValue,
        schedule: itemSchedule,
      },
    );
  }
  const history = schedule.subjectId
    ? await loadHistory(schedule.subjectId)
    : [];
  const optionHistory = [];
  for (const binding of optionBindings) {
    if (!binding.schedule.subjectId) continue;
    optionHistory.push({
      subjectId: binding.schedule.subjectId,
      rows: await loadHistory(binding.schedule.subjectId),
    });
  }
  return {
    schedule,
    options,
    optionBindings,
    suggestions,
    history,
    optionHistory,
    resolution,
    packaging,
  };
}

export async function setBaseMapping(write: BaseMappingWrite): Promise<void> {
  const { error } = await appDb().rpc('set_pos_base_mapping', {
    p_request_id: write.requestId,
    p_pos_item_id: write.posItemId,
    p_size_key: write.sizeKey,
    p_effective_from: nullableText(write.effectiveFrom),
    p_effective_to: nullableText(write.effectiveTo),
    p_target: nullableJson(targetJson(write.target)),
    p_expected_token: write.token,
    p_reason: nullableText(write.reason),
  });
  throwIfError(error);
}

export async function setOptionPolicy(write: PolicyWrite): Promise<void> {
  const { error } = await appDb().rpc('set_pos_option_policy', {
    p_request_id: write.requestId,
    p_pos_item_id: write.posItemId,
    p_size_key: write.sizeKey,
    p_effective_from: nullableText(write.effectiveFrom),
    p_effective_to: nullableText(write.effectiveTo),
    p_policy: nullableText(write.policy),
    p_expected_token: write.token,
    p_reason: nullableText(write.reason),
  });
  throwIfError(error);
}

export async function setException(write: ExceptionWrite): Promise<void> {
  const { error } = await appDb().rpc('set_pos_exception', {
    p_request_id: write.requestId,
    p_pos_item_id: write.posItemId,
    p_size_key: write.sizeKey,
    p_effective_from: nullableText(write.effectiveFrom),
    p_effective_to: nullableText(write.effectiveTo),
    p_exception_reason: nullableText(write.exceptionReason),
    p_expected_token: write.token,
    p_reason: nullableText(write.reason),
  });
  throwIfError(error);
}

export async function setOptionMapping(
  write: OptionMappingWrite,
): Promise<void> {
  const { error } = await appDb().rpc('set_pos_option_mapping', {
    p_request_id: write.requestId,
    p_scope: write.scope,
    p_pos_item_id: nullableText(write.posItemId),
    p_size_key: nullableJson(write.sizeKey),
    p_option_value: write.optionValue,
    p_effective_from: nullableText(write.effectiveFrom),
    p_effective_to: nullableText(write.effectiveTo),
    p_target: nullableJson(targetJson(write.target)),
    p_expected_token: write.token,
    p_reason: nullableText(write.reason),
  });
  throwIfError(error);
}
