import { describe, expect, it } from 'vitest';
import { sameEditor } from '@/items/editor';

describe('sameEditor', () => {
  it('closes only the editor that started the save', () => {
    const started = { type: 'edit' as const, id: 'mixed' };
    expect(sameEditor(started, started)).toBe(true);
    expect(sameEditor({ type: 'edit', id: 'size' }, started)).toBe(false);
    expect(sameEditor({ type: 'create' }, started)).toBe(false);
    expect(sameEditor(null, started)).toBe(false);
    expect(sameEditor({ type: 'create' }, { type: 'create' })).toBe(true);
  });
});
