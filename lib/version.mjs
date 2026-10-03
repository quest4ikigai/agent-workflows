// Version information shared by the CLI and the templates.
//
// The CLI and the reusable workflows are released together: CLI version
// X.Y.Z generates wrappers that reference the moving major tag vX by default.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

export const VERSION = pkg.version;
export const DEFAULT_REF = `v${VERSION.split('.')[0]}`;

/** 'major' (v1), 'release' (v1.2.3, v1.2.3-rc.1), 'sha' (full commit), or 'branch'. */
export function classifyRef(ref) {
  if (/^v\d+$/.test(ref)) return 'major';
  if (/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(ref)) return 'release';
  if (/^[0-9a-f]{40}$/.test(ref)) return 'sha';
  return 'branch';
}
