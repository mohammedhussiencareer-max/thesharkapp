import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { BackupError, formatError, isMain } from './config.mjs';

const SECTIONS = ['tables', 'sequences', 'fingerprint'];

function assertManifest(manifest, label) {
  if (!manifest || typeof manifest !== 'object' || manifest.format !== 1) {
    throw new BackupError(
      'MANIFEST_INVALID',
      `${label} is not a format 1 manifest`,
    );
  }
  for (const section of SECTIONS) {
    if (!manifest[section] || typeof manifest[section] !== 'object') {
      throw new BackupError(
        'MANIFEST_INVALID',
        `${label} has no ${section} section`,
      );
    }
  }
}

function describeAttrs(a, b) {
  if (
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) ||
    Array.isArray(b)
  ) {
    return 'value differs';
  }
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((name) => !isDeepStrictEqual(a[name], b[name]))
    .sort();
  return `differs in ${names.join(', ')}`;
}

const notEqual = (a, b) => !isDeepStrictEqual(a, b);

// bigint values are decimal strings in the manifest: a JSON number loses
// precision above 2^53.
function sequenceValue(entry) {
  const value = entry?.lastValue ?? null;
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  throw new BackupError(
    'MANIFEST_INVALID',
    'a sequence value is not a decimal string',
  );
}

const sequenceDiffers = (expected, actual) =>
  sequenceValue(expected) !== sequenceValue(actual);

// A live source can advance a sequence after the dump read it, so the
// restored value may only be at or above the manifest value.
function sequenceMoved(expected, actual) {
  const before = sequenceValue(expected);
  const after = sequenceValue(actual);
  return before !== null && (after === null || after < before);
}

function compareSection(label, expected, actual, describe, differs = notEqual) {
  const differences = [];
  const names = [
    ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
  ];
  for (const name of names.sort()) {
    const object = label ? `${label} ${name}` : name;
    if (!(name in actual)) {
      differences.push({ object, detail: 'missing in the restored database' });
    } else if (!(name in expected)) {
      differences.push({ object, detail: 'not in the backup manifest' });
    } else if (differs(expected[name], actual[name])) {
      differences.push({
        object,
        detail: describe(expected[name], actual[name]),
      });
    }
  }
  return differences;
}

function describeTable(a, b) {
  const parts = [];
  if (a.rows !== b.rows) {
    parts.push(`rows ${a.rows} vs ${b.rows}`);
  }
  if (a.hash !== b.hash) {
    parts.push('content hash differs');
  }
  return parts.join(', ');
}

export function compareManifests(
  expected,
  actual,
  { strictSequences = false } = {},
) {
  assertManifest(expected, 'the expected manifest');
  assertManifest(actual, 'the actual manifest');
  return [
    ...compareSection('data', expected.tables, actual.tables, describeTable),
    ...compareSection(
      'sequence',
      expected.sequences,
      actual.sequences,
      () => 'value differs',
      strictSequences ? sequenceDiffers : sequenceMoved,
    ),
    ...compareSection(
      '',
      expected.fingerprint,
      actual.fingerprint,
      describeAttrs,
    ),
  ];
}

export function summarise(manifest) {
  return `${Object.keys(manifest.tables).length} tables, ${
    Object.keys(manifest.sequences).length
  } sequences, ${Object.keys(manifest.fingerprint).length} schema objects`;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new BackupError('MANIFEST_INVALID', `cannot read manifest ${path}`);
  }
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const strictSequences = args.includes('--strict-sequences');
    const [expectedPath, actualPath] = args.filter((a) => !a.startsWith('--'));
    if (!expectedPath || !actualPath) {
      throw new BackupError(
        'USAGE',
        'usage: compare.mjs [--strict-sequences] <expected.json> <actual.json>',
      );
    }
    const expected = readJson(expectedPath);
    const actual = readJson(actualPath);
    const differences = compareManifests(expected, actual, { strictSequences });
    if (differences.length === 0) {
      console.log(`manifests match: ${summarise(expected)}`);
    } else {
      for (const { object, detail } of differences) {
        console.log(`DIFF ${object}: ${detail}`);
      }
      console.error(
        formatError(
          new BackupError(
            'COMPARE_DIFF',
            `${differences.length} difference(s)`,
          ),
        ),
      );
      process.exit(1);
    }
  } catch (error) {
    console.error(formatError(error));
    process.exit(1);
  }
}
