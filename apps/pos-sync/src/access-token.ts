import { execFile } from 'node:child_process';

export type TokenCommandOptions = {
  env: NodeJS.ProcessEnv;
  encoding: 'utf8';
  windowsHide: true;
  shell: false;
  timeout: number;
};

export type TokenCommand = (
  command: string,
  args: string[],
  options: TokenCommandOptions,
) => Promise<{ stdout: string }>;

function runGcloud(
  command: string,
  args: string[],
  options: TokenCommandOptions,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        env: options.env,
        encoding: options.encoding,
        windowsHide: options.windowsHide,
        shell: options.shell,
        timeout: options.timeout,
      },
      (error, stdout) => {
        if (error) {
          reject(error instanceof Error ? error : new Error('gcloud failed'));
          return;
        }
        resolve({ stdout: String(stdout) });
      },
    );
  });
}

export async function loadAccessToken(
  env: NodeJS.ProcessEnv = process.env,
  run: TokenCommand = runGcloud,
): Promise<string> {
  const fromEnv = env.POS_ACCESS_TOKEN;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  try {
    const result = await run('gcloud', ['auth', 'print-access-token'], {
      env: { ...env, CLOUDSDK_ACTIVE_CONFIG_NAME: 'theshark' },
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 30_000,
    });
    const token = result.stdout.trim();
    if (token.length === 0) {
      throw new Error('empty token');
    }
    return token;
  } catch {
    throw new Error('Could not obtain a Google access token');
  }
}
