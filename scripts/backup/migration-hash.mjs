import { createHash } from 'node:crypto';
import { BackupError } from './config.mjs';

// Migration SQL reaches the history in different shapes: the hosted
// apply_migration stores the query as one chunk, the CLI stores one element per
// statement with the outer semicolon removed. normalizeSql reduces every shape
// to the same list of statements. It changes only what cannot change meaning:
// whitespace and comments between tokens (one space where there was any), and
// the top-level ";" that ends a statement (empty statements are dropped).
// Single-quoted strings (E'..' with backslash escapes), double-quoted
// identifiers and dollar-quoted bodies are kept byte for byte, so "a b" and
// "ab" stay different.
//
// String continuation follows the PostgreSQL 17 lexer (scan.l): two string
// constants separated only by whitespace with at least one newline (line
// comments allowed, block comments not) are one constant, and the first
// segment's mode (E'..' backslash escapes) applies to every segment. The
// segments are kept as written and joined by one newline.
//
// Anything that cannot be lexed with confidence keeps the element's raw text in
// the hash (RAW_PREFIX), so a change there is never normalised away: an
// unterminated string, comment or dollar quote, adjacent string constants that
// are not a valid continuation, a NUL character, or any mention of
// standard_conforming_strings (the lexer assumes it is on, the default). Such
// SQL is invalid or unusual, so the cost is a false mismatch, never a false match.
// Hashing happens here and only here: the SQL side returns the raw statements.

export const RAW_PREFIX = '\u0000raw:';

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
const HORIZONTAL = new Set([' ', '\t', '\f']);
const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_CONT = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_DELIMITER = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;
const STRING_START = /(?:[eEbBxXnN]|[uU]&)?'/y;

class Unconfident extends Error {}

function isNewline(c) {
  return c === '\n' || c === '\r';
}

function endOfLineComment(text, start) {
  let i = start + 2;
  while (i < text.length && !isNewline(text[i])) {
    i += 1;
  }
  return i;
}

function endOfBlockComment(text, start) {
  let depth = 1;
  let i = start + 2;
  while (i < text.length && depth > 0) {
    if (text[i] === '/' && text[i + 1] === '*') {
      depth += 1;
      i += 2;
    } else if (text[i] === '*' && text[i + 1] === '/') {
      depth -= 1;
      i += 2;
    } else {
      i += 1;
    }
  }
  if (depth > 0) {
    throw new Unconfident();
  }
  return i;
}

// Returns the index after the closing quote.
function endOfQuoted(text, start, quote, backslashEscapes) {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (backslashEscapes && c === '\\') {
      i += 2;
    } else if (c === quote) {
      if (text[i + 1] === quote) {
        i += 2;
      } else {
        return i + 1;
      }
    } else {
      i += 1;
    }
  }
  throw new Unconfident();
}

function endOfDollarQuoted(text, start) {
  DOLLAR_DELIMITER.lastIndex = start;
  const found = DOLLAR_DELIMITER.exec(text);
  if (!found) {
    return null;
  }
  const delimiter = found[0];
  const close = text.indexOf(delimiter, start + delimiter.length);
  if (close === -1) {
    throw new Unconfident();
  }
  return close + delimiter.length;
}

// scan.l: whitespace_with_newline = horiz_whitespace* newline
// special_whitespace*, then a quote. horiz_whitespace is [ \t\f] or a "--"
// comment; special_whitespace is any whitespace or a "--" comment ending in a
// newline. Returns the index of the next segment's quote, or -1.
function continuationQuote(text, from) {
  let i = from;
  while (i < text.length) {
    if (HORIZONTAL.has(text[i])) {
      i += 1;
    } else if (text[i] === '-' && text[i + 1] === '-') {
      i = endOfLineComment(text, i);
    } else {
      break;
    }
  }
  if (!isNewline(text[i])) {
    return -1;
  }
  i += 1;
  while (i < text.length) {
    if (WHITESPACE.has(text[i])) {
      i += 1;
    } else if (text[i] === '-' && text[i + 1] === '-') {
      i = endOfLineComment(text, i);
      if (i >= text.length) {
        return -1;
      }
      i += 1;
    } else {
      break;
    }
  }
  return text[i] === "'" ? i : -1;
}

// True when another string constant follows through whitespace or comments of
// any kind: a valid continuation was already handled, so this is not valid SQL.
function adjacentStringFollows(text, from) {
  let i = from;
  while (i < text.length) {
    if (WHITESPACE.has(text[i])) {
      i += 1;
    } else if (text[i] === '-' && text[i + 1] === '-') {
      i = endOfLineComment(text, i);
    } else if (text[i] === '/' && text[i + 1] === '*') {
      i = endOfBlockComment(text, i);
    } else {
      break;
    }
  }
  STRING_START.lastIndex = i;
  return i > from && STRING_START.test(text);
}

// A string constant from `start` (its prefix, if any) whose quote is at
// `quote`, with its continuation segments. Returns { end, piece }.
function scanString(text, start, quote, backslashEscapes) {
  const pieces = [];
  let from = start;
  let open = quote;
  for (;;) {
    const end = endOfQuoted(text, open, "'", backslashEscapes);
    pieces.push(text.slice(from, end));
    const next = continuationQuote(text, end);
    if (next === -1) {
      if (adjacentStringFollows(text, end)) {
        throw new Unconfident();
      }
      return { end, piece: pieces.join('\n') };
    }
    from = next;
    open = next;
  }
}

function lex(text) {
  const statements = [];
  let current = '';
  let gap = false;
  const emit = (piece) => {
    if (gap && current !== '') {
      current += ' ';
    }
    gap = false;
    current += piece;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (WHITESPACE.has(c)) {
      gap = true;
      i += 1;
    } else if (c === '-' && next === '-') {
      i = endOfLineComment(text, i);
      gap = true;
    } else if (c === '/' && next === '*') {
      i = endOfBlockComment(text, i);
      gap = true;
    } else if (c === ';') {
      if (current !== '') {
        statements.push(current);
      }
      current = '';
      gap = false;
      i += 1;
    } else if (c === "'") {
      const { end, piece } = scanString(text, i, i, false);
      emit(piece);
      i = end;
    } else if (c === '"') {
      const end = endOfQuoted(text, i, '"', false);
      emit(text.slice(i, end));
      i = end;
    } else if (IDENT_START.test(c)) {
      let end = i + 1;
      while (end < text.length && IDENT_CONT.test(text[end])) {
        end += 1;
      }
      const word = text.slice(i, end);
      if ((word === 'E' || word === 'e') && text[end] === "'") {
        const scanned = scanString(text, i, end, true);
        emit(scanned.piece);
        i = scanned.end;
      } else {
        emit(word);
        i = end;
      }
    } else if (c === '$') {
      const end = endOfDollarQuoted(text, i);
      if (end === null) {
        emit(c);
        i += 1;
      } else {
        emit(text.slice(i, end));
        i = end;
      }
    } else {
      emit(c);
      i += 1;
    }
  }
  if (current !== '') {
    statements.push(current);
  }
  return statements;
}

export function normalizeSql(text) {
  if (text.includes('\u0000') || /standard_conforming_strings/i.test(text)) {
    return [RAW_PREFIX + text];
  }
  try {
    return lex(text);
  } catch (error) {
    if (error instanceof Unconfident) {
      return [RAW_PREFIX + text];
    }
    throw error;
  }
}

export function normalizeStatements(statements) {
  return statements.flatMap((statement) => normalizeSql(statement ?? ''));
}

// md5 is a fingerprint here, not a security control.
export function hashStatements(statements) {
  return createHash('md5')
    .update(JSON.stringify(normalizeStatements(statements)), 'utf8')
    .digest('hex');
}

// rows: [{ version, name, statements }] as read from schema_migrations.
export function hashMigrationRows(rows, label, code) {
  if (!Array.isArray(rows)) {
    throw new BackupError(code, `${label} returned no migration rows`);
  }
  return rows.map((row) => {
    const { version, name, statements } = row ?? {};
    if (
      typeof version !== 'string' ||
      typeof name !== 'string' ||
      !Array.isArray(statements) ||
      statements.some((s) => s !== null && typeof s !== 'string')
    ) {
      throw new BackupError(
        code,
        `${label} returned a malformed migration row`,
      );
    }
    return { version, name, hash: hashStatements(statements) };
  });
}
