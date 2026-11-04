export class ParseError extends Error {
  constructor(message, line, col) {
    super(message);
    this.name = 'ParseError';
    this.line = line;
    this.col = col;
  }
}

export function lineCol(text, index) {
  let line = 1;
  let last = -1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, col: index - last };
}

/** Stable key for a value path such as ["mcpServers", "fs", "args", 1]. */
export function pathKey(path) {
  return JSON.stringify(path);
}

/** Assign without ever touching Object.prototype (config keys are untrusted). */
export function safeSet(obj, key, value) {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}
