// Edge-case tests for mend, derived from SPEC.md sentences the practice set does not show.
// Runs main.ts in a fresh temp dir per case and asserts exact exit/stdout/files.
// Usage: node edge-tests.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');

let passed = 0;
const failures = [];

function readTree(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const nm of readdirSync(d)) {
      const p = join(d, nm);
      const rp = rel ? `${rel}/${nm}` : nm;
      if (statSync(p).isDirectory()) walk(p, rp);
      else out[rp] = readFileSync(p, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

function runCase(name, c) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-edge-'));
  try {
    for (const [p, text] of Object.entries(c.files || {})) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(process.execPath, [MAIN, ...(c.argv || [])], {
      cwd: dir, input: c.stdin ?? '', encoding: 'utf8', timeout: 10000,
    });
    const exit = r.status;
    const stdout = r.stdout ?? '';
    const gotFiles = readTree(dir);
    const why = [];
    if (exit !== c.expectExit) why.push(`exit ${exit}, expected ${c.expectExit}`);
    if (stdout !== c.expectStdout) why.push(`stdout ${JSON.stringify(stdout)}, expected ${JSON.stringify(c.expectStdout)}`);
    // expected final files: start from input files, apply expectFiles (null = deleted)
    const want = { ...(c.files || {}) };
    for (const [p, v] of Object.entries(c.expectFiles || {})) {
      if (v === null) delete want[p];
      else want[p] = v;
    }
    for (const p of new Set([...Object.keys(want), ...Object.keys(gotFiles)])) {
      if (!(p in want)) why.push(`${p} should not exist`);
      else if (!(p in gotFiles)) why.push(`${p} is missing`);
      else if (gotFiles[p] !== want[p]) why.push(`${p} differs: expected ${JSON.stringify(want[p])}, got ${JSON.stringify(gotFiles[p])}`);
    }
    if (why.length === 0) passed += 1;
    else {
      failures.push(name);
      console.log(`FAIL ${name}\n  ${why.join('\n  ')}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// E1: file without final newline, hunk changes last line, no backslash -> result ENDS with a line break.
runCase('E1 noeol-change-last-no-bs', {
  argv: ['-'],
  stdin: '--- f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n',
  files: { 'f.txt': 'a\nb' },
  expectExit: 0, expectStdout: 'M f.txt\nok: 1 file\n',
  expectFiles: { 'f.txt': 'a\nc\n' },
});

// E2: same, but backslash after the last + line -> result has NO final line break.
runCase('E2 noeol-change-last-bs', {
  argv: ['-'],
  stdin: '--- f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file\n',
  files: { 'f.txt': 'a\nb' },
  expectExit: 0, expectStdout: 'M f.txt\nok: 1 file\n',
  expectFiles: { 'f.txt': 'a\nc' },
});

// E3: file without final newline, hunk does not touch the end -> final break stays absent.
runCase('E3 noeol-change-top', {
  argv: ['-'],
  stdin: '--- f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+x\n',
  files: { 'f.txt': 'a\nb\nc' },
  expectExit: 0, expectStdout: 'M f.txt\nok: 1 file\n',
  expectFiles: { 'f.txt': 'x\nb\nc' },
});

// E4: two hunks, second relies on cumulative delta d to find the right (third) occurrence.
runCase('E4 multi-hunk-delta', {
  argv: ['-'],
  stdin: '--- f.txt\n+++ b/f.txt\n@@ -1,1 +1,3 @@\n-A\n+X\n+Y\n+A\n@@ -5,1 +5,1 @@\n-A\n+Z\n',
  files: { 'f.txt': 'A\nB\nA\nB\nA\nB\n' },
  expectExit: 0, expectStdout: 'M f.txt\nok: 1 file\n',
  expectFiles: { 'f.txt': 'X\nY\nA\nB\nA\nB\nZ\nB\n' },
});

// E5: SEARCH/REPLACE tier 2 re-indentation (all N lines re-indented).
runCase('E5 sr-tier2-reindent', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\n    a\n    b\n=======\n    a\n    b2\n>>>>>>> REPLACE\n',
    'f.txt': '  a\n  b\n  c\n',
  },
  expectExit: 0, expectStdout: 'M f.txt\nok: 1 file\n',
  expectFiles: { 'f.txt': '  a\n  b2\n  c\n' },
});

// E6: V4A anchor matched at tier 1 (trailing space on the anchor line in the file).
runCase('E6 v4a-anchor-tier1', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n@@ def g():\n x = 1 \n-x = 2\n+x = 3\n*** End Patch\n',
    'f.txt': 'def g(): \nx = 1\nx = 2\n',
  },
  expectExit: 0, expectStdout: 'M f.txt\nok: 1 file\n',
  expectFiles: { 'f.txt': 'def g(): \nx = 1\nx = 3\n' },
});

// E7: atomicity - two blocks, second fails, first must not be written, both failures reported.
runCase('E7 atomic-two-fail', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'a.txt\n<<<<<<< SEARCH\naaa\n=======\nbbb\n>>>>>>> REPLACE\n\nb.txt\n<<<<<<< SEARCH\nzzz\n=======\nyyy\n>>>>>>> REPLACE\n',
    'a.txt': 'aaa\n', 'b.txt': 'qqq\n',
  },
  expectExit: 1, expectStdout: 'error: no-match b.txt\nfailed: 1 of 2 edits\n',
  expectFiles: {},
});

// E8: create then modify the created file in the same patch.
runCase('E8 create-then-modify', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'new.txt\n<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\n\nnew.txt\n<<<<<<< SEARCH\nhello\n=======\nhello world\n>>>>>>> REPLACE\n',
  },
  expectExit: 0, expectStdout: 'A new.txt\nok: 1 file\n',
  expectFiles: { 'new.txt': 'hello world\n' },
});

// E9: unified move, then modify the moved file.
runCase('E9 move-then-modify', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'diff --git a/a.txt b/b.txt\nrename from a.txt\nrename to b.txt\n--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n--- b/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-A\n+B\n',
    'a.txt': 'a\n',
  },
  expectExit: 0, expectStdout: 'R a.txt -> b.txt\nok: 1 file\n',
  expectFiles: { 'a.txt': null, 'b.txt': 'B\n' },
});

// E10: unified create, backslash after last + line -> no final line break.
runCase('E10 create-noeol', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n',
  },
  expectExit: 0, expectStdout: 'A n.txt\nok: 1 file\n',
  expectFiles: { 'n.txt': 'one\ntwo' },
});

// E11: V4A end-of-file chunk with empty O inserts at the end.
runCase('E11 v4a-eof-insert', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n+tail one\n+tail two\n*** End of File\n*** End Patch\n',
    'f.txt': 'head\n',
  },
  expectExit: 0, expectStdout: 'M f.txt\nok: 1 file\n',
  expectFiles: { 'f.txt': 'head\ntail one\ntail two\n' },
});

// E12: V4A Update File with no chunk and no Move to -> parse error at the Update File line.
runCase('E12 v4a-update-no-chunk', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n*** End Patch\n',
    'f.txt': 'x\n',
  },
  expectExit: 2, expectStdout: 'error: parse 2\n',
  expectFiles: {},
});

// E13: --- line not followed by +++ inside a header -> parse error at the line after it.
runCase('E13 dash-not-followed', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'diff --git a/x.txt b/x.txt\n--- a/x.txt\nindex 1234567\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    'x.txt': 'a\n',
  },
  expectExit: 2, expectStdout: 'error: parse 3\n',
  expectFiles: {},
});

// E14: hunk before any section (patch still detected as unified via the later ---/+++ pair)
// -> parse error at the hunk's line.
runCase('E14 hunk-before-section', {
  argv: ['-'],
  stdin: '@@ -1,1 +1,1 @@\n-a\n+b\n--- f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
  files: { 'f.txt': 'a\n' },
  expectExit: 2, expectStdout: 'error: parse 1\n',
  expectFiles: {},
});

// E15a: JSON insert at line == number of lines appends.
runCase('E15a json-insert-append', {
  argv: ['p.jsonl'],
  files: {
    'p.jsonl': '{"command":"insert","path":"f.txt","insert_line":3,"new_str":"d"}\n',
    'f.txt': 'a\nb\nc\n',
  },
  expectExit: 0, expectStdout: 'M f.txt\nok: 1 file\n',
  expectFiles: { 'f.txt': 'a\nb\nc\nd\n' },
});

// E15b: JSON insert beyond the end -> no-match.
runCase('E15b json-insert-oob', {
  argv: ['p.jsonl'],
  files: {
    'p.jsonl': '{"command":"insert","path":"f.txt","insert_line":4,"new_str":"d"}\n',
    'f.txt': 'a\nb\nc\n',
  },
  expectExit: 1, expectStdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n',
  expectFiles: {},
});

// E16: rename from/to wins over diff --git paths (no ---/+++ pair).
runCase('E16 rename-over-diffgit', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'diff --git a/wrong.txt b/wrong2.txt\nrename from old.txt\nrename to new.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    'old.txt': 'a\n',
  },
  expectExit: 0, expectStdout: 'R old.txt -> new.txt\nok: 1 file\n',
  expectFiles: { 'old.txt': null, 'new.txt': 'b\n' },
});

// E17: backslash after a - line only: deleting the last line of a no-EOL file still ends WITH a break.
runCase('E17 bs-after-minus', {
  argv: ['-'],
  stdin: '--- f.txt\n+++ b/f.txt\n@@ -1,2 +1,1 @@\n a\n-b\n\\ No newline at end of file\n',
  files: { 'f.txt': 'a\nb' },
  expectExit: 0, expectStdout: 'M f.txt\nok: 1 file\n',
  expectFiles: { 'f.txt': 'a\n' },
});

// E18: CRLF file via SEARCH/REPLACE stays CRLF.
runCase('E18 sr-crlf', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
    'f.txt': 'a\r\nb\r\nc\r\n',
  },
  expectExit: 0, expectStdout: 'M f.txt\nok: 1 file\n',
  expectFiles: { 'f.txt': 'a\r\nB\r\nc\r\n' },
});

// E19: empty file, empty-O hunk inserts at position 0.
runCase('E19 insert-into-empty', {
  argv: ['-'],
  stdin: '--- f.txt\n+++ b/f.txt\n@@ -0,0 +1,1 @@\n+hello\n',
  files: { 'f.txt': '' },
  expectExit: 0, expectStdout: 'M f.txt\nok: 1 file\n',
  expectFiles: { 'f.txt': 'hello\n' },
});

// E20: unified bad hunk header -> parse error at its line.
runCase('E20 bad-hunk-header', {
  argv: ['-'],
  stdin: '--- f.txt\n+++ b/f.txt\n@@ -x +y @@\n-a\n+b\n',
  files: { 'f.txt': 'a\n' },
  expectExit: 2, expectStdout: 'error: parse 3\n',
  expectFiles: {},
});

// E21: --format=json forced on a unified patch -> parse 1.
runCase('E21 format-json-on-unified', {
  argv: ['--format=json', 'p.txt'],
  files: {
    'p.txt': '--- f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    'f.txt': 'a\n',
  },
  expectExit: 2, expectStdout: 'error: parse 1\n',
  expectFiles: {},
});

// E22: V4A Add File where the path exists -> exists.
runCase('E22 v4a-add-exists', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Add File: f.txt\n+new\n*** End Patch\n',
    'f.txt': 'old\n',
  },
  expectExit: 1, expectStdout: 'error: exists f.txt\nfailed: 1 of 1 edits\n',
  expectFiles: {},
});

// E23: unified create of an existing file via new file mode -> exists.
runCase('E23 unified-create-exists', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'diff --git a/f.txt b/f.txt\nnew file mode 100644\n--- /dev/null\n+++ b/f.txt\n@@ -0,0 +1,1 @@\n+new\n',
    'f.txt': 'old\n',
  },
  expectExit: 1, expectStdout: 'error: exists f.txt\nfailed: 1 of 1 edits\n',
  expectFiles: {},
});

// E24: V4A last non-blank line not End Patch -> parse at (lines + 1).
runCase('E24 v4a-no-end-patch', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Delete File: f.txt\n',
    'f.txt': 'x\n',
  },
  expectExit: 2, expectStdout: 'error: parse 3\n',
  expectFiles: {},
});

// E25: with --format=v4a forced, first non-blank line not Begin Patch -> parse at that line.
runCase('E25 v4a-no-begin', {
  argv: ['--format=v4a', 'p.txt'],
  files: {
    'p.txt': '\n\nhello\n*** Begin Patch\n*** End Patch\n',
  },
  expectExit: 2, expectStdout: 'error: parse 3\n',
  expectFiles: {},
});

// E26: tier priority - O occurs 0 times at tier 0 but twice at tier 1, so tier 1 is
// "their tier" and the block is ambiguous (SEARCH/REPLACE needs exactly one).
runCase('E26 tier-priority-ambiguous', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n',
    'f.txt': 'x  \nx \n',
  },
  expectExit: 1, expectStdout: 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n',
  expectFiles: {},
});

// E27: two failures in one patch are both reported, in patch order, nothing written.
runCase('E27 two-failures', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'nope1.txt\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n\nnope2.txt\n<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE\n',
  },
  expectExit: 1, expectStdout: 'error: missing nope1.txt\nerror: missing nope2.txt\nfailed: 2 of 2 edits\n',
  expectFiles: {},
});

// E28: unified move where the new path exists -> exists (old untouched).
runCase('E28 move-to-existing', {
  argv: ['p.txt'],
  files: {
    'p.txt': '--- a.txt\n+++ b.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
    'a.txt': 'a\n', 'b.txt': 'b\n',
  },
  expectExit: 1, expectStdout: 'error: exists b.txt\nfailed: 1 of 1 edits\n',
  expectFiles: {},
});

// E29: SEARCH/REPLACE old lines empty AND new lines empty -> creates an empty file.
runCase('E29 sr-create-empty', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'new.txt\n<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE\n',
  },
  expectExit: 0, expectStdout: 'A new.txt\nok: 1 file\n',
  expectFiles: { 'new.txt': '' },
});

// E30: a patch that changes a file to identical bytes is a no-op (ok: 0 files).
runCase('E30 noop-unified', {
  argv: ['-'],
  stdin: '--- f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+a\n',
  files: { 'f.txt': 'a\n' },
  expectExit: 0, expectStdout: 'ok: 0 files\n',
  expectFiles: {},
});

console.log(`${passed} of ${passed + failures.length} edge cases passed`);
if (failures.length > 0) process.exitCode = 1;
