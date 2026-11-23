// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// Reads a patch in one of four formats and applies it all-or-nothing:
//   unified diffs      -- `diff --git` / `---`+`+++` sections with @@ hunks
//                         (a hunk's -A line is a hint, not gospel: the match
//                         is found by content at the nearest occurrence);
//   SEARCH/REPLACE     -- `<<<<<<< SEARCH` ... `=======` ... `>>>>>>> REPLACE`
//                         blocks, the file named on the line above each block;
//   V4A                -- `*** Begin Patch` with Add/Delete/Update File
//                         sections and @@ anchors;
//   JSON edits         -- one JSON object per line, or a JSON array:
//                         create / str_replace / insert by path.
// Every edit is found at the first of three matching tiers (exact, trailing
// whitespace ignored, leading+trailing whitespace ignored with re-indent),
// and either all edits land or none do: a failed edit rolls the tree back
// and is reported instead of half-applying. Sections 1-10 of SPEC.md.
//
// Exit codes: 0 ok, 1 an edit failed, 2 usage / parse / no patch.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

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
  /** Move edits, in order: [old, new]. Only used to print `R` lines. */
  readonly moves: Array<[string, string]> = [];
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

// ---------------------------------------------------------------------------
// Files as lines (SPEC.md section 3) and three-tier matching (section 5)
// ---------------------------------------------------------------------------

interface FileModel {
  br: '\n' | '\r\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

function norm(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s);
}

/** Positions where O occurs in lines at one tier (occurrences may overlap). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const on = o.map((l) => norm(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(lines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; strict: 0 only) at which O occurs at least once. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line. */
interface NLine {
  text: string;
  ctx: boolean;
  /** Index into O of the context line this N line is (valid when ctx). */
  oIdx: number;
}

/** The lines N writes over the matched region at `pos` (SPEC.md section 5). */
function writeN(lines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(lines[pos]!);
    p = leadWs(o[0]!);
  }
  for (const e of n) {
    if (e.ctx) {
      out.push(lines[pos + e.oIdx]!);
      continue;
    }
    let t = e.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** The -A of the hunk header (1-based start line of the old side). */
  a: number;
  /** Body lines, trailing empty lines removed. */
  body: string[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
}

interface RawSection {
  gitOld?: string;
  gitNew?: string;
  /** From a `---`/`+++` pair; null means /dev/null. */
  dashOld?: string | null;
  dashNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- `/`+++ `: up to the first tab, spaces removed, a/ or b/ stripped. */
function patchPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let inHeader = false;
  let hunk: Hunk | null = null;
  const endHunk = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
    hunk.noEol = false;
    for (let i = hunk.body.length - 1; i >= 0; i--) {
      const b = hunk.body[i]!;
      if (b === '' || b[0] === ' ' || b[0] === '+') {
        hunk.noEol = i + 1 < hunk.body.length && hunk.body[i + 1]!.startsWith('\\');
        break;
      }
    }
    hunk = null;
  };
  const startSection = (): void => {
    endHunk();
    cur = { newFile: false, delFile: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      endHunk();
      cur = { gitOld: m[1], gitNew: m[2], newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      endHunk();
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: parseInt(m[1]!, 10), body: [], noEol: false };
      cur.hunks.push(hunk);
      inHeader = false;
      i++;
      continue;
    }
    if (hunk !== null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection();
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        hunk.body.push(line);
        i++;
        continue;
      }
      endHunk();
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.dashOld = patchPath(line.slice(4));
        i++;
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.dashNew = patchPath(line.slice(4));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection();
      continue;
    }
    i++;
  }
  endHunk();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** O and N of one hunk, in body order (context lines belong to both). */
function hunkON(body: string[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b === '') {
      o.push('');
      n.push({ text: '', ctx: true, oIdx: o.length - 1 });
    } else if (b[0] === ' ') {
      const t = b.slice(1);
      o.push(t);
      n.push({ text: t, ctx: true, oIdx: o.length - 1 });
    } else if (b[0] === '-') {
      o.push(b.slice(1));
    } else if (b[0] === '+') {
      n.push({ text: b.slice(1), ctx: false, oIdx: -1 });
    }
    // `\` lines carry no line of their own; the noEol flag was taken at parse time.
  }
  return { o, n };
}

/** Apply one hunk to a file model; returns the new model and N.length - O.length. */
function applyHunk(model: FileModel, h: Hunk, d: number, strict: boolean, path: string): { model: FileModel; delta: number } {
  const { o, n } = hunkON(h.body);
  const lines = model.lines;
  if (o.length === 0) {
    const idx = Math.max(0, Math.min(h.a + d, lines.length));
    const ins = n.map((e) => e.text);
    const nl = [...lines.slice(0, idx), ...ins, ...lines.slice(idx)];
    const final = idx === lines.length ? !h.noEol : model.final;
    return { model: { br: model.br, lines: nl, final }, delta: n.length };
  }
  const found = findTier(lines, o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const rep = writeN(lines, best, o, n, found.tier);
  const nl = [...lines.slice(0, best), ...rep, ...lines.slice(best + o.length)];
  const runsToEnd = best + o.length === lines.length;
  const final = runsToEnd ? !h.noEol : model.final;
  return { model: { br: model.br, lines: nl, final }, delta: n.length - o.length };
}

function unifiedSectionEdit(s: RawSection, strict: boolean): Edit {
  let old: string | null | undefined = s.dashOld !== undefined ? s.dashOld : s.renameFrom !== undefined ? s.renameFrom : s.gitOld;
  let nw: string | null | undefined = s.dashNew !== undefined ? s.dashNew : s.renameTo !== undefined ? s.renameTo : s.gitNew;
  if (old === undefined && nw !== undefined) old = nw;
  if (nw === undefined && old !== undefined) nw = old;
  const oldPath: string | null = old ?? null;
  const newPath: string | null = nw ?? null;
  return (tree) => {
    if (oldPath === null && newPath === null) return;
    if (oldPath === null || s.newFile) {
      // Creation: the `+` lines of all its hunks, in order.
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noEol = false;
      for (const h of s.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const b = h.body[k]!;
          if (b[0] === '+') {
            plus.push(b.slice(1));
            noEol = k + 1 < h.body.length && h.body[k + 1]!.startsWith('\\');
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (newPath === null || s.delFile) {
      // Deletion: hunks are not read.
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldPath!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (newPath !== p && !safe(newPath)) throw new Fail('unsafe', newPath);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    if (newPath !== p && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    let model = splitFile(text);
    let d = 0;
    for (const h of s.hunks) {
      const r = applyHunk(model, h, d, strict, p);
      model = r.model;
      d += r.delta;
    }
    const out = joinFile(model);
    if (newPath !== p) {
      tree.now.set(p, null);
      tree.now.set(newPath, out);
      tree.moves.push([p, newPath]);
    } else {
      tree.now.set(p, out);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const model = splitFile(text);
    const found = findTier(model.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const rep = writeN(model.lines, pos, oldLines, n, found.tier);
    const nl = [...model.lines.slice(0, pos), ...rep, ...model.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ br: model.br, lines: nl, final: model.final }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  /** Anchor text, or null for no anchor. */
  anchor: string | null;
  /** Anchored to the end of the file (`*** End of File`). */
  eof: boolean;
  body: Array<{ t: string; no: number }>;
}

const V4A_SECTION = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const raw: Array<{ t: string; no: number }> = [];
      while (i < last) {
        const l = lines[i]!;
        if (V4A_SECTION(l) || l.trim() === '*** End Patch') break;
        raw.push({ t: l, no: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[0]!.t)) raw.shift();
      while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.t === '') fileLines.push('');
        else if (r.t.startsWith('+')) fileLines.push(r.t.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      const raw: Array<{ t: string; no: number }> = [];
      while (i < last) {
        const l = lines[i]!;
        if (V4A_SECTION(l) || l.trim() === '*** End Patch') break;
        raw.push({ t: l, no: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[0]!.t)) raw.shift();
      while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateNo = i + 1;
      i++;
      const raw: Array<{ t: string; no: number }> = [];
      while (i < last) {
        const l = lines[i]!;
        if (V4A_SECTION(l) || l.trim() === '*** End Patch') break;
        raw.push({ t: l, no: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[0]!.t)) raw.shift();
      while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
      let moveTo: string | null = null;
      let idx = 0;
      if (idx < raw.length && raw[idx]!.t.startsWith('*** Move to: ')) {
        moveTo = raw[idx]!.t.slice('*** Move to: '.length).trim();
        idx++;
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      let firstChunk = true;
      while (idx < raw.length) {
        const r = raw[idx]!;
        const t = r.t;
        if (t.startsWith('@@')) {
          const a = t.slice(2).trim();
          chunk = { anchor: a === '' ? null : a, eof: false, body: [] };
          chunks.push(chunk);
          firstChunk = false;
          idx++;
          continue;
        }
        if (t === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${r.no}`);
          chunk.eof = true;
          chunk = null;
          idx++;
          continue;
        }
        if (t.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${r.no}`);
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (chunk === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${r.no}`);
            chunk = { anchor: null, eof: false, body: [] };
            chunks.push(chunk);
            firstChunk = false;
          }
          chunk.body.push(r);
          idx++;
          continue;
        }
        throw new Exit2(`error: parse ${r.no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = splitFile(text);
    let lines = model.lines;
    let cursor = 0;
    const maxTier = strict ? 0 : 2;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const a = ch.anchor;
        let foundIdx = -1;
        for (let t = 0; t <= maxTier && foundIdx < 0; t++) {
          for (let j = cursor; j < lines.length; j++) {
            if (norm(lines[j]!, t) === norm(a, t)) {
              foundIdx = j;
              break;
            }
          }
        }
        if (foundIdx < 0) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      const o: string[] = [];
      const n: NLine[] = [];
      for (const r of ch.body) {
        const b = r.t;
        if (b === '') {
          o.push('');
          n.push({ text: '', ctx: true, oIdx: o.length - 1 });
        } else if (b[0] === ' ') {
          const t = b.slice(1);
          o.push(t);
          n.push({ text: t, ctx: true, oIdx: o.length - 1 });
        } else if (b[0] === '-') {
          o.push(b.slice(1));
        } else if (b[0] === '+') {
          n.push({ text: b.slice(1), ctx: false, oIdx: -1 });
        }
      }
      if (o.length === 0) {
        const idx = ch.eof ? lines.length : cursor;
        const ins = n.map((e) => e.text);
        lines = [...lines.slice(0, idx), ...ins, ...lines.slice(idx)];
        cursor = idx + ins.length;
      } else {
        let found: { tier: number; pos: number } | null = null;
        for (let t = 0; t <= maxTier; t++) {
          const occ = occurrences(lines, o, t).filter((p) => p >= cursor && (!ch.eof || p + o.length === lines.length));
          if (occ.length > 0) {
            found = { tier: t, pos: occ[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', path);
        const rep = writeN(lines, found.pos, o, n, found.tier);
        lines = [...lines.slice(0, found.pos), ...rep, ...lines.slice(found.pos + o.length)];
        cursor = found.pos + rep.length;
      }
    }
    const out = joinFile({ br: model.br, lines, final: model.final });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Driver (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows, in byte order of the paths (an `R` line sorts by its new path).
  const rows: Array<{ key: string; line: string }> = [];
  const consumed = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
