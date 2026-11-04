// Minimal JSON-with-comments parser that also records the exact source span
// of every string value, so --pin can rewrite a single token byte-for-byte.
import { ParseError, lineCol, pathKey, safeSet } from './errors.js';

const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

export function parseJsonc(text) {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const spans = new Map();

  const fail = (msg, at = i) => {
    const { line, col } = lineCol(text, at);
    return new ParseError(msg, line, col);
  };

  function ws() {
    while (i < text.length) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
      else if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) throw fail('unterminated block comment');
        i = end + 2;
      } else break;
    }
  }

  function str() {
    const start = i;
    i++;
    let out = '';
    for (;;) {
      if (i >= text.length) throw fail('unterminated string', start);
      const c = text[i];
      if (c === '"') {
        i++;
        break;
      }
      if (c === '\\') {
        const n = text[i + 1];
        if (n in ESCAPES) {
          out += ESCAPES[n];
          i += 2;
        } else if (n === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw fail('invalid unicode escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else throw fail('invalid escape sequence');
        continue;
      }
      if (c === '\n') throw fail('unterminated string', start);
      out += c;
      i++;
    }
    return { value: out, start, end: i };
  }

  function value(path, depth) {
    if (depth > 200) throw fail('nesting too deep');
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj = {};
      for (;;) {
        ws();
        if (text[i] === '}') {
          i++;
          return obj;
        }
        if (text[i] !== '"') throw fail('expected property name or "}"');
        const key = str().value;
        ws();
        if (text[i] !== ':') throw fail('expected ":"');
        i++;
        safeSet(obj, key, value([...path, key], depth + 1));
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return obj;
        }
        throw fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        ws();
        if (text[i] === ']') {
          i++;
          return arr;
        }
        arr.push(value([...path, arr.length], depth + 1));
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return arr;
        }
        throw fail('expected "," or "]"');
      }
    }
    if (c === '"') {
      const s = str();
      spans.set(pathKey(path), { start: s.start, end: s.end, style: 'json' });
      return s.value;
    }
    const rest = text.slice(i, i + 64);
    let m;
    if ((m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest))) {
      i += m[0].length;
      return Number(m[0]);
    }
    for (const [word, v] of [['true', true], ['false', false], ['null', null]]) {
      if (rest.startsWith(word)) {
        i += word.length;
        return v;
      }
    }
    if (i >= text.length) throw fail('unexpected end of input');
    throw fail(`unexpected character ${JSON.stringify(c)}`);
  }

  ws();
  if (i >= text.length) throw fail('empty document');
  const result = value([], 0);
  ws();
  if (i < text.length) throw fail('unexpected content after JSON value');
  return { value: result, spans };
}
