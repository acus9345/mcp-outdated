// A small TOML parser covering what MCP client configs (Codex config.toml)
// actually use: tables, array-of-tables, dotted/quoted keys, basic/literal/
// multi-line strings, arrays, inline tables, numbers, booleans, dates.
// Like the JSONC parser it records the source span of every string value.
import { ParseError, lineCol, pathKey, safeSet } from './errors.js';

const BARE_KEY = /[A-Za-z0-9_-]/;

export function parseToml(text) {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const root = {};
  const spans = new Map();
  const explicitTables = new Set();
  let current = root;
  let currentPath = [];

  const fail = (msg, at = i) => {
    const { line, col } = lineCol(text, at);
    return new ParseError(msg, line, col);
  };

  const skipSpaces = () => {
    while (text[i] === ' ' || text[i] === '\t') i++;
  };
  const skipComment = () => {
    if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++;
  };
  // whitespace, newlines and comments (used between statements and inside arrays)
  const skipAll = () => {
    for (;;) {
      skipSpaces();
      skipComment();
      if (text[i] === '\n') i++;
      else if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
      else break;
    }
  };
  const endOfLine = () => {
    skipSpaces();
    skipComment();
    if (i >= text.length) return;
    if (text[i] === '\n') return void i++;
    if (text[i] === '\r' && text[i + 1] === '\n') return void (i += 2);
    throw fail('expected end of line');
  };

  function escape() {
    // at backslash inside a basic string
    const n = text[i + 1];
    const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };
    if (n in simple) {
      i += 2;
      return simple[n];
    }
    if (n === 'u' || n === 'U') {
      const len = n === 'u' ? 4 : 8;
      const hex = text.slice(i + 2, i + 2 + len);
      if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) throw fail('invalid unicode escape');
      i += 2 + len;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    throw fail('invalid escape sequence');
  }

  function basicString() {
    const start = i;
    i++;
    let out = '';
    for (;;) {
      if (i >= text.length || text[i] === '\n') throw fail('unterminated string', start);
      const c = text[i];
      if (c === '"') {
        i++;
        return { value: out, start, end: i, style: '"' };
      }
      if (c === '\\') out += escape();
      else {
        out += c;
        i++;
      }
    }
  }

  function literalString() {
    const start = i;
    const end = text.indexOf("'", i + 1);
    const nl = text.indexOf('\n', i + 1);
    if (end < 0 || (nl >= 0 && nl < end)) throw fail('unterminated string', start);
    i = end + 1;
    return { value: text.slice(start + 1, end), start, end: i, style: "'" };
  }

  function multiline(delim) {
    const start = i;
    i += 3;
    if (text[i] === '\n') i++;
    else if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
    let out = '';
    for (;;) {
      if (i >= text.length) throw fail('unterminated multi-line string', start);
      if (text.startsWith(delim, i)) {
        // allow up to two extra quote chars right before the closing delimiter
        let extra = 0;
        while (extra < 2 && text[i + 3 + extra] === delim[0]) extra++;
        out += delim[0].repeat(extra);
        i += 3 + extra;
        return { value: out, start, end: i, style: delim };
      }
      if (delim === '"""' && text[i] === '\\') {
        // line-ending backslash trims following whitespace
        const m = /^\\[ \t]*\r?\n[\s]*/.exec(text.slice(i, i + 200));
        if (m) {
          i += m[0].length;
          continue;
        }
        out += escape();
        continue;
      }
      out += text[i++];
    }
  }

  function key() {
    const parts = [];
    for (;;) {
      skipSpaces();
      const c = text[i];
      if (c === '"') parts.push(basicString().value);
      else if (c === "'") parts.push(literalString().value);
      else {
        const s = i;
        while (i < text.length && BARE_KEY.test(text[i])) i++;
        if (s === i) throw fail('expected a key');
        parts.push(text.slice(s, i));
      }
      skipSpaces();
      if (text[i] === '.') {
        i++;
        continue;
      }
      return parts;
    }
  }

  function descend(base, parts, at) {
    let obj = base;
    for (const p of parts) {
      let next = Object.prototype.hasOwnProperty.call(obj, p) ? obj[p] : undefined;
      if (next === undefined) {
        next = {};
        safeSet(obj, p, next);
      } else if (Array.isArray(next)) {
        next = next[next.length - 1];
        if (!next || typeof next !== 'object') throw fail(`key "${p}" is not a table`, at);
      } else if (typeof next !== 'object' || next === null) {
        throw fail(`key "${p}" is already a value`, at);
      }
      obj = next;
    }
    return obj;
  }

  function scalarToken() {
    const s = i;
    while (i < text.length && !/[,\]}\s#]/.test(text[i])) i++;
    // dates with a space separator: 1979-05-27 07:32:00
    if (/^\d{4}-\d{2}-\d{2}$/.test(text.slice(s, i)) && /^ \d{2}:\d{2}/.test(text.slice(i, i + 6))) {
      i++;
      while (i < text.length && !/[,\]}\s#]/.test(text[i])) i++;
    }
    return { raw: text.slice(s, i), start: s };
  }

  function value(path, depth) {
    if (depth > 100) throw fail('nesting too deep');
    const c = text[i];
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      const s = multiline(text.slice(i, i + 3));
      spans.set(pathKey(path), { start: s.start, end: s.end, style: s.style });
      return s.value;
    }
    if (c === '"' || c === "'") {
      const s = c === '"' ? basicString() : literalString();
      spans.set(pathKey(path), { start: s.start, end: s.end, style: s.style });
      return s.value;
    }
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        skipAll();
        if (text[i] === ']') {
          i++;
          return arr;
        }
        if (i >= text.length) throw fail('unterminated array');
        arr.push(value([...path, arr.length], depth + 1));
        skipAll();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return arr;
        }
        throw fail('expected "," or "]" in array');
      }
    }
    if (c === '{') {
      i++;
      const obj = {};
      skipSpaces();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        skipAll();
        if (text[i] === '}') {
          i++;
          return obj;
        }
        const at = i;
        const parts = key();
        if (text[i] !== '=') throw fail('expected "=" in inline table');
        i++;
        skipSpaces();
        const target = descend(obj, parts.slice(0, -1), at);
        safeSet(target, parts[parts.length - 1], value([...path, ...parts], depth + 1));
        skipAll();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return obj;
        }
        throw fail('expected "," or "}" in inline table');
      }
    }
    const { raw, start } = scalarToken();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(inf|nan)$/.test(raw)) return raw.includes('nan') ? NaN : raw.startsWith('-') ? -Infinity : Infinity;
    if (/^0x[0-9a-fA-F_]+$/.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 16);
    if (/^0o[0-7_]+$/.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 8);
    if (/^0b[01_]+$/.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 2);
    if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d[\d_]*)?$/.test(raw)) return Number(raw.replace(/_/g, ''));
    if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/i.test(raw) || /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw)) return raw;
    if (raw === '') throw fail('expected a value', start);
    throw fail('invalid value (unquoted string?)', start); // never echo the value: it may be a secret
  }

  for (;;) {
    skipAll();
    if (i >= text.length) break;
    const at = i;
    if (text[i] === '[') {
      const isArray = text[i + 1] === '[';
      i += isArray ? 2 : 1;
      const parts = key();
      if (isArray ? !text.startsWith(']]', i) : text[i] !== ']') throw fail(`expected "${isArray ? ']]' : ']'}"`);
      i += isArray ? 2 : 1;
      endOfLine();
      if (isArray) {
        const parent = descend(root, parts.slice(0, -1), at);
        const last = parts[parts.length - 1];
        let arr = Object.prototype.hasOwnProperty.call(parent, last) ? parent[last] : undefined;
        if (arr === undefined) {
          arr = [];
          safeSet(parent, last, arr);
        } else if (!Array.isArray(arr)) throw fail(`"${parts.join('.')}" is not an array of tables`, at);
        current = {};
        arr.push(current);
        currentPath = [...parts, arr.length - 1];
      } else {
        const k = pathKey(parts);
        if (explicitTables.has(k)) throw fail(`table [${parts.join('.')}] defined twice`, at);
        explicitTables.add(k);
        current = descend(root, parts, at);
        currentPath = parts;
      }
      continue;
    }
    const parts = key();
    if (text[i] !== '=') throw fail('expected "=" after key');
    i++;
    skipSpaces();
    const target = descend(current, parts.slice(0, -1), at);
    const last = parts[parts.length - 1];
    if (Object.prototype.hasOwnProperty.call(target, last)) throw fail(`duplicate key "${parts.join('.')}"`, at);
    safeSet(target, last, value([...currentPath, ...parts], 0));
    endOfLine();
  }
  return { value: root, spans };
}

/** Encode a string as a TOML string literal in the given quote style. */
export function tomlString(value, style) {
  if (style === "'" && !/['\n\r]/.test(value)) return `'${value}'`;
  return '"' + value.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => {
    const map = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\t': '\\t', '\r': '\\r', '\b': '\\b', '\f': '\\f' };
    return map[c] || '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
  }) + '"';
}
