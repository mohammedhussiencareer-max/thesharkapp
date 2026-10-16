import { describe, expect, it } from 'vitest';
import { parseMode } from './args.ts';

describe('parseMode', () => {
  it('defaults to recent and accepts both flag forms', () => {
    expect(parseMode([])).toBe('recent');
    expect(parseMode(['--mode', 'full'])).toBe('full');
    expect(parseMode(['--', '--mode', 'window35'])).toBe('window35');
    expect(parseMode(['--mode=window35'])).toBe('window35');
  });

  it('rejects unknown input without echoing it', () => {
    expect(() => parseMode(['--mode', 'ya29.SECRET'])).toThrow(
      /^Unknown mode$/,
    );
    expect(() => parseMode(['--token=ya29.SECRET'])).toThrow(
      /^Unknown argument$/,
    );
    expect(() => parseMode(['--mode', 'recent', '--mode', 'full'])).toThrow(
      /^Unknown argument$/,
    );
  });
});
