// Strict YAML-subset parser for .github/agent/config.yml.
//
// The same parser runs in the CLI (`agent-workflows check`) and inside the
// reusable workflows, so a config that passes locally behaves identically in CI.
// Supporting only a small, explicit subset keeps it dependency-free and makes
// mistakes fail loudly instead of being silently misread.
//
// Supported:
//   - block mappings (`key: value`, nested by indentation with spaces)
//   - block sequences of scalars (`- value`)
//   - flow sequences of scalars (`[a, "b", 3]`, `[]`)
//   - scalars: plain, 'single-quoted', "double-quoted"
//   - true/false, null/~ /empty, integers
//   - `#` comments and an optional leading `---`
//
// Deliberately unsupported (rejected with an error): tabs for indentation,
// anchors/aliases/tags, block scalars (| and >), flow mappings, sequences of
// mappings, multiple documents, duplicate keys.
//
// Plain scalars that look like decimals (e.g. 3.10) are returned as strings, so
// version numbers are never silently rounded.

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/;

export function parseYaml(text) {
  if (typeof text !== 'string') throw new YamlError('expected text');
  const lines = tokenize(text.replace(/^﻿/, '').replace(/\r\n?/g, '\n'));
  if (lines.length === 0) return {};
  const state = { lines, i: 0 };
  if (lines[0].indent !== 0) {
    throw new YamlError('document must start at column 1', lines[0].line);
  }
  const value = parseBlock(state, 0);
  if (state.i < lines.length) {
    throw new YamlError('unexpected content (check indentation)', lines[state.i].line);
  }
  return value;
}

function tokenize(text) {
  const out = [];
  const raw = text.split('\n');
  let sawContent = false;
  for (let n = 0; n < raw.length; n++) {
    const lineNo = n + 1;
    const line = raw[n];
    const leading = line.match(/^[ \t]*/)[0];
    if (leading.includes('\t')) {
      if (line.trim() === '') continue;
      throw new YamlError('tabs are not allowed for indentation; use spaces', lineNo);
    }
    const content = stripComment(line.slice(leading.length), lineNo).trimEnd();
    if (content === '') continue;
    if (content === '---') {
      if (sawContent) throw new YamlError('multiple documents are not supported', lineNo);
      continue;
    }
    if (content === '...') throw new YamlError('document end markers are not supported', lineNo);
    sawContent = true;
    out.push({ indent: leading.length, text: content, line: lineNo });
  }
  return out;
}

function stripComment(s, lineNo) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = null;
    } else if (quote === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") i++;
        else quote = null;
      }
    } else if (c === '"' || c === "'") {
      // Quotes only open a quoted scalar at the start of a value.
      const before = s.slice(0, i).trimEnd();
      if (before === '' || before.endsWith(':') || before.endsWith('-') || before.endsWith('[') || before.endsWith(',')) {
        quote = c;
      }
    } else if (c === '#' && (i === 0 || s[i - 1] === ' ')) {
      return s.slice(0, i);
    }
  }
  if (quote) throw new YamlError('unterminated quoted string', lineNo);
  return s;
}

function isSeqItem(text) {
  return text === '-' || text.startsWith('- ');
}

function parseBlock(state, indent) {
  const first = state.lines[state.i];
  return isSeqItem(first.text) ? parseSequence(state, indent) : parseMapping(state, indent);
}

function parseMapping(state, indent) {
  const result = {};
  while (state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError('unexpected indentation', line.line);
    if (isSeqItem(line.text)) throw new YamlError('expected "key: value", found a list item', line.line);

    const { key, rest } = splitKey(line);
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new YamlError(`key "${key}" is not allowed`, line.line);
    }
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new YamlError(`duplicate key "${key}"`, line.line);
    }
    state.i++;

    if (rest !== '') {
      result[key] = parseInlineValue(rest, line.line);
      continue;
    }

    const next = state.lines[state.i];
    if (next && next.indent > indent) {
      result[key] = parseBlock(state, next.indent);
    } else if (next && next.indent === indent && isSeqItem(next.text)) {
      // YAML allows a list to sit at the same indentation as its parent key.
      result[key] = parseSequence(state, indent);
    } else {
      result[key] = null;
    }
  }
  return result;
}

function parseSequence(state, indent) {
  const result = [];
  while (state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError('unexpected indentation inside list', line.line);
    if (!isSeqItem(line.text)) break;
    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    state.i++;
    if (rest === '') {
      const next = state.lines[state.i];
      if (next && next.indent > indent) {
        throw new YamlError('nested blocks inside lists are not supported', next.line);
      }
      result.push(null);
      continue;
    }
    if (looksLikeMappingEntry(rest)) {
      throw new YamlError('lists of mappings are not supported; use a list of plain values', line.line);
    }
    result.push(parseInlineValue(rest, line.line));
  }
  return result;
}

function splitKey(line) {
  const text = line.text;
  let key;
  let restStart;
  if (text[0] === '"' || text[0] === "'") {
    const end = findQuoteEnd(text, 0);
    if (end < 0) throw new YamlError('unterminated quoted key', line.line);
    key = parseQuoted(text.slice(0, end + 1), line.line);
    if (text[end + 1] !== ':') throw new YamlError('expected ":" after key', line.line);
    restStart = end + 2;
  } else {
    const idx = findMappingColon(text);
    if (idx < 0) throw new YamlError(`expected "key: value", found "${text}"`, line.line);
    key = text.slice(0, idx).trim();
    if (!KEY_RE.test(key)) throw new YamlError(`invalid key "${key}"`, line.line);
    restStart = idx + 1;
  }
  const rest = text.slice(restStart);
  if (rest !== '' && rest[0] !== ' ') throw new YamlError('expected a space after ":"', line.line);
  return { key, rest: rest.trim() };
}

function findMappingColon(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ':' && (i === text.length - 1 || text[i + 1] === ' ')) return i;
  }
  return -1;
}

function looksLikeMappingEntry(text) {
  if (text[0] === '"' || text[0] === "'" || text[0] === '[') return false;
  return findMappingColon(text) > 0;
}

function findQuoteEnd(text, start) {
  const q = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (q === '"' && text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === q) {
      if (q === "'" && text[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function parseInlineValue(text, lineNo) {
  const c = text[0];
  if (c === '[') return parseFlowSequence(text, lineNo);
  if (c === '{') throw new YamlError('flow mappings ({...}) are not supported', lineNo);
  if (c === '|' || c === '>') throw new YamlError('block scalars (| and >) are not supported; use a quoted string', lineNo);
  if (c === '&' || c === '*' || c === '!') throw new YamlError('anchors, aliases and tags are not supported', lineNo);
  return parseScalar(text, lineNo);
}

function parseFlowSequence(text, lineNo) {
  if (!text.endsWith(']')) throw new YamlError('unterminated flow list (multi-line [ ] lists are not supported)', lineNo);
  const inner = text.slice(1, -1).trim();
  if (inner === '') return [];
  const items = [];
  let i = 0;
  while (i < inner.length) {
    while (inner[i] === ' ') i++;
    let end;
    if (inner[i] === '"' || inner[i] === "'") {
      const q = findQuoteEnd(inner, i);
      if (q < 0) throw new YamlError('unterminated quoted string in list', lineNo);
      end = q + 1;
    } else {
      end = inner.indexOf(',', i);
      if (end < 0) end = inner.length;
    }
    const item = inner.slice(i, end).trim();
    if (item === '') throw new YamlError('empty item in flow list', lineNo);
    if (item[0] === '[' || item[0] === '{') throw new YamlError('nested flow collections are not supported', lineNo);
    items.push(parseScalar(item, lineNo));
    i = end;
    while (inner[i] === ' ') i++;
    if (i < inner.length) {
      if (inner[i] !== ',') throw new YamlError('expected "," between list items', lineNo);
      i++;
    }
  }
  return items;
}

function parseScalar(text, lineNo) {
  if (text[0] === '"' || text[0] === "'") {
    const end = findQuoteEnd(text, 0);
    if (end !== text.length - 1) throw new YamlError('unexpected characters after quoted string', lineNo);
    return parseQuoted(text, lineNo);
  }
  if (/^[@`%]/.test(text)) throw new YamlError(`plain values may not start with "${text[0]}"; quote the value`, lineNo);
  if (findMappingColon(text) >= 0) throw new YamlError('plain values may not contain ": "; quote the value', lineNo);
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^(null|Null|NULL|~)$/.test(text)) return null;
  if (/^[-+]?[0-9]+$/.test(text)) {
    const n = Number(text);
    if (!Number.isSafeInteger(n)) throw new YamlError('integer out of range', lineNo);
    return n;
  }
  return text;
}

function parseQuoted(text, lineNo) {
  const q = text[0];
  const body = text.slice(1, -1);
  if (q === "'") return body.replace(/''/g, "'");
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = body[++i];
    switch (e) {
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '0': out += '\0'; break;
      case 'u': {
        const hex = body.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new YamlError('invalid \\u escape', lineNo);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        throw new YamlError(`unsupported escape "\\${e ?? ''}"`, lineNo);
    }
  }
  return out;
}
