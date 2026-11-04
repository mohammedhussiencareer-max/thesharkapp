import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const windows = process.platform === 'win32';
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const bash =
  process.env.BACKUP_TEST_BASH ??
  (windows && existsSync(gitBash) ? gitBash : 'bash');
const posix = (path) => path.replaceAll('\\', '/');

const probe = spawnSync(
  bash,
  ['-c', 'command -v node mktemp tar gzip sha256sum awk sed >/dev/null'],
  { env: process.env },
);
const skip =
  probe.status === 0
    ? false
    : 'bash or the coreutils the scripts need are missing';

function harness() {
  const base = mkdtempSync(join(tmpdir(), 'backup-lifecycle-'));
  const bin = join(base, 'bin');
  const tmp = join(base, 'tmp');
  const log = join(base, 'stub.log');
  mkdirSync(bin);
  mkdirSync(tmp);
  const stub = `#!/bin/sh\nprintf '%s|%s|%s\\n' "$PGHOST" "\${PGHOSTADDR-unset}" "$1" >>"$STUB_LOG"\nexit 1\n`;
  for (const name of ['supabase', 'psql', 'pg_dump', 'pg_restore']) {
    const file = join(bin, name);
    writeFileSync(file, stub);
    chmodSync(file, 0o755);
  }
  const run = (script, args, extra = {}) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(PG|BACKUP_|GITHUB_|CI$)/.test(key),
      ),
    );
    return spawnSync(bash, [`scripts/backup/${script}`, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 90_000,
      env: {
        ...env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        TMPDIR: posix(tmp),
        STUB_LOG: posix(log),
        BACKUP_PG_BIN: posix(join(base, 'no-such-bin')),
        ...extra,
      },
    });
  };
  const leftovers = () =>
    readdirSync(tmp).filter((name) => name.startsWith('backup.'));
  const calls = () =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { base, tmp, run, leftovers, calls };
}

test('a failing script removes its work dir', { skip }, () => {
  const h = harness();
  try {
    const result = h.run('dump.sh', []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[USAGE\]/);
    assert.deepEqual(h.leftovers(), []);
  } finally {
    rmSync(h.base, { recursive: true, force: true });
  }
});

test(
  'a round trip that fails after the stack hook is installed still removes its work dir',
  { skip },
  () => {
    const h = harness();
    try {
      const result = h.run('ci-roundtrip.sh', ['full'], { CI: 'true' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /\[STACK_START\]/);
      assert.deepEqual(h.leftovers(), []);
      const verbs = h.calls().map((line) => line.split('|')[2]);
      assert.ok(verbs.includes('start'));
      assert.equal(verbs.at(-1), 'stop');
    } finally {
      rmSync(h.base, { recursive: true, force: true });
    }
  },
);

test(
  'an unconfirmed round trip refuses before touching the stack and cleans up',
  { skip },
  () => {
    const h = harness();
    try {
      const result = h.run('ci-roundtrip.sh', ['full']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /\[ROUNDTRIP_CONFIRM\]/);
      assert.deepEqual(h.calls(), []);
      assert.deepEqual(h.leftovers(), []);
    } finally {
      rmSync(h.base, { recursive: true, force: true });
    }
  },
);

test(
  'restore-archive ignores an ambient remote host and only uses loopback',
  { skip },
  () => {
    const h = harness();
    try {
      const result = h.run(
        'ci-roundtrip.sh',
        ['restore-archive', 'no-such.tar.gz'],
        {
          CI: 'true',
          PGHOST: 'evil.example.com',
          PGHOSTADDR: '203.0.113.9',
          BACKUP_RESTORE_CONFIRM: 'RESTORE-INTO-EMPTY-PROJECT',
        },
      );
      assert.equal(result.status, 1);
      assert.ok(h.calls().length > 0);
      for (const line of h.calls()) {
        assert.match(line, /^127\.0\.0\.1\|unset\|/);
      }
      assert.deepEqual(h.leftovers(), []);
    } finally {
      rmSync(h.base, { recursive: true, force: true });
    }
  },
);

test(
  'BACKUP_KEEP_WORK=1 is the only opt-out, and nothing kept is group/world accessible',
  { skip: skip || (windows && 'POSIX file modes') },
  () => {
    const h = harness();
    try {
      const result = h.run('ci-roundtrip.sh', ['full'], {
        CI: 'true',
        BACKUP_KEEP_WORK: '1',
      });
      assert.equal(result.status, 1);
      const kept = h.leftovers();
      assert.equal(kept.length, 1);
      const walk = (dir) => {
        assert.equal(
          statSync(dir).mode & 0o077,
          0,
          `${dir} is accessible to others`,
        );
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(path);
          } else {
            assert.equal(
              statSync(path).mode & 0o077,
              0,
              `${path} is accessible to others`,
            );
          }
        }
      };
      walk(join(h.tmp, kept[0]));
    } finally {
      rmSync(h.base, { recursive: true, force: true });
    }
  },
);

test('static: every exit path runs one cleanup and no script bypasses it', () => {
  const read = (name) =>
    readFileSync(join(repoRoot, 'scripts', 'backup', name), 'utf8');
  const lib = read('lib.sh');
  assert.match(lib, /on_exit\(\) \{\n  local rc=\$\?\n  set \+e\n/);
  assert.match(lib, /trap on_exit EXIT/);
  for (const signal of ['INT', 'TERM', 'HUP']) {
    assert.match(lib, new RegExp(`trap 'exit \\d+' ${signal}`));
  }
  assert.match(
    lib,
    /BACKUP_KEEP_WORK:-0\}" != 1 \]; then\n    rm -rf "\$work_dir"/,
  );
  for (const name of readdirSync(join(repoRoot, 'scripts', 'backup')).filter(
    (n) => n.endsWith('.sh'),
  )) {
    const text = read(name);
    assert.ok(
      !/^\s*trap\s+(?!-)/m.test(text) || name === 'lib.sh',
      `${name} sets its own trap`,
    );
    assert.ok(
      !text.includes('(exit "$rc")'),
      `${name} re-raises the status under errexit`,
    );
  }
  const dump = read('dump.sh');
  assert.match(dump, /exit_hook=dump_cleanup/);
  assert.ok(
    dump.indexOf('dump_done=1') > dump.indexOf('verify_archive "$archive"'),
  );
});
