import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('.', import.meta.url));

function productionSources(): Array<{ name: string; text: string }> {
  return readdirSync(srcDir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(join(srcDir, name), 'utf8') }));
}

describe('source policy', () => {
  const sources = productionSources();

  it('keeps Google and Supabase fetches in the two client modules', () => {
    const fetchFiles = sources
      .filter((source) => /\bfetch\s*\(/.test(source.text))
      .map((source) => source.name)
      .sort();
    expect(fetchFiles).toEqual(['firestore-read.ts', 'supabase-write.ts']);
    const hostFiles = sources
      .filter((source) => source.text.includes('firestore.googleapis.com'))
      .map((source) => source.name);
    expect(hostFiles).toEqual(['firestore-read.ts']);
  });

  it('does not write tokens or spawn a shell', () => {
    const joined = sources.map((source) => source.text).join('\n');
    expect(joined).not.toMatch(/writeFile|appendFile|createWriteStream/);
    expect(joined).not.toMatch(/shell:\s*true/);
    expect(joined).not.toMatch(/node:https|node:http/);
    const childProcess = sources
      .filter((source) => source.text.includes('node:child_process'))
      .map((source) => source.name);
    expect(childProcess).toEqual(['access-token.ts']);
    const accessToken = sources.find(
      (source) => source.name === 'access-token.ts',
    );
    expect(accessToken?.text).not.toContain('console.');
  });

  it('does not name customer or device fields in production code', () => {
    const joined = sources.map((source) => source.text).join('\n');
    for (const word of [
      'customerName',
      'customerId',
      'employeeName',
      'employeeId',
      'itemImageUrl',
      'tableNumbers',
    ]) {
      expect(joined).not.toContain(word);
    }
  });
});
