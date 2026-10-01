/**
 * The gzip size of the built app, reported against the plan's target of 250 KB.
 *
 * The target counts what the first screen loads: the eager load, which is the entry script, its
 * stylesheet and every chunk `dist/index.html` preloads, plus the chunks the default first
 * workspace (Overview) needs, with their static imports and stylesheets. Fonts and the demo
 * robot are not counted in it; the total of every script and stylesheet is printed for
 * reference.
 *
 * It also reports the largest chunk before gzip against the chunk size Vite warns past
 * (`CHUNK_SIZE_WARNING_KB`, in kB of 1000 bytes, as Vite counts them).
 *
 * Run with `bun run size` after `bun run build`. It only reports; it never fails the check.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { CHUNK_SIZE_WARNING_KB } from '../vite.config';

const TARGET_KB = 250;
const DIST = join(import.meta.dirname, '..', 'dist');
const FIRST_WORKSPACE = ['plot-window', 'blob-view-window', 'maze-view'];
const KB = 1024;

function gzipBytes(file: string): number {
  return gzipSync(readFileSync(join(DIST, file)), { level: 9 }).length;
}

function references(html: string, pattern: RegExp): string[] {
  return [...html.matchAll(pattern)].map((match) => match[1]).filter((path) => path !== undefined);
}

function staticImports(file: string): string[] {
  const source = readFileSync(join(DIST, file), 'utf8');
  return [...source.matchAll(/(?:from|import)\s*["'`]\.\/([^"'`]+\.js)["'`]/g)].map((match) => {
    const [, name] = match;
    return `assets/${name}`;
  });
}

function closure(roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const pending = [...roots];

  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (!seen.has(file)) {
      seen.add(file);
      pending.push(...staticImports(file));
    }
  }

  return seen;
}

function sum(files: Iterable<string>): number {
  let total = 0;

  for (const file of files) {
    total += gzipBytes(file);
  }

  return total;
}

function kb(bytes: number): string {
  return `${(bytes / KB).toFixed(1)} KB`;
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const entry = references(html, /<script[^>]*\ssrc="\/([^"]+)"/g);
const preloaded = references(html, /<link rel="modulepreload"[^>]*\shref="\/([^"]+)"/g);
const stylesheets = references(html, /<link rel="stylesheet"[^>]*\shref="\/([^"]+)"/g);
const assets = readdirSync(join(DIST, 'assets')).map((name) => `assets/${name}`);

const eager = new Set([...entry, ...preloaded, ...stylesheets]);
const needed = closure(
  assets.filter(
    (file) =>
      file.endsWith('.js') && FIRST_WORKSPACE.some((name) => file.startsWith(`assets/${name}-`))
  )
);
const neededStyles = assets.filter(
  (file) =>
    file.endsWith('.css') && FIRST_WORKSPACE.some((name) => file.startsWith(`assets/${name}-`))
);
const firstWorkspace = new Set(
  [...needed, ...neededStyles].filter((file) => !eager.has(file) && !file.endsWith('.woff2'))
);
const everything = assets.filter((file) => file.endsWith('.js') || file.endsWith('.css'));

const indexBytes = sum(entry);
const eagerBytes = sum(eager);
const firstBytes = sum(firstWorkspace);
const totalBytes = sum(everything);
const counted = eagerBytes + firstBytes;

console.log(`index            ${kb(indexBytes)}`);
console.log(`eager            ${kb(eagerBytes)}  (${eager.size} files)`);
console.log(`first workspace  ${kb(firstBytes)}  (${firstWorkspace.size} files)`);
console.log(`total            ${kb(totalBytes)}  (${everything.length} files)`);
console.log(
  `counted          ${kb(counted)} of the ${TARGET_KB} KB target (eager + first workspace)`
);

const [largest] = everything
  .filter((file) => file.endsWith('.js'))
  .map((file) => ({ file, kB: statSync(join(DIST, file)).size / 1000 }))
  .toSorted((left, right) => right.kB - left.kB);

if (largest !== undefined) {
  console.log(
    `largest chunk    ${largest.kB.toFixed(1)} kB before gzip of the ${CHUNK_SIZE_WARNING_KB} kB warning limit (${largest.file})`
  );
}
