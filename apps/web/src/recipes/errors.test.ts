import { describe, expect, it } from 'vitest';
import { costingChangedMessage, genericCatalogError } from '@/items/errors';
import { isDuplicateRecipeName, mapRecipeError } from '@/recipes/errors';

describe('mapRecipeError', () => {
  it('maps the sqlstates', () => {
    expect(mapRecipeError({ code: '40001' })).toBe(costingChangedMessage);
    expect(mapRecipeError({ code: '42501' })).toBe(
      'المالك بس يقدر يعمل التغيير ده',
    );
    expect(mapRecipeError({ code: '23514', message: 'x' })).toBe(
      'التغيير ده مش مسموح',
    );
  });

  it('names a duplicate only for the exact recipe name constraint', () => {
    const duplicate = {
      code: '23505',
      message:
        'duplicate key value violates unique constraint "recipes_name_key"',
    };
    expect(isDuplicateRecipeName(duplicate)).toBe(true);
    expect(mapRecipeError(duplicate)).toBe('الاسم ده موجود قبل كده');
    for (const other of [
      { code: '23505' },
      {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "costing_changes_request_id_key"',
      },
      {
        code: '23505',
        message: 'x',
        details: 'Key (name)=("recipes_name_key") already exists.',
      },
      { code: '23514', message: duplicate.message },
    ]) {
      expect(isDuplicateRecipeName(other)).toBe(false);
      expect(mapRecipeError(other)).not.toBe('الاسم ده موجود قبل كده');
    }
  });

  it('falls back for anything unrecognised', () => {
    expect(mapRecipeError(null)).toBe(genericCatalogError);
    expect(mapRecipeError('boom')).toBe(genericCatalogError);
    expect(mapRecipeError({ code: 'XX000', message: 'boom' })).toBe(
      genericCatalogError,
    );
  });

  it.each([
    ['cooking_marine', 'وصفة طريقة الطهي مينفعش فيها سمك ولا مأكولات بحرية'],
    ['cycle', 'الوصفة بتدخل في دايرة وبتستخدم نفسها'],
    ['depth_exceeded', 'التحضيرات متداخلة أكتر من اللازم'],
    ['no_version_in_force', 'في تحضيرة مالهاش نسخة سارية في الوقت ده'],
    ['unit_not_convertible', 'وحدة التحضيرة مش متوافقة مع وحدتها في الوصفة'],
  ])('maps a refused publication with %s', (code, message) => {
    expect(
      mapRecipeError({
        code: '23514',
        message: `recipe would be invalid at 2026-07-15T09:00:00+00:00: ${code}`,
      }),
    ).toBe(message);
  });

  it('maps a publication refusal that names a recipe or item', () => {
    expect(
      mapRecipeError({
        code: '23514',
        message:
          'recipe would be invalid at 2026-07-15T09:00:00+00:00: cooking_marine for item "x"',
      }),
    ).toBe('وصفة طريقة الطهي مينفعش فيها سمك ولا مأكولات بحرية');
  });

  it('uses a generic publication message for an unknown detail', () => {
    expect(
      mapRecipeError({
        code: '23514',
        message: 'recipe would be invalid at 2026-07-15T09:00:00+00:00: other',
      }),
    ).toBe('الوصفة هتبقى غير صالحة في الوقت ده');
  });

  it('prefixes the row a line error names', () => {
    expect(
      mapRecipeError({
        code: '22023',
        message: 'quantity in line 3 must be greater than 0',
      }),
    ).toBe('سطر 3: الكمية لازم تكون رقم أكبر من صفر');
    expect(
      mapRecipeError({
        code: '22023',
        message: 'line 2 cannot be a recipe leaf',
      }),
    ).toBe('سطر 2: التغليف والسمك المخلوط مينفعوش يبقوا مكوّن في وصفة');
  });

  it('maps writer rules without a row', () => {
    expect(
      mapRecipeError({ code: 'P0001', message: 'reason is required' }),
    ).toBe('اكتب سبب التغيير بأثر رجعي');
    expect(
      mapRecipeError({
        code: 'P0001',
        message: 'name must be 1 to 120 characters',
      }),
    ).toBe('الاسم لازم يكون من حرف لحد 120 حرف');
    expect(
      mapRecipeError({ code: 'P0001', message: 'lines must not be empty' }),
    ).toBe('ضيف مكوّن واحد على الأقل أو وقّف الوصفة من الوقت ده');
  });
});
