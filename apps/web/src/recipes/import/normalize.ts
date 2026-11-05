const invisible = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const tatweel = /\u0640/g;
const diacritics = /[\u064B-\u065F\u0670]/g;
const alefForms = /[\u0622\u0623\u0625\u0671]/g;

/** Trim and collapse every run of whitespace to one space. */
export function collapseSpaces(text: string): string {
  return text.replace(invisible, '').replace(/\s+/g, ' ').trim();
}

/**
 * The key used to suggest matches and to bind a source name. Tatweel and
 * diacritics go, alef forms fold to alef and alef maksura folds to yeh.
 * Teh marbuta and heh stay distinct. A suggestion only: nothing is approved
 * because two names normalise alike.
 */
export function normalizeName(text: string): string {
  return collapseSpaces(text)
    .replace(tatweel, '')
    .replace(diacritics, '')
    .replace(alefForms, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}
