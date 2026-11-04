import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const msys = (path) =>
  windows
    ? posix(path).replace(
        /^([A-Za-z]):/,
        (_, drive) => `/${drive.toLowerCase()}`,
      )
    : path;

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
  const failStub = `#!/bin/sh\nprintf '%s|%s|%s\\n' "$PGHOST" "\${PGHOSTADDR-unset}" "$1" >>"$STUB_LOG"\nexit 1\n`;
  for (const name of ['supabase', 'psql', 'pg_dump', 'pg_restore']) {
    const file = join(bin, name);
    writeFileSync(file, failStub);
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
  const stub = (name, body) => {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  return { base, tmp, run, leftovers, calls, stub };
}

function makeArchive(h) {
  const dir = join(h.base, 'pkg');
  mkdirSync(dir);
  const files = { 'db.dump': 'x', 'manifest.json': '{}' };
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  writeFileSync(
    join(dir, 'SHA256SUMS'),
    Object.entries(files)
      .map(
        ([name, text]) =>
          `${createHash('sha256').update(text).digest('hex')}  ${name}\n`,
      )
      .join(''),
  );
  const archive = join(h.base, 'a.tar.gz');
  const made = spawnSync(
    bash,
    [
      '-c',
      'cd "$1" && tar -czf "$2" db.dump manifest.json SHA256SUMS',
      'sh',
      msys(dir),
      msys(archive),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(made.status, 0, made.stderr);
  return msys(archive);
}

const everything = (result) => `${result.stdout}\n${result.stderr}`;
const NASTY_STDERR =
  'printf \'ERROR:  value "x\\nERROR:  PRIVATE-DATA\\n" is bad\\nDETAIL:  Failing row contains (PRIVATE-DATA).\\nERROR:  syntax error at or near "PRIVATE-DATA"\\n\' >&2\nexit 1';

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

test(
  'production paths print no server text, even with the old flag, a remote host or a half-set synthetic flag',
  { skip },
  () => {
    const cases = [
      { BACKUP_PRINT_STDERR: '1' },
      { BACKUP_SYNTHETIC_DIAGNOSTICS: '1', PGHOST: 'db.example.com' },
      { BACKUP_SYNTHETIC_DIAGNOSTICS: '1', PGHOST: '127.0.0.1' },
      { BACKUP_SYNTHETIC_DIAGNOSTICS: '1', BACKUP_ALLOW_LOOPBACK: '1' },
      {
        BACKUP_SYNTHETIC_DIAGNOSTICS: '1',
        BACKUP_ALLOW_LOOPBACK: '1',
        PGHOST: 'localhost',
      },
      { BACKUP_ALLOW_LOOPBACK: '1', PGHOST: '127.0.0.1' },
    ];
    for (const extra of cases) {
      const h = harness();
      try {
        h.stub('pg_restore', NASTY_STDERR);
        const result = h.run('verify-archive.sh', [makeArchive(h)], extra);
        const text = everything(result);
        assert.equal(result.status, 1, JSON.stringify(extra));
        assert.match(text, /\[DUMP_UNREADABLE\]/);
        assert.ok(!text.includes('PRIVATE-DATA'), JSON.stringify(extra));
        assert.ok(!text.includes('syntax error'), JSON.stringify(extra));
        assert.deepEqual(h.leftovers(), []);
      } finally {
        rmSync(h.base, { recursive: true, force: true });
      }
    }
  },
);

test(
  'the synthetic loopback run prints sanitized multiline diagnostics and no row data',
  { skip },
  () => {
    const h = harness();
    try {
      h.stub('pg_restore', NASTY_STDERR);
      const result = h.run('verify-archive.sh', [makeArchive(h)], {
        BACKUP_SYNTHETIC_DIAGNOSTICS: '1',
        BACKUP_ALLOW_LOOPBACK: '1',
        PGHOST: '127.0.0.1',
      });
      const text = everything(result);
      assert.equal(result.status, 1);
      assert.match(text, /syntax error/);
      assert.ok(!text.includes('PRIVATE-DATA'));
    } finally {
      rmSync(h.base, { recursive: true, force: true });
    }
  },
);

test(
  'restore-archive never prints the supabase start log or server text; the full run shows the start log',
  { skip },
  () => {
    const startLog = "printf 'PRIVATE-DATA start failure\\n'\nexit 1";
    for (const extra of [
      {},
      { BACKUP_SYNTHETIC_DIAGNOSTICS: '1', BACKUP_PRINT_STDERR: '1' },
    ]) {
      const h = harness();
      try {
        h.stub('supabase', startLog);
        const result = h.run(
          'ci-roundtrip.sh',
          ['restore-archive', 'no-such.tar.gz'],
          { CI: 'true', ...extra },
        );
        const text = everything(result);
        assert.equal(result.status, 1);
        assert.match(text, /\[STACK_START\]/);
        assert.ok(!text.includes('PRIVATE-DATA'), JSON.stringify(extra));
      } finally {
        rmSync(h.base, { recursive: true, force: true });
      }
    }
    const h = harness();
    try {
      h.stub('supabase', startLog);
      const result = h.run('ci-roundtrip.sh', ['full'], { CI: 'true' });
      assert.equal(result.status, 1);
      assert.match(everything(result), /PRIVATE-DATA start failure/);
    } finally {
      rmSync(h.base, { recursive: true, force: true });
    }
  },
);

test('static: server text is gated to the synthetic full round trip', () => {
  const read = (name) =>
    readFileSync(join(repoRoot, 'scripts', 'backup', name), 'utf8');
  const round = read('ci-roundtrip.sh');
  assert.match(round, /^unset BACKUP_PRINT_STDERR$/m);
  assert.match(
    round,
    /if \[ "\$mode" = full \]; then\n {2}export BACKUP_SYNTHETIC_DIAGNOSTICS=1\nelse\n {2}unset BACKUP_SYNTHETIC_DIAGNOSTICS\nfi/,
  );
  for (const name of readdirSync(join(repoRoot, 'scripts', 'backup')).filter(
    (n) => n.endsWith('.sh'),
  )) {
    assert.ok(
      !/export BACKUP_PRINT_STDERR/.test(read(name)),
      `${name} exports the old flag`,
    );
    if (name !== 'ci-roundtrip.sh' && name !== 'lib.sh') {
      assert.ok(
        !read(name).includes('BACKUP_SYNTHETIC_DIAGNOSTICS'),
        `${name} handles the synthetic flag`,
      );
    }
  }
  const workflow = readFileSync(
    join(repoRoot, '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  assert.ok(!workflow.includes('BACKUP_PRINT_STDERR'));
  assert.ok(!workflow.includes('BACKUP_SYNTHETIC_DIAGNOSTICS'));
});

test('static: BACKUP_PG_BIN is applied before any PostgreSQL tool is required', () => {
  for (const name of [
    'dump.sh',
    'restore.sh',
    'verify-archive.sh',
    'ci-roundtrip.sh',
  ]) {
    const lines = readFileSync(
      join(repoRoot, 'scripts', 'backup', name),
      'utf8',
    ).split('\n');
    const setup = lines.indexOf('setup_pg_path');
    assert.ok(setup > 0, `${name} never calls setup_pg_path`);
    const pgChecks = lines.flatMap((line, index) =>
      /^require_tools\b.*\b(psql|pg_dump|pg_restore)\b/.test(line)
        ? [index]
        : [],
    );
    assert.ok(pgChecks.length > 0, `${name} never requires a PostgreSQL tool`);
    for (const index of pgChecks) {
      assert.ok(index > setup, `${name} requires a PostgreSQL tool too early`);
    }
  }
});

function shimDir(h) {
  const dir = join(h.base, 'shim');
  mkdirSync(dir);
  const tools = [
    'node',
    'tar',
    'gzip',
    'sha256sum',
    'dirname',
    'mktemp',
    'cat',
    'grep',
    'rm',
  ];
  const found = spawnSync(bash, ['-c', `command -v ${tools.join(' ')}`], {
    encoding: 'utf8',
    env: process.env,
  });
  const paths = found.stdout.trim().split('\n');
  assert.equal(paths.length, tools.length);
  tools.forEach((tool, index) => {
    const file = join(dir, tool);
    writeFileSync(file, `#!/bin/sh\nexec "${paths[index]}" "$@"\n`);
    chmodSync(file, 0o755);
  });
  return dir;
}

test(
  'PostgreSQL tools that exist only in BACKUP_PG_BIN are found before they are required',
  { skip },
  () => {
    const cases = [
      ['dump.sh', [join(tmpdir(), 'unused-out')]],
      ['restore.sh', ['no-such.tar.gz', 'preserve']],
      ['verify-archive.sh', ['no-such.tar.gz']],
    ];
    for (const [script, args] of cases) {
      const h = harness();
      try {
        const shim = shimDir(h);
        const pgBin = join(h.base, 'pgbin');
        mkdirSync(pgBin);
        for (const tool of ['psql', 'pg_dump', 'pg_restore']) {
          const file = join(pgBin, tool);
          writeFileSync(file, '#!/bin/sh\nexit 1\n');
          chmodSync(file, 0o755);
        }
        const env = { PATH: msys(shim), BACKUP_PG_BIN: msys(pgBin) };
        const leak = spawnSync(
          bash,
          ['-c', 'command -v psql pg_dump pg_restore'],
          { env: { ...process.env, PATH: env.PATH } },
        );
        assert.notEqual(
          leak.status,
          0,
          'a PostgreSQL tool is on the bare PATH',
        );

        const found = h.run(script, args, env);
        assert.equal(found.status, 1, script);
        assert.ok(
          !/TOOL_MISSING/.test(found.stderr),
          `${script}: ${found.stderr}`,
        );
        assert.match(found.stderr, /backup: error \[[A-Z_]+\]/);

        const empty = join(h.base, 'empty-bin');
        mkdirSync(empty);
        const missing = h.run(script, args, {
          ...env,
          BACKUP_PG_BIN: msys(empty),
        });
        assert.equal(missing.status, 1, script);
        assert.match(
          missing.stderr,
          /\[TOOL_MISSING\]: (psql|pg_dump|pg_restore) /,
        );
        assert.deepEqual(h.leftovers(), []);
      } finally {
        rmSync(h.base, { recursive: true, force: true });
      }
    }
  },
);
