// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It reads all four patch formats (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON edits), finds the lines an
// edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, fully-trimmed), and writes
// every change or none (atomic).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Files and lines (SPEC.md section 3)                                 */
/* ------------------------------------------------------------------ */

interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let finalBreak = false;
  if (text.endsWith(br)) {
    finalBreak = true;
    parts.pop();
  }
  return { lines: parts, br, finalBreak };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC.md section 5)                                  */
/* ------------------------------------------------------------------ */

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** All 0-based positions where `o` occurs in `lines` at the given tier. */
function occurrencesAt(lines: string[], o: string[], tier: number): number[] {
  const ok = o.map((l) => tierKey(l, tier));
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let m = true;
    for (let j = 0; j < o.length; j++) {
      if (tierKey(lines[i + j], tier) !== ok[j]) {
        m = false;
        break;
      }
    }
    if (m) out.push(i);
  }
  return out;
}

/** The first tier at which `o` occurs at least once, with its positions, or null. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Like findTier, but only occurrences at or after `from`. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t).filter((p) => p >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Old lines O and new lines N of one replacement, with context tracking. */
interface ON {
  o: string[];
  n: string[];
  /** n[k] is a context line (written as the file's own matched line). */
  nCtx: boolean[];
  /** For a context n[k], its index inside o; -1 otherwise. */
  nOIndex: number[];
}

/** Resolve N for the match at `pos` at the given tier: context lines from the file, tier-2 re-indentation. */
function resolveN(fileLines: string[], on: ON, pos: number, tier: number): string[] {
  const out: string[] = [];
  if (tier === 2 && on.o.length > 0) {
    const F = leadingWS(fileLines[pos]);
    const P = leadingWS(on.o[0]);
    for (let k = 0; k < on.n.length; k++) {
      if (on.nCtx[k]) {
        out.push(fileLines[pos + on.nOIndex[k]]);
        continue;
      }
      const line = on.n[k];
      if (line !== '' && line.trim() !== '' && line.startsWith(P)) out.push(F + line.slice(P.length));
      else out.push(line);
    }
  } else {
    for (let k = 0; k < on.n.length; k++) {
      if (on.nCtx[k]) out.push(fileLines[pos + on.nOIndex[k]]);
      else out.push(on.n[k]);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC.md section 4)                                */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface HunkBody {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}
interface Hunk {
  a: number;
  body: HunkBody[];
}
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: text after the four characters, up to the first tab, trimmed; /dev/null is null. */
function headerPath(raw: string): string | null {
  let s = raw.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function hunkON(h: Hunk): ON {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: boolean[] = [];
  const nOIndex: number[] = [];
  for (const bl of h.body) {
    if (bl.kind === 'ctx') {
      o.push(bl.text);
      n.push(bl.text);
      nCtx.push(true);
      nOIndex.push(o.length - 1);
    } else if (bl.kind === 'old') {
      o.push(bl.text);
    } else if (bl.kind === 'new') {
      n.push(bl.text);
      nCtx.push(false);
      nOIndex.push(-1);
    }
  }
  return { o, n, nCtx, nOIndex };
}

/** True when a `\` line follows the hunk's last `+` line. */
function backslashAfterLastPlus(h: Hunk): boolean {
  for (let j = h.body.length - 1; j >= 0; j--) {
    if (h.body[j].kind === 'new') return j + 1 < h.body.length && h.body[j + 1].kind === 'bs';
  }
  return false;
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLastCtxOrPlus(h: Hunk): boolean {
  for (let j = h.body.length - 1; j >= 0; j--) {
    if (h.body[j].kind === 'ctx' || h.body[j].kind === 'new') return j + 1 < h.body.length && h.body[j + 1].kind === 'bs';
  }
  return false;
}

/** Apply a section's hunks in order to a file's text; throws Fail on the first failing hunk. */
function applyHunks(content: string, hunks: Hunk[], strict: boolean, path: string): string {
  let file = parseFile(content);
  let d = 0;
  for (const h of hunks) {
    const on = hunkON(h);
    if (on.o.length === 0) {
      const insertPos = Math.min(h.a + d, file.lines.length);
      const newLines = [...file.lines.slice(0, insertPos), ...on.n, ...file.lines.slice(insertPos)];
      let finalBreak = file.finalBreak;
      if (insertPos === file.lines.length) finalBreak = !backslashAfterLastPlus(h);
      file = { lines: newLines, br: file.br, finalBreak };
      d += on.n.length;
    } else {
      const found = findTier(file.lines, on.o, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const pos = best;
      const resolved = resolveN(file.lines, on, pos, found.tier);
      const newLines = [...file.lines.slice(0, pos), ...resolved, ...file.lines.slice(pos + on.o.length)];
      let finalBreak = file.finalBreak;
      if (pos + on.o.length === file.lines.length) finalBreak = !backslashAfterLastCtxOrPlus(h);
      file = { lines: newLines, br: file.br, finalBreak };
      d += on.n.length - on.o.length;
    }
  }
  return renderFile(file);
}

function unifiedSectionEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = sec.isCreate || (oldP === null && newP !== null);
    const isDelete = sec.isDelete || (newP === null && oldP !== null);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    for (const p of [oldP, newP]) {
      if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    if (isCreate) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const lines: string[] = [];
      let lastPlusBs = false;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          const bl = h.body[j];
          if (bl.kind === 'new') {
            lines.push(bl.text);
            lastPlusBs = j + 1 < h.body.length && h.body[j + 1].kind === 'bs';
          }
        }
      }
      tree.now.set(np, lines.length === 0 ? '' : lines.join('\n') + (lastPlusBs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (isMove) {
      const op = oldP!;
      const np = newP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const result = applyHunks(tree.get(op)!, sec.hunks, strict, op);
      tree.now.set(np, result);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
      return;
    }
    if (oldP === null && newP === null) return; // degenerate section: no file named
    const p = oldP !== null ? oldP : newP!;
    if (tree.get(p) === null) throw new Fail('missing', p);
    const result = applyHunks(tree.get(p)!, sec.hunks, strict, p);
    tree.now.set(p, result);
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1], newPath: m[2], hasPair: false, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        const oldP = headerPath(line);
        const newP = headerPath(next);
        if (cur !== null && inHeader) {
          cur.oldPath = oldP;
          cur.newPath = newP;
          cur.hasPair = true;
        } else {
          cur = { oldPath: oldP, newPath: newP, hasPair: true, isCreate: false, isDelete: false, hunks: [] };
          sections.push(cur);
          inHeader = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur !== null && inHeader) cur.newPath = headerPath(line);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1], 10), body: [] };
      cur.hunks.push(hunk);
      inHeader = false;
      i++;
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && lines[i + 1] !== undefined && (lines[i + 1] as string).startsWith('+++ ')) break;
        if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\') || bl === '') {
          let kind: HunkBody['kind'];
          let text: string;
          if (bl === '') {
            kind = 'ctx';
            text = '';
          } else if (bl[0] === ' ') {
            kind = 'ctx';
            text = bl.slice(1);
          } else if (bl[0] === '-') {
            kind = 'old';
            text = bl.slice(1);
          } else if (bl[0] === '+') {
            kind = 'new';
            text = bl.slice(1);
          } else {
            kind = 'bs';
            text = bl.slice(1);
          }
          hunk.body.push({ kind, text });
          i++;
        } else break;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1];
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) {
        if (!cur.hasPair) cur.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (!cur.hasPair) cur.newPath = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const file = parseFile(cur);
    const found = findTier(file.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0];
    const on: ON = { o: oldLines, n: newLines, nCtx: newLines.map(() => false), nOIndex: newLines.map(() => -1) };
    const resolved = resolveN(file.lines, on, pos, found.tier);
    const newFileLines = [...file.lines.slice(0, pos), ...resolved, ...file.lines.slice(pos + oldLines.length)];
    tree.now.set(path, renderFile({ lines: newFileLines, br: file.br, finalBreak: file.finalBreak }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const s = i;
      let path: string | null = null;
      for (let j = s - 1; j > prevReplaceEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new Exit2(`error: parse ${s + 1}`);
      }
      let eq = -1;
      for (let j = s + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
        if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      }
      if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
        if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      }
      if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
      edits.push(searchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
      prevPath = path;
      prevReplaceEnd = rep;
      i = rep + 1;
      continue;
    }
    i++;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  body: { kind: 'ctx' | 'old' | 'new'; text: string }[];
  eof: boolean;
}

function v4aChunkON(ch: V4AChunk): ON {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: boolean[] = [];
  const nOIndex: number[] = [];
  for (const bl of ch.body) {
    if (bl.kind === 'ctx') {
      o.push(bl.text);
      n.push(bl.text);
      nCtx.push(true);
      nOIndex.push(o.length - 1);
    } else if (bl.kind === 'old') {
      o.push(bl.text);
    } else {
      n.push(bl.text);
      nCtx.push(false);
      nOIndex.push(-1);
    }
  }
  return { o, n, nCtx, nOIndex };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, content: { text: string; idx: number }[], startLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  let sawChunk = false;
  let pos = 0;
  if (content.length > 0 && content[0].text.startsWith('*** Move to: ')) {
    moveTo = content[0].text.slice('*** Move to: '.length).trim();
    pos = 1;
  }
  for (; pos < content.length; pos++) {
    const c = content[pos];
    const l = c.text;
    if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${c.idx + 1}`);
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      sawChunk = true;
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${c.idx + 1}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (!sawChunk) {
          cur = { anchor: null, body: [], eof: false };
          sawChunk = true;
        } else {
          throw new Exit2(`error: parse ${c.idx + 1}`);
        }
      }
      let kind: 'ctx' | 'old' | 'new';
      let text: string;
      if (l === '') {
        kind = 'ctx';
        text = '';
      } else if (l[0] === ' ') {
        kind = 'ctx';
        text = l.slice(1);
      } else if (l[0] === '-') {
        kind = 'old';
        text = l.slice(1);
      } else {
        kind = 'new';
        text = l.slice(1);
      }
      cur.body.push({ kind, text });
      continue;
    }
    throw new Exit2(`error: parse ${c.idx + 1}`);
  }
  if (cur !== null) chunks.push(cur);
  if (!sawChunk && moveTo === null) throw new Exit2(`error: parse ${startLine + 1}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curContent = tree.get(path);
    if (curContent === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let file = parseFile(curContent);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let anchorIdx = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < file.lines.length; k++) {
            if (tierKey(file.lines[k], t) === tierKey(ch.anchor, t)) {
              anchorIdx = k;
              break;
            }
          }
          if (anchorIdx >= 0) break;
        }
        if (anchorIdx < 0) throw new Fail('no-match', path);
        cursor = anchorIdx + 1;
      }
      const on = v4aChunkON(ch);
      if (on.o.length === 0) {
        const insertPos = ch.eof ? file.lines.length : cursor;
        const newLines = [...file.lines.slice(0, insertPos), ...on.n, ...file.lines.slice(insertPos)];
        file = { lines: newLines, br: file.br, finalBreak: file.finalBreak };
        cursor = insertPos + on.n.length;
      } else {
        const found = findTierFrom(file.lines, on.o, cursor, strict);
        if (!found) throw new Fail('no-match', path);
        let pos: number;
        if (ch.eof) {
          const endPos = file.lines.length - on.o.length;
          const atEnd = found.occ.find((p) => p === endPos);
          if (atEnd === undefined) throw new Fail('no-match', path);
          pos = atEnd;
        } else {
          pos = found.occ[0];
        }
        const resolved = resolveN(file.lines, on, pos, found.tier);
        const newLines = [...file.lines.slice(0, pos), ...resolved, ...file.lines.slice(pos + on.o.length)];
        file = { lines: newLines, br: file.br, finalBreak: file.finalBreak };
        cursor = pos + resolved.length;
      }
    }
    const result = renderFile(file);
    if (moveTo !== null) {
      tree.now.set(moveTo, result);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, result);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): string | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  const n = last;
  while (i < n) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const kind = isSectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = line.slice(prefix.length).trim();
    const startLine = i;
    i++;
    const content: { text: string; idx: number }[] = [];
    while (i < n) {
      const l = lines[i]!;
      if (isSectionStart(l) !== null) break;
      content.push({ text: l, idx: i });
      i++;
    }
    while (content.length > 0 && blank(content[content.length - 1].text)) content.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const c of content) {
        if (c.text === '') fileLines.push('');
        else if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
        else throw new Exit2(`error: parse ${c.idx + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      for (const c of content) {
        if (!blank(c.text)) throw new Exit2(`error: parse ${c.idx + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, content, startLine, strict));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* Driver (SPEC.md sections 1, 2, 10)                                  */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const rCovered = new Set<string>();
  for (const [old, nw] of tree.moves) {
    const wasOld = tree.original(old);
    const nowOld = tree.get(old);
    const wasNew = tree.original(nw);
    const nowNew = tree.get(nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: nw, text: `R ${old} -> ${nw}` });
      rCovered.add(old);
      rCovered.add(nw);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (rCovered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outRows = rows.map((r) => r.text);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
