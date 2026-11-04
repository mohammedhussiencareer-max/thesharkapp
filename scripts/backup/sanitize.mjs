import { readFileSync } from 'node:fs';
import { isMain } from './config.mjs';

const KEEP = /^(pg_dump|pg_restore|psql|ERROR|FATAL|backup)\b/;
// Echo lines: server/tool lines that may repeat row data or SQL text.
// 1 = DETAIL/CONTEXT/HINT/LOCATION, 2 = LINE n, 3 = query/command echoes.
const ECHO =
  /^(?:(?:pg_dump|pg_restore|psql)\S*:\s+)?(?:(?:detail|hint):\s+)?(?:(DETAIL|CONTEXT|HINT|LOCATION)\s*:|(LINE\s+\d+)\s*:|(STATEMENT|QUERY|Query was|Command was)\s*:)/i;
const MAX_LINE = 300;
const MAX_LINES = 20;
const OPEN = {
  '"': '"',
  "'": "'",
  '“': '”',
  '‘': '’',
  '„': '“',
  '«': '»',
  '‹': '›',
};
const STRAY_CLOSE = /[”’»›]/;
const ANY_QUOTE = /["'“”‘’„«»‹›]/;
const WORD = /[\p{L}\p{N}_]/u;

function cutAtFirstQuote(line) {
  const at = line.search(ANY_QUOTE);
  return `${line.slice(0, at).trimEnd()} <q>`;
}

// Replaces the inside of every quoted literal. A quote that cannot be paired
// cleanly (odd count, stray closer, text glued to a closer) cuts the line at
// its first quote, so a half-matched literal never leaks.
function redactQuotes(line) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const close = OPEN[ch];
    if (close === undefined) {
      if (STRAY_CLOSE.test(ch)) {
        return cutAtFirstQuote(line);
      }
      out += ch;
      i += 1;
      continue;
    }
    let found = -1;
    for (let j = i + 1; j < line.length; j += 1) {
      if (line[j] !== close) {
        continue;
      }
      if (close === ch && line[j + 1] === close) {
        j += 1;
        continue;
      }
      found = j;
      break;
    }
    if (found < 0) {
      return cutAtFirstQuote(line);
    }
    const inner = line.slice(i + 1, found);
    out += ch + (inner === '<host>' ? inner : '<q>') + close;
    i = found + 1;
    if (i < line.length && WORD.test(line[i])) {
      return cutAtFirstQuote(line);
    }
  }
  return out;
}

// Redacts every (...)=(...) pair, nested parentheses included.
function redactPairs(line) {
  let out = '';
  let pos = 0;
  for (;;) {
    const at = line.indexOf(')=(', pos);
    if (at < 0) {
      return out + line.slice(pos);
    }
    let start = at;
    let depth = 0;
    for (let k = at; k >= pos; k -= 1) {
      if (line[k] === ')') {
        depth += 1;
      } else if (line[k] === '(') {
        depth -= 1;
        if (depth === 0) {
          start = k;
          break;
        }
      }
    }
    out += `${line.slice(pos, start)}(<redacted>)=(<redacted>)`;
    let end = -1;
    depth = 1;
    for (let k = at + 3; k < line.length; k += 1) {
      if (line[k] === '(') {
        depth += 1;
      } else if (line[k] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = k;
          break;
        }
      }
    }
    if (end < 0 || (end + 1 < line.length && WORD.test(line[end + 1]))) {
      return out;
    }
    pos = end + 1;
  }
}

function redactParens(line) {
  let out = '';
  let depth = 0;
  for (const ch of line) {
    if (ch === '(') {
      if (depth === 0) {
        out += '(<redacted>';
      }
      depth += 1;
    } else if (ch === ')' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        out += ')';
      }
    } else if (depth === 0) {
      out += ch;
    }
  }
  return depth > 0 ? `${out})` : out;
}

function maskValues(line) {
  return line
    .replace(/(connection to server at )"[^"]*"/g, '$1"<host>"')
    .replace(/\((?:[0-9a-f]{0,4}:){2,}[0-9a-f:.]*\)/gi, '(<ip>)')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>');
}

function maskBytes(line) {
  return line
    .replace(/\b0x[0-9a-f]{2}(?:\s+0x[0-9a-f]{2})*/gi, '0x<hex>')
    .replace(/\\x[0-9a-f]+/gi, '\\x<hex>');
}

function fit(line) {
  if (line.length <= MAX_LINE) {
    return line;
  }
  const space = line.lastIndexOf(' ', MAX_LINE - 4);
  return `${line.slice(0, space > 0 ? space : MAX_LINE - 4)} ...`;
}

function sanitizeLine(line) {
  const echo = ECHO.exec(line);
  if (echo) {
    if (echo[2]) {
      return `${echo[2].replace(/\s+/g, ' ')}: <redacted>`;
    }
    if (echo[3]) {
      return `${echo[0]} <redacted>`;
    }
    if (ANY_QUOTE.test(line)) {
      return null;
    }
    return fit(maskBytes(redactParens(maskValues(line))));
  }
  if (!KEEP.test(line)) {
    return null;
  }
  return fit(maskBytes(redactQuotes(redactPairs(maskValues(line)))));
}

export function sanitizeStderr(text) {
  const lines = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const clean = sanitizeLine(raw.trim());
    if (clean !== null) {
      lines.push(clean);
    }
  }
  return lines.slice(0, MAX_LINES).join('\n');
}

if (isMain(import.meta.url) && process.argv[2]) {
  const out = sanitizeStderr(readFileSync(process.argv[2], 'utf8'));
  if (out) {
    console.error(out);
  }
}
