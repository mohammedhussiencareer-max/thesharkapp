import { PosSyncError } from './safe-error.ts';
import type { SyncMode } from './types.ts';

export function parseMode(argv: readonly string[]): SyncMode {
  let mode: SyncMode | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      throw new PosSyncError('unknownArgument');
    }
    if (arg === '--') {
      continue;
    }
    if (arg === '--mode') {
      if (mode !== undefined) {
        throw new PosSyncError('unknownArgument');
      }
      mode = parseModeValue(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      if (mode !== undefined) {
        throw new PosSyncError('unknownArgument');
      }
      mode = parseModeValue(arg.slice('--mode='.length));
      continue;
    }
    throw new PosSyncError('unknownArgument');
  }
  return mode ?? 'recent';
}

function parseModeValue(value: string | undefined): SyncMode {
  if (value === 'recent' || value === 'window35' || value === 'full') {
    return value;
  }
  throw new PosSyncError('unknownMode');
}
