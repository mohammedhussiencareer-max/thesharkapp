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

function gcloudLaunch(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    return {
      command: env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', 'gcloud', 'auth', 'print-access-token'],
    };
  }
  return {
    command: 'gcloud',
    args: ['auth', 'print-access-token'],
  };
}

function tokenFromOutput(stdout: string): string {
  const token = stdout.trim();
  if (token.length === 0 || /\s/.test(token)) {
    throw new Error('empty token');
  }
  return token;
}

export async function loadAccessToken(
  env: NodeJS.ProcessEnv = process.env,
  run: TokenCommand = runGcloud,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const fromEnv = env.POS_ACCESS_TOKEN;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  const launch = gcloudLaunch(platform, env);
  try {
    const result = await run(launch.command, launch.args, {
      env: { ...env, CLOUDSDK_ACTIVE_CONFIG_NAME: 'theshark' },
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 30_000,
    });
    return tokenFromOutput(result.stdout);
  } catch {
    throw new Error('Could not obtain a Google access token');
  }
}
