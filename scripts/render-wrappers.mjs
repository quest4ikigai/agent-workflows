#!/usr/bin/env node
// Development helper: render the consumer wrappers so actionlint can check them
// against the reusable workflows in this repository.
//
//   node scripts/render-wrappers.mjs <output-prefix> [--local]
//
// With --local the wrappers call ./.github/workflows/<file>, which lets
// actionlint verify the secrets/permissions wiring end to end.

import { writeFileSync } from 'node:fs';
import { WRAPPERS, renderWrapper } from '../lib/templates.mjs';
import { DEFAULT_REF } from '../lib/version.mjs';

const args = process.argv.slice(2);
const local = args.includes('--local');
const prefix = args.find((a) => !a.startsWith('--'));
if (!prefix) {
  process.stderr.write('usage: render-wrappers.mjs <output-prefix> [--local]\n');
  process.exit(2);
}
for (const w of WRAPPERS) {
  const file = `${prefix}${w.template}.yml`;
  writeFileSync(file, renderWrapper(w.template, { ref: DEFAULT_REF, uses: local ? 'local' : 'remote' }));
  process.stdout.write(`${file}\n`);
}
