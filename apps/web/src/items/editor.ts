export type ItemEditor = { type: 'create' } | { type: 'edit'; id: string };

export function sameEditor(
  current: ItemEditor | null,
  started: ItemEditor,
): boolean {
  if (!current || current.type !== started.type) return false;
  if (current.type === 'edit' && started.type === 'edit') {
    return current.id === started.id;
  }
  return true;
}
