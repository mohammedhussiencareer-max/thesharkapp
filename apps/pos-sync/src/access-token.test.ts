import { describe, expect, it, vi } from 'vitest';
import { loadAccessToken, type TokenCommandOptions } from './access-token.ts';

describe('loadAccessToken', () => {
  it('uses POS_ACCESS_TOKEN and does not spawn or log', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const token = await loadAccessToken(
      { POS_ACCESS_TOKEN: ' ya29.SECRET ' },
      async () => {
        throw new Error('gcloud should not run');
      },
    );
    expect(token).toBe('ya29.SECRET');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('spawns gcloud without a shell when the env token is blank', async () => {
    let seen: TokenCommandOptions | undefined;
    const token = await loadAccessToken(
      { PATH: 'C:\\tools', POS_ACCESS_TOKEN: '   ' },
      async (command, args, options) => {
        seen = options;
        expect(command).toBe('gcloud');
        expect(args).toEqual(['auth', 'print-access-token']);
        return { stdout: 'ya29.FROM-GCLOUD\n' };
      },
    );
    expect(token).toBe('ya29.FROM-GCLOUD');
    expect(seen?.shell).toBe(false);
    expect(seen?.windowsHide).toBe(true);
    expect(seen?.timeout).toBe(30_000);
    expect(seen?.encoding).toBe('utf8');
    expect(seen?.env.CLOUDSDK_ACTIVE_CONFIG_NAME).toBe('theshark');
    expect(seen?.env.PATH).toBe('C:\\tools');
  });

  it('does not return command output when gcloud fails', async () => {
    await expect(
      loadAccessToken({}, async () => {
        throw new Error('stdout ya29.SECRET');
      }),
    ).rejects.toThrow(/^Could not obtain a Google access token$/);
    await expect(
      loadAccessToken({}, async () => ({ stdout: ' \n' })),
    ).rejects.toThrow(/^Could not obtain a Google access token$/);
  });
});
