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
// "ab" stay different. Assumes standard_conforming_strings = on, the default.
// Hashing happens here and only here: the SQL side returns the raw statements.

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_CONT = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_DELIMITER = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;

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
  return i;
}

// Returns the index after the closing quote (or the end if it never closes).
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
  return text.length;
}

function endOfDollarQuoted(text, start) {
  DOLLAR_DELIMITER.lastIndex = start;
  const found = DOLLAR_DELIMITER.exec(text);
  if (!found) {
    return null;
  }
  const delimiter = found[0];
  const close = text.indexOf(delimiter, start + delimiter.length);
  return close === -1 ? text.length : close + delimiter.length;
}

export function normalizeSql(text) {
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
      i += 2;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') {
        i += 1;
      }
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
      const end = endOfQuoted(text, i, "'", false);
      emit(text.slice(i, end));
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
        end = endOfQuoted(text, end, "'", true);
        emit(text.slice(i, end));
      } else {
        emit(word);
      }
      i = end;
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
