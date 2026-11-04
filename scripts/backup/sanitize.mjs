import { readFileSync } from 'node:fs';
import { isMain } from './config.mjs';

const KEEP = /^(pg_dump|pg_restore|psql|ERROR|FATAL|backup)\b/;
const MAX_LINE = 300;

export function sanitizeStderr(text) {
  const lines = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!KEEP.test(line)) {
      continue;
    }
    lines.push(
      line
        .replace(/(connection to server at )"[^"]*"/g, '$1"<host>"')
        .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>')
        .replace(/\(([^()]*)\)=\(([^()]*)\)/g, '(<redacted>)=(<redacted>)')
        .slice(0, MAX_LINE),
    );
  }
  return lines.slice(0, 20).join('\n');
}

if (isMain(import.meta.url) && process.argv[2]) {
  const out = sanitizeStderr(readFileSync(process.argv[2], 'utf8'));
  if (out) {
    console.error(out);
  }
}
