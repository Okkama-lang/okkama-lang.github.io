// Okkama highlighting for the playground: a CodeMirror stream tokenizer that follows the VS Code extension's
// TextMate grammar (okkama-new: vscode-okkama/syntaxes/okkama.tmLanguage.json) rule by rule: fenced raw strings,
// comments, strings and escapes, numbers and versions, declarations (module, object, role, enum, native, hidden,
// once, cap), keywords by group, test assertions, enum cases, types, removed syntax, calls, operators.
// The same tokenizer colours static text (hover, Format, Expected) through highlightInto().

import { StringStream } from './vendor/codemirror.min.js';

const CONTROL = new Set(['if', 'else', 'match', 'case', 'for', 'loop', 'next', 'last', 'try', 'catch', 'confirm',
  'throw', 'panic', 'defer', 'return', 'await', 'spawn']);
const DECLARATION = new Set(['module', 'import', 'take', 'as', 'native', 'object', 'role', 'does', 'enum', 'has', 'is',
  'test', 'fake', 'destroy', 'let', 'const', 'cap']);
const PRIMITIVE = new Set(['int', 'float', 'rat', 'decimal', 'string', 'char', 'bool', 'byte', 'number', 'any', 'void']);
const BUILTIN_TYPE = new Set(['Maybe', 'Presence', 'Error', 'NativeFailure']);
const RESERVED = new Set(['isa', 'super', 'abstract', 'protected', 'null', 'none', 'nil', 'with', 'finally']);
const OPTIONAL_VARIANT = new Set(['some', 'none', 'missing']);
const ASSERTIONS = /^\s*\.\s*(?:ok|is|isnt|close|text|bytes|throws|fail|skip)\b/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;

/** Token names: the playground's classes are `ok-<name>`; tokenTable() maps them to CodeMirror tags. */
export const TOKENS = ['comment', 'string', 'escape', 'invalid', 'number', 'version', 'keyword', 'control',
  'modifier', 'bool', 'self', 'type', 'typeDef', 'primitive', 'namespace', 'enumCase', 'function', 'functionDef',
  'successor', 'operator', 'punct', 'property', 'assertion', 'collection'];

function startState() {
  return {
    inRaw: false, inBlock: false, quote: null,
    // What the previous token makes of the next identifier: 'namespace' after `module`, 'type' after
    // object/role/enum, 'function' after native, 'member' after `::`, 'assertion' after `test.`.
    expect: null,
    afterDot: false, afterType: false, depth: 0,
  };
}

function copyState(state) {
  return { ...state };
}

function readString(stream, state) {
  while (!stream.eol()) {
    if (stream.peek() === '\\') {
      // \n \r \t \" or \' \\ \u{…}; anything else after a backslash is an invalid escape.
      if (stream.pos > stream.start) return 'string';
      stream.next();
      const escape = state.quote === '"' ? /^(?:[nrt"\\]|u\{[0-9A-Fa-f]{1,6}\})/ : /^(?:[nrt'\\]|u\{[0-9A-Fa-f]{1,6}\})/;
      if (stream.match(escape)) return 'escape';
      stream.next();
      return 'invalid';
    }
    if (stream.next() === state.quote) {
      state.quote = null;
      return 'string';
    }
  }
  return 'string';
}

function word(stream, state, name) {
  const after = state.afterDot;
  const afterType = state.afterType;
  const expect = state.expect;
  state.afterDot = false;
  state.afterType = false;
  state.expect = null;
  if (expect === 'namespace') {
    // module a/b/c v1.0.0
    stream.match(/^(?:\/[a-z_][A-Za-z0-9_]*)*/);
    return 'namespace';
  }
  if (expect === 'type') {
    if (/^[A-Z]/.test(name)) state.afterType = true;
    return 'typeDef';
  }
  if (expect === 'function') return 'functionDef';
  if (expect === 'member') return 'property';
  if (expect === 'assertion') return 'assertion';
  if (after) {
    if (OPTIONAL_VARIANT.has(name)) return 'enumCase';
    // Shape.circle, DbError.closed(reason), Maybe<int>.none, as the grammar's enumCases; Role.fake() is not one.
    if (afterType && name !== 'fake' && /^[a-z_]/.test(name)) return 'enumCase';
    return stream.match(/^\s*\(/, false) ? 'function' : 'property';
  }
  if (name === 'try' && stream.match(/^[?!]/)) return 'control';
  if (name === 'test' && stream.match(ASSERTIONS, false)) {
    state.expect = 'assertion-dot';
    return 'self';
  }
  if (name === 'hidden') {
    return stream.match(/^\s+(?:object|role|enum|const)\b|^\s+(?:async\s+)?[a-z_][A-Za-z0-9_]*\s*\(/, false) ? 'modifier' : null;
  }
  if (name === 'once') return stream.match(/^\s+let\b/, false) ? 'modifier' : null;
  if (name === 'async') return 'modifier';
  if (name === 'self') return 'self';
  if (name === 'true' || name === 'false') return 'bool';
  if (CONTROL.has(name)) return 'control';
  if (DECLARATION.has(name)) {
    if (name === 'module' && stream.match(/^\s+[a-z_]/, false)) state.expect = 'namespace';
    else if ((name === 'object' || name === 'role' || name === 'enum') && stream.match(/^\s+[A-Za-z_]/, false)) state.expect = 'type';
    else if (name === 'native' && stream.match(/^\s+[a-z_][A-Za-z0-9_]*\s*\(/, false)) state.expect = 'function';
    return 'keyword';
  }
  if (PRIMITIVE.has(name)) return 'primitive';
  if (BUILTIN_TYPE.has(name)) {
    state.afterType = true;
    return 'type';
  }
  if (/^[A-Z]/.test(name)) {
    state.afterType = true;
    return 'type';
  }
  if (RESERVED.has(name)) return 'invalid';
  if (stream.match(/^\s*\(/, false)) return name === 'main' ? 'functionDef' : 'function';
  return null;
}

function token(stream, state) {
  if (state.inRaw) {
    if (stream.skipTo('```')) {
      stream.pos += 3;
      state.inRaw = false;
    } else stream.skipToEnd();
    return 'string';
  }
  if (state.inBlock) {
    if (stream.skipTo('*/')) {
      stream.pos += 2;
      state.inBlock = false;
    } else stream.skipToEnd();
    return 'comment';
  }
  if (state.quote) return readString(stream, state);
  if (stream.eatSpace()) return null;

  if (stream.match('```')) {
    state.inRaw = true;
    return token(stream, state) || 'string';
  }
  if (stream.match('//')) {
    stream.skipToEnd();
    return 'comment';
  }
  if (stream.match('/*')) {
    state.inBlock = true;
    if (stream.skipTo('*/')) {
      stream.pos += 2;
      state.inBlock = false;
    } else stream.skipToEnd();
    return 'comment';
  }
  const ch = stream.peek();
  if (ch === '"' || ch === "'") {
    stream.next();
    state.quote = ch;
    state.afterDot = state.afterType = false;
    return readString(stream, state);
  }
  if (/[0-9]/.test(ch)) {
    state.afterDot = state.afterType = false;
    if (stream.match(/^0[bB][01]+(?:_[01]+)*\b/) || stream.match(/^0[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)*\b/)) return 'number';
    stream.match(/^[0-9]+(?:_[0-9]+)*(?:\.[0-9]+(?:_[0-9]+)*(?:[eE][+-]?[0-9]+(?:_[0-9]+)*)?|[eE][+-]?[0-9]+(?:_[0-9]+)*)?/);
    return 'number';
  }
  if (stream.match(/^v[0-9]+\.[0-9]+\.[0-9]+\b/)) {
    state.afterDot = state.afterType = false;
    state.expect = null;
    return 'version';
  }
  const ident = stream.match(IDENT);
  if (ident) return word(stream, state, ident[0]);

  // Punctuation and operators.
  const wasType = state.afterType;
  state.afterType = false;
  state.afterDot = false;
  if (state.expect === 'assertion-dot' && stream.match(/^\s*\.\s*/)) {
    state.expect = 'assertion';
    return 'punct';
  }
  state.expect = null;
  if (stream.match('::')) {
    state.expect = 'member';
    return 'punct';
  }
  if (stream.match('...') || stream.match('..=') || stream.match('..')) return 'operator';
  if (stream.eat('.')) {
    state.afterDot = true;
    state.afterType = wasType;
    return 'punct';
  }
  if (ch === '^') {
    stream.next();
    // ^field = value (a successor's update) and ^Type (a successor type); otherwise bitwise xor.
    return stream.match(/^\s*[A-Za-z_]/, false) ? 'successor' : 'operator';
  }
  if ((ch === '@' || ch === '%') && stream.match(/^[@%](?=[A-Za-z_@%])/)) return 'collection';
  if (stream.match('??') || stream.match('?.') || stream.match('**') || stream.match('?')) return 'invalid';
  if (/[$`#]/.test(ch)) {
    stream.next();
    return 'invalid';
  }
  if (ch === '>') {
    stream.next();
    // Maybe<int>.none: the case of an applied generic enum.
    if (stream.match(/^>>?/) || stream.eat('=')) return 'operator';
    state.afterType = stream.peek() === '.';
    return 'operator';
  }
  if (stream.match(/^(?:->|&&|\|\||==|!=|<=|<<|<-|[<!&|~+\-*/%=])/)) return 'operator';
  stream.next();
  if (ch === '{' || ch === '(' || ch === '[') state.depth++;
  else if ((ch === '}' || ch === ')' || ch === ']') && state.depth > 0) state.depth--;
  return 'punct';
}

function indent(state, textAfter, context) {
  if (state.inBlock || state.inRaw || state.quote) return null;
  const closing = /^\s*[}\])]/.test(textAfter) ? 1 : 0;
  return Math.max(0, state.depth - closing) * context.unit;
}

/** The stream language definition (CodeMirror's StreamLanguage.define takes it with a tokenTable). */
export const okkamaStream = {
  name: 'okkama',
  startState,
  copyState,
  token,
  indent,
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', '"', "'"] },
    indentOnInput: /^\s*[}\])]$/,
  },
};

/** Fill `element` with `text`, coloured as the editor colours Okkama. */
export function highlightInto(element, text) {
  element.textContent = '';
  const state = startState();
  const fragment = document.createDocumentFragment();
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const stream = new StringStream(line, 4, 4);
    while (!stream.eol()) {
      const kind = token(stream, state);
      const piece = line.slice(stream.start, stream.pos);
      if (stream.pos === stream.start) {
        stream.next();
        fragment.append(line.slice(stream.start, stream.pos));
      } else if (kind) {
        const span = document.createElement('span');
        span.className = `ok-${kind}`;
        span.textContent = piece;
        fragment.append(span);
      } else fragment.append(piece);
      stream.start = stream.pos;
    }
    if (index < lines.length - 1) fragment.append('\n');
  });
  element.append(fragment);
}
