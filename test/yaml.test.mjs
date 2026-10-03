import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseYaml, YamlError } from '../lib/yaml.mjs';

test('parses nested mappings, lists and scalars', () => {
  const doc = parseYaml(`
# comment
version: 1
base_branch: main   # trailing comment
enabled: true
disabled: false
nothing: null
tilde: ~
empty:
implementation:
  model: sonnet
  max_turns: 40
trusted_users:
  - alice
  - "bob"
context: [CLAUDE.md, 'AGENTS.md']
none: []
`);
  assert.deepEqual(doc, {
    version: 1,
    base_branch: 'main',
    enabled: true,
    disabled: false,
    nothing: null,
    tilde: null,
    empty: null,
    implementation: { model: 'sonnet', max_turns: 40 },
    trusted_users: ['alice', 'bob'],
    context: ['CLAUDE.md', 'AGENTS.md'],
    none: [],
  });
});

test('lists may sit at the same indentation as their key', () => {
  assert.deepEqual(parseYaml('context:\n- CLAUDE.md\n- AGENTS.md\nnext: 1\n'), { context: ['CLAUDE.md', 'AGENTS.md'], next: 1 });
});

test('decimals stay strings so versions are not rounded', () => {
  const doc = parseYaml('python: 3.10\nnode: 22\nquoted: "22"\n');
  assert.equal(doc.python, '3.10');
  assert.equal(doc.node, 22);
  assert.equal(doc.quoted, '22');
});

test('quoted strings support escapes and keep # characters', () => {
  const doc = parseYaml(`a: "x # not a comment"\nb: 'it''s'\nc: "tab\\tnew\\nline \\u00e9"\nd: http://x#y\n`);
  assert.equal(doc.a, 'x # not a comment');
  assert.equal(doc.b, "it's");
  assert.equal(doc.c, 'tab\tnew\nline é');
  assert.equal(doc.d, 'http://x#y');
});

test('empty and comment-only documents are empty mappings', () => {
  assert.deepEqual(parseYaml(''), {});
  assert.deepEqual(parseYaml('# only\n\n---\n'), {});
});

const rejects = [
  ['tabs', 'a:\n\tb: 1\n', /tabs/],
  ['duplicate keys', 'a: 1\na: 2\n', /duplicate key "a"/],
  ['block scalars', 'a: |\n  text\n', /block scalars/],
  ['folded scalars', 'a: >-\n  text\n', /block scalars/],
  ['anchors', 'a: &x 1\n', /anchors/],
  ['aliases', 'a: *x\n', /anchors/],
  ['flow mappings', 'a: {b: 1}\n', /flow mappings/],
  ['lists of mappings', 'a:\n  - b: 1\n', /lists of mappings/],
  ['bad indentation', 'a: 1\n  b: 2\n', /indentation/],
  ['unterminated quotes', 'a: "abc\n', /unterminated/],
  ['missing colon', 'just text\n', /expected "key: value"/],
  ['colon in plain value', 'a: b: c\n', /quote the value/],
  ['multiple documents', 'a: 1\n---\nb: 2\n', /multiple documents/],
  ['prototype keys', '__proto__: 1\n', /not allowed/],
  ['indented document', '  a: 1\n', /column 1/],
];

for (const [name, text, pattern] of rejects) {
  test(`rejects ${name}`, () => {
    assert.throws(() => parseYaml(text), (err) => err instanceof YamlError && pattern.test(err.message));
  });
}

test('errors report line numbers', () => {
  assert.throws(() => parseYaml('a: 1\nb: 2\nb: 3\n'), /line 3/);
});
