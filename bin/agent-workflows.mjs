#!/usr/bin/env node
import { main } from '../lib/cli.mjs';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`agent-workflows: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  },
);
