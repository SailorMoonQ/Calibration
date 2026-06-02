#!/usr/bin/env node
// Asserts that the English and Chinese translation catalogs have identical key
// sets. The renderer has no test runner, so this is the guardrail against a
// string being added/renamed in one language but not the other.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'renderer', 'src', 'i18n');

const load = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

// Flatten nested objects into dotted leaf paths.
function keys(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...keys(v, path));
    else out.push(path);
  }
  return out;
}

const en = new Set(keys(load('en.json')));
const zh = new Set(keys(load('zh.json')));

const missingInZh = [...en].filter((k) => !zh.has(k)).sort();
const missingInEn = [...zh].filter((k) => !en.has(k)).sort();

if (missingInZh.length || missingInEn.length) {
  if (missingInZh.length) console.error(`Missing in zh.json (${missingInZh.length}):\n  ` + missingInZh.join('\n  '));
  if (missingInEn.length) console.error(`Missing in en.json (${missingInEn.length}):\n  ` + missingInEn.join('\n  '));
  process.exit(1);
}

console.log(`i18n key parity OK — ${en.size} keys in both en.json and zh.json`);
