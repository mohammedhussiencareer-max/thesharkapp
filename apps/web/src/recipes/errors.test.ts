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

  // Migration format: recipe "%" would be invalid at %: % (code, then in recipe / for item)
  const at = '2026-07-15T09:00:00.000000Z';
  const refused = (message: string) => ({ code: '22023', message });
  const marked = (name: string) => `"\u2068${name}\u2069"`;
  const suffix = 'هتبقى غير صالحة في الوقت ده';

  it.each([
    ['cooking_marine', 'وصفة طريقة الطهي مينفعش فيها سمك ولا مأكولات بحرية'],
    ['cycle', 'الوصفة بتدخل في دايرة وبتستخدم نفسها'],
    ['depth_exceeded', 'التحضيرات متداخلة أكتر من اللازم'],
    ['no_version_in_force', 'في تحضيرة مالهاش نسخة سارية في الوقت ده'],
    ['unit_not_convertible', 'وحدة التحضيرة مش متوافقة مع وحدتها في الوصفة'],
  ])(
    'names the parent recipe when a publication fails with %s',
    (code, why) => {
      expect(
        mapRecipeError(
          refused(`recipe "صلصة الطماطم" would be invalid at ${at}: ${code}`),
        ),
      ).toBe(`الوصفة ${marked('صلصة الطماطم')} ${suffix}: ${why}`);
    },
  );

  it.each([
    [
      'no_version_in_force in recipe "Tomato sauce"',
      'في تحضيرة مالهاش نسخة سارية في الوقت ده',
    ],
    [
      'cooking_marine for item "Shrimp"',
      'وصفة طريقة الطهي مينفعش فيها سمك ولا مأكولات بحرية',
    ],
    [
      'unit_not_convertible in recipe "Tomato sauce" for item "Olive oil"',
      'وحدة التحضيرة مش متوافقة مع وحدتها في الوصفة',
    ],
  ])('keeps the parent name for the detail "%s"', (detail, why) => {
    expect(
      mapRecipeError(
        refused(`recipe "Fried rice" would be invalid at ${at}: ${detail}`),
      ),
    ).toBe(`الوصفة ${marked('Fried rice')} ${suffix}: ${why}`);
  });

  it('names the parent for an unknown detail', () => {
    expect(
      mapRecipeError(
        refused(`recipe "Fried rice" would be invalid at ${at}: other`),
      ),
    ).toBe(`الوصفة ${marked('Fried rice')} ${suffix}`);
  });

  it('shows the parent name as plain text, quotes and markup included', () => {
    expect(
      mapRecipeError(
        refused(
          `recipe "<b>5" pan</b> & co" would be invalid at ${at}: cycle in recipe "x"`,
        ),
      ),
    ).toBe(
      `الوصفة ${marked('<b>5" pan</b> & co')} ${suffix}: الوصفة بتدخل في دايرة وبتستخدم نفسها`,
    );
  });

  it('strips control and direction-override characters from the name', () => {
    expect(
      mapRecipeError(
        refused(
          `recipe "a\u202Eb\u2066c\nd\u0000e" would be invalid at ${at}: other`,
        ),
      ),
    ).toBe(`الوصفة ${marked('a b c d e')} ${suffix}`);
  });

  it('falls back to the reason alone when no usable name is present', () => {
    for (const message of [
      `would be invalid at ${at}: cycle`,
      `recipe "  " would be invalid at ${at}: cycle`,
    ]) {
      expect(mapRecipeError(refused(message))).toBe(
        'الوصفة بتدخل في دايرة وبتستخدم نفسها',
      );
    }
    expect(mapRecipeError(refused('recipe would be invalid at later'))).toBe(
      `الوصفة ${suffix}`,
    );
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
