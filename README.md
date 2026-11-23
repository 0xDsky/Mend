[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/0xDsky/Mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/0xDsky/Mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats: a unified
diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON.
mend reads all four to one written specification (`SPEC.md`), finds the lines an edit names even when the model
drifted their whitespace or indentation, and changes every file or none (atomic).

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When it is absent or `-`, the patch is
  read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default,
  detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is created, changed
  or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`/`D`/`M`, or `R old -> new` for a move) and `ok: <n> files`.
Exit 1 prints one `error: <code> <path>` line per failed edit and `failed: <k> of <n> edits`; no file is written.
Exit 2 prints one `error: ...` line for a usage, missing-patch, format or parse error.

## Matching

An edit's old lines are found at the first of three tiers at which they occur at least once:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed from both;
- tier 2: every line equal once leading and trailing spaces and tabs are removed from both.

A context line is written as the file's own matched line. At tier 2, other new lines are re-indented from the old
block's leading whitespace to the file's. Unified hunks take the occurrence nearest the hunk's stated line number;
SEARCH/REPLACE blocks need exactly one occurrence; V4A chunks follow anchors and a cursor, and an end-of-file chunk
only matches at the end of the file.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`.
- `runner.ts`: the trial runner (keep as is). In a trial it reads the checks from the env, runs `node main.ts` on
  each one in a fresh directory, and posts what main.ts did.
- `SPEC.md`: the specification.
- `edge-tests.mjs`: 31 extra edge-case checks derived from SPEC.md sentences the practice set does not show
  (`node edge-tests.mjs`).
- `LICENSE`: MIT.

## Practice

The kit's practice set (100 checks) is not in this repository; run it from the kit:

    node check.ts ../program/generator/practice.json

This entry passes 100 of 100 practice checks (practice score 1000) and 31 of 31 edge cases.
