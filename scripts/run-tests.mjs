#!/usr/bin/env node
// Runs the renderer's `node:test` suite with an explicit file list rather than
// `node --test <dir>` or a glob string, because neither is portable across the
// Node versions in play here:
//   - `node --test renderer/src`                → works on Node 20, but Node 22
//     and 24 throw MODULE_NOT_FOUND trying to require() the directory itself
//     instead of recursively discovering test files in it.
//   - `node --test 'renderer/src/**/*.test.js'`  → works on Node 22/24, but
//     Node 20 doesn't expand the glob and fails to find any tests.
// Explicit file paths passed as positional args to `node --test` work
// identically on every version, so this script does the recursive walk itself
// and hands `node --test` the resolved list. CI pins Node 20; developers here
// commonly run Node 22/24 — this has to work on both. Do not "simplify" this
// back into `node --test <dir>` or a glob; it will silently break on whichever
// Node version isn't covered by whoever tests the change.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const srcDir = join(root, 'renderer', 'src');

const SKIP_DIRS = new Set(['node_modules', 'dist']);

function collectTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collectTestFiles(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const files = collectTestFiles(srcDir).sort();

if (files.length === 0) {
  console.error(`No *.test.js files found under ${relative(root, srcDir)} — refusing to report a passing empty suite.`);
  process.exit(1);
}

console.log(`Running ${files.length} test file(s):`);
for (const f of files) console.log(`  ${relative(root, f)}`);

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
