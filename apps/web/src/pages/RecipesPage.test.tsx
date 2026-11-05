import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginAction,
  hasAction,
  resetHeldWrites,
  settleAction,
  unknownSaveMessage,
} from '@/items/request-id';
import { RecipesPage } from '@/pages/RecipesPage';
import { createRecipe, listRecipes } from '@/recipes/api';
import { recipeCreateSubject } from '@/recipes/subjects';
import type { RecipeSummary } from '@/recipes/types';

const mocks = vi.hoisted(() => ({ schema: vi.fn() }));

vi.mock('@/lib/supabase', () => ({ supabase: { schema: mocks.schema } }));

vi.mock('@/recipes/api', () => ({
  listRecipes: vi.fn(),
  createRecipe: vi.fn(),
}));

async function useRealCreate(rpcError: { code: string; message: string }) {
  const actual =
    await vi.importActual<typeof import('@/recipes/api')>('@/recipes/api');
  vi.mocked(createRecipe).mockImplementation(actual.createRecipe);
  const rpc = vi.fn().mockResolvedValue({ data: null, error: rpcError });
  mocks.schema.mockReturnValue({ rpc });
  return rpc;
}

function requestIds(rpc: ReturnType<typeof vi.fn>): string[] {
  return rpc.mock.calls.map(
    (call) => (call[1] as { p_request_id: string }).p_request_id,
  );
}

const recipes: RecipeSummary[] = [
  {
    id: 'dish-1',
    name: 'طبق تجريبي',
    kind: 'dish',
    active: true,
    inForce: true,
  },
  {
    id: 'cook-1',
    name: 'طهي تجريبي',
    kind: 'cooking',
    active: true,
    inForce: false,
  },
  {
    id: 'batch-1',
    name: 'صلصة تجريبية',
    kind: 'batch',
    active: false,
    inForce: true,
  },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/recipes']}>
      <Routes>
        <Route path="/recipes" element={<RecipesPage />} />
        <Route path="/recipes/:recipeId" element={<p>صفحة الوصفة</p>} />
        <Route path="/" element={<p>الرئيسية</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function renderList(rows: RecipeSummary[] = recipes) {
  vi.mocked(listRecipes).mockResolvedValue(rows);
  renderPage();
  await screen.findByRole('form', { name: 'وصفة جديدة' });
}

describe('RecipesPage', () => {
  beforeEach(() => {
    resetHeldWrites();
    vi.mocked(listRecipes).mockReset();
    vi.mocked(createRecipe).mockReset();
    mocks.schema.mockReset();
  });

  it('lists each recipe with its kind, state and whether a version is in force', async () => {
    await renderList();
    const list = screen.getByRole('list', { name: 'الوصفات' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(
      within(rows[0]!).getByRole('link', { name: 'طبق تجريبي' }),
    ).toHaveAttribute('href', '/recipes/dish-1');
    expect(within(rows[0]!).getByText('طبق')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('النسخة: متحددة')).toBeInTheDocument();
    expect(
      within(rows[1]!).getByText('طريقة طهي لكل كيلو'),
    ).toBeInTheDocument();
    expect(
      within(rows[1]!).getByText('النسخة: مش متحددة دلوقتي'),
    ).toBeInTheDocument();
    expect(within(rows[2]!).getByText('تحضيرة — موقوفة')).toBeInTheDocument();
  });

  it('shows an empty state when there are no recipes', async () => {
    await renderList([]);
    expect(
      screen.getByText('لسه مفيش وصفات — ضيف أول وصفة'),
    ).toBeInTheDocument();
  });

  it('filters by kind and by name', async () => {
    await renderList();
    fireEvent.change(screen.getByLabelText('تصفية بالنوع'), {
      target: { value: 'batch' },
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(
      screen.getByRole('link', { name: 'صلصة تجريبية' }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('تصفية بالنوع'), {
      target: { value: 'all' },
    });
    fireEvent.change(screen.getByLabelText('بحث بالاسم'), {
      target: { value: 'طهي' },
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(
      screen.getByRole('link', { name: 'طهي تجريبي' }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('بحث بالاسم'), {
      target: { value: 'مفيش' },
    });
    expect(screen.getByText('مفيش وصفات مطابقة')).toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'الوصفات' }),
    ).not.toBeInTheDocument();
  });

  it('creates a recipe and opens its page', async () => {
    vi.mocked(createRecipe).mockResolvedValue('new-id');
    await renderList();
    fireEvent.change(screen.getByLabelText('اسم الوصفة الجديدة'), {
      target: { value: '  صلصة جديدة  ' },
    });
    fireEvent.change(screen.getByLabelText('نوع الوصفة الجديدة'), {
      target: { value: 'batch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف وصفة' }));
    await screen.findByText('صفحة الوصفة');
    expect(createRecipe).toHaveBeenCalledTimes(1);
    expect(createRecipe).toHaveBeenCalledWith('صلصة جديدة', 'batch');
  });

  it('refuses an empty name without calling the server', async () => {
    await renderList();
    fireEvent.click(screen.getByRole('button', { name: 'ضيف وصفة' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'الاسم لازم يكون من حرف لحد 120 حرف',
    );
    expect(createRecipe).not.toHaveBeenCalled();
  });

  it('lets the owner correct a duplicate name after the real create is refused', async () => {
    const rpc = await useRealCreate({
      code: '23505',
      message:
        'duplicate key value violates unique constraint "recipes_name_key"',
    });
    await renderList();
    fireEvent.change(screen.getByLabelText('اسم الوصفة الجديدة'), {
      target: { value: 'طبق تجريبي' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف وصفة' }));
    expect(
      await screen.findByText('الاسم ده موجود قبل كده'),
    ).toBeInTheDocument();
    expect(screen.queryByText(unknownSaveMessage)).not.toBeInTheDocument();
    expect(screen.getByLabelText('اسم الوصفة الجديدة')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'ضيف وصفة' })).toBeEnabled();
    expect(hasAction(recipeCreateSubject('طبق تجريبي', 'dish'))).toBe(false);

    fireEvent.change(screen.getByLabelText('اسم الوصفة الجديدة'), {
      target: { value: 'طبق تجريبي 2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف وصفة' }));
    await waitFor(() => {
      expect(rpc).toHaveBeenCalledTimes(2);
    });
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({ p_name: 'طبق تجريبي 2' });
    expect(new Set(requestIds(rpc)).size).toBe(2);
  });

  it('keeps the form locked when the request id itself collided', async () => {
    const rpc = await useRealCreate({
      code: '23505',
      message:
        'duplicate key value violates unique constraint "costing_changes_request_id_key"',
    });
    await renderList();
    fireEvent.change(screen.getByLabelText('اسم الوصفة الجديدة'), {
      target: { value: 'طبق جديد' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف وصفة' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('اسم الوصفة الجديدة')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(rpc).toHaveBeenCalledTimes(2);
    });
    const [first, second] = requestIds(rpc);
    expect(second).toBe(first);
  });

  it('shows the server message and lets the owner fix a refused create', async () => {
    vi.mocked(createRecipe).mockRejectedValueOnce(
      new Error('الاسم لازم يكون من حرف لحد 120 حرف'),
    );
    await renderList();
    fireEvent.change(screen.getByLabelText('اسم الوصفة الجديدة'), {
      target: { value: 'طبق تجريبي' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف وصفة' }));
    expect(
      await screen.findByText('الاسم لازم يكون من حرف لحد 120 حرف'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('اسم الوصفة الجديدة')).toBeEnabled();
  });

  it('locks the form after an unknown outcome and retries the same create only', async () => {
    vi.mocked(createRecipe)
      .mockImplementationOnce((name, kind) => {
        const subject = recipeCreateSubject(name, kind);
        beginAction(subject, (id) => id);
        const failure = new Error('تعذر الاتصال');
        settleAction(subject, failure);
        return Promise.reject(failure);
      })
      .mockResolvedValueOnce('new-id');
    await renderList();
    fireEvent.change(screen.getByLabelText('اسم الوصفة الجديدة'), {
      target: { value: 'طبق جديد' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف وصفة' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('اسم الوصفة الجديدة')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ضيف وصفة' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await screen.findByText('صفحة الوصفة');
    expect(createRecipe).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createRecipe).mock.calls[1]).toEqual(
      vi.mocked(createRecipe).mock.calls[0],
    );
  });

  it('shows a load error with a retry', async () => {
    vi.mocked(listRecipes).mockRejectedValueOnce(new Error('تعذر الاتصال'));
    vi.mocked(listRecipes).mockResolvedValueOnce(recipes);
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('تعذر الاتصال');
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(3);
    });
  });
});
