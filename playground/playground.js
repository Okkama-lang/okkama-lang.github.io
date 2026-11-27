// The Okkama playground (ticket #1078, stage 1: nothing runs). The editor is CodeMirror 6 (vendor/), the
// compiler is okkama-wasm (pkg/) in a worker (engine.js), and every answer is the CLI's own text: Problems is
// `okkama check`, Format is `okkama fmt`, Tokens, AST and IR are `okkama tokens|ast|ir`, Assembly is the
// disassembly of what `okkama build` makes. Hover, completion, go to definition and signature help come from the
// compiler's IDE layer, as in `okkama lsp`.

import {
  EditorState, StateField, StateEffect, EditorView, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection,
  crosshairCursor, hoverTooltip, showTooltip, StreamLanguage, HighlightStyle, syntaxHighlighting, bracketMatching,
  indentOnInput, indentUnit, history, defaultKeymap, historyKeymap, indentWithTab, autocompletion, closeBrackets,
  closeBracketsKeymap, completionKeymap, snippet, setDiagnostics, lintGutter, lintKeymap, searchKeymap,
  highlightSelectionMatches, tags,
} from './vendor/codemirror.min.js';
import { okkamaStream, highlightInto, TOKENS } from './okkama-lang.js';
import { Engine, Runtime } from './engine.js';

const SAMPLE = `module playground v1.0.0;

import "io/stdout" take Stdout;

// A bottle never changes: opening one gives a new, opened bottle.
// Hover a name, press Ctrl-Space for completion, F12 for its definition.
// Break something to see what okkama check says.
object Bottle {
    has opened is bool = false;

    Bottle() {}

    open() is ^Bottle {
        confirm !opened;
        ^opened = true;
    }

    state() is string {
        if opened {
            "open";
        }
        else {
            "closed";
        }
    }
}

main() is int {
    let out = Stdout();
    let bottle = Bottle();
    let poured = bottle.open();
    out.writeln("the first bottle is " + bottle.state());
    out.writeln("its successor is " + poured.state());
    0;
}
`;

const SHARE_LIMIT = 24 * 1024; // bytes of source in a #code= link
const DRAFT_KEY = 'okkama-playground-draft';
const THEME_KEY = 'okkama-theme';
const CHECK_DELAY = 250;
const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- small helpers

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode: nothing kept */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* nothing to remove */ } },
};

let toastTimer;
function notify(message) {
  const toast = $('toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

async function copyText(text, done = 'Copied.') {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const active = document.activeElement;
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(field);
      field.select();
      const copied = document.execCommand('copy');
      field.remove();
      if (active instanceof HTMLElement) active.focus();
      if (!copied) throw new Error('clipboard unavailable');
    }
    notify(done);
  } catch {
    notify('Could not copy. Select the text and copy it by hand.');
  }
}

function base64url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, ch => ch.charCodeAt(0)));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The little Markdown the compiler's hover and documentation use: fenced code, paragraphs, lists, `code`,
 * **bold**, *emphasis*, links. Everything becomes text nodes: nothing from a response is parsed as HTML. */
function renderMarkdown(markdown) {
  const root = element('div', 'pg-md');
  const lines = (markdown || '').split('\n');
  let paragraph = [];
  let list = null;
  const flush = () => {
    if (paragraph.length) {
      const p = element('p');
      inline(p, paragraph.join(' '));
      root.append(p);
      paragraph = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```\s*([A-Za-z]*)/);
    if (fence) {
      flush();
      list = null;
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      const pre = element('pre', 'pg-md-code');
      const code = element('code');
      if (!fence[1] || fence[1] === 'okkama') highlightInto(code, body.join('\n'));
      else code.textContent = body.join('\n');
      pre.append(code);
      root.append(pre);
      continue;
    }
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (item) {
      flush();
      if (!list) {
        list = element('ul');
        root.append(list);
      }
      const li = element('li');
      inline(li, item[1]);
      list.append(li);
      continue;
    }
    if (!line.trim()) {
      flush();
      list = null;
      continue;
    }
    if (list && /^\s{2,}/.test(line)) {
      list.lastChild.append(' ');
      inline(list.lastChild, line.trim());
      continue;
    }
    list = null;
    paragraph.push(line.trim());
  }
  flush();
  return root;
}

function inline(parent, text) {
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(text.slice(at, match.index));
    if (match[1] !== undefined) parent.append(element('code', '', match[1]));
    else if (match[2] !== undefined) parent.append(element('strong', '', match[2]));
    else if (match[3] !== undefined) parent.append(element('em', '', match[3]));
    else if (/^https?:\/\//.test(match[5])) {
      const a = element('a', '', match[4]);
      a.href = match[5];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      parent.append(a);
    } else parent.append(match[4]);
    at = match.index + match[0].length;
  }
  parent.append(text.slice(at));
}

// ---------------------------------------------------------------- theme and menu

const THEMES = ['system', 'light', 'dark'];
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  $('theme-label').textContent = theme[0].toUpperCase() + theme.slice(1);
  $('theme-toggle').setAttribute('aria-label', `Theme: ${theme}. Change the theme`);
}
let theme = storage.get(THEME_KEY) || 'system';
if (!THEMES.includes(theme)) theme = 'system';
applyTheme(theme);
$('theme-toggle').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  if (theme === 'system') storage.remove(THEME_KEY);
  else storage.set(THEME_KEY, theme);
  applyTheme(theme);
});

{
  const menu = document.querySelector('.menu-toggle');
  const navigation = $('navigation');
  const closeMenu = () => {
    menu.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-label', 'Open menu');
    navigation.classList.remove('open');
  };
  menu.addEventListener('click', () => {
    const open = menu.getAttribute('aria-expanded') !== 'true';
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    navigation.classList.toggle('open', open);
  });
  navigation.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
      closeMenu();
      menu.focus();
    }
  });
  document.addEventListener('click', event => {
    if (!navigation.contains(event.target) && !menu.contains(event.target)) closeMenu();
  });
  window.matchMedia('(min-width: 641px)').addEventListener('change', event => { if (event.matches) closeMenu(); });
}

// ---------------------------------------------------------------- the compiler

const engine = new Engine();
let compilerReady = false;
let examples = null;
let lastError = null;

function setStatus(kind, text) {
  $('status').dataset.state = kind;
  $('status-text').textContent = text;
  $('status').title = text;
}

engine.addEventListener('progress', ({ detail }) => {
  const mb = n => (n / 1048576).toFixed(1);
  const percent = detail.total ? Math.min(100, Math.round(detail.loaded / detail.total * 100)) : null;
  $('progress-bar').style.width = `${percent ?? 50}%`;
  setStatus('loading', percent === null
    ? `Loading the compiler… ${mb(detail.loaded)} MB`
    : `Loading the compiler… ${percent}% of ${mb(detail.total)} MB`);
});
engine.addEventListener('compiling', () => setStatus('loading', 'Starting the compiler…'));
engine.addEventListener('restart', ({ detail }) => {
  lastError = detail.reason;
  const short = /took longer/.test(detail.reason) ? detail.reason : 'an internal compiler error (a wasm trap)';
  notify(`The compiler stopped: ${short}. It was restarted.`);
  setStatus('warning', /took longer/.test(detail.reason) ? 'Restarted: the compiler took too long' : 'Restarted after a compiler trap');
});
engine.addEventListener('fatal', ({ detail }) => {
  compilerReady = false;
  setStatus('error', `The compiler could not restart: ${detail.message}. Reload the page.`);
});

// ---------------------------------------------------------------- the editor

const tokenTable = {
  comment: tags.comment, string: tags.string, escape: tags.escape, invalid: tags.invalid, number: tags.number,
  version: tags.literal, keyword: tags.definitionKeyword, control: tags.controlKeyword, modifier: tags.modifier,
  bool: tags.bool, self: tags.self, type: tags.typeName, typeDef: tags.definition(tags.typeName),
  primitive: tags.standard(tags.typeName), namespace: tags.namespace, enumCase: tags.atom,
  function: tags.function(tags.variableName), functionDef: tags.definition(tags.function(tags.variableName)),
  successor: tags.special(tags.operator), operator: tags.operator, punct: tags.punctuation,
  property: tags.propertyName, assertion: tags.function(tags.propertyName), collection: tags.typeOperator,
};
const okkamaLanguage = StreamLanguage.define({ ...okkamaStream, tokenTable });
const okkamaHighlight = HighlightStyle.define(TOKENS.map(name => ({ tag: tokenTable[name], class: `ok-${name}` })));

const state = {
  path: 'main.ok',
  example: null,
  view: 'problems',
  version: 0, // bumps on every edit; an answer for an older text is dropped
  results: {},
};

function position(doc, pos) {
  const line = doc.lineAt(pos);
  return { line: line.number - 1, character: pos - line.from };
}

function offset(doc, { line, character }) {
  if (line + 1 > doc.lines) return doc.length;
  const found = doc.line(line + 1);
  return Math.min(found.from + character, found.to);
}

function request(extra = {}) {
  return { source: editor.state.doc.toString(), path: state.path, ...extra };
}

// Signature help: a tooltip above the cursor while it is inside a call's arguments.
const setSignature = StateEffect.define();
const signatureField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setSignature)) return effect.value;
    if (value && tr.docChanged) return { ...value, pos: tr.changes.mapPos(value.pos) };
    return value;
  },
  provide: field => showTooltip.from(field, value => value && {
    pos: value.pos,
    above: true,
    strictSide: false,
    arrow: true,
    create: () => {
      const dom = element('div', 'pg-signature');
      const label = value.signature.label;
      const active = value.signature.parameters[value.signature.active];
      const at = active ? label.indexOf(active, label.indexOf('(')) : -1;
      const code = element('code');
      if (at >= 0) {
        const before = element('span');
        highlightInto(before, label.slice(0, at));
        const strong = element('strong');
        highlightInto(strong, active);
        const rest = element('span');
        highlightInto(rest, label.slice(at + active.length));
        code.append(before, strong, rest);
      } else highlightInto(code, label);
      dom.append(code);
      return { dom };
    },
  }),
});

let signatureTimer;
function requestSignature(view) {
  clearTimeout(signatureTimer);
  signatureTimer = setTimeout(async () => {
    if (!compilerReady) return;
    const version = state.version;
    let answer;
    try {
      answer = await engine.call('signature', request(position(view.state.doc, view.state.selection.main.head)));
    } catch { return; /* a trap is reported by the engine */ }
    if (version !== state.version) return;
    const signature = answer && answer.signature;
    view.dispatch({ effects: setSignature.of(signature ? { pos: view.state.selection.main.head, signature } : null) });
  }, 80);
}

const signatureUpdates = EditorView.updateListener.of(update => {
  const open = update.state.field(signatureField);
  let typed = null;
  if (update.docChanged) {
    update.transactions.forEach(tr => tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      const text = inserted.toString();
      if (text) typed = text[text.length - 1];
    }));
  }
  if (typed === '(' || typed === ',') requestSignature(update.view);
  else if (open && (update.docChanged || update.selectionSet)) requestSignature(update.view);
});

// Hover: the compiler's Markdown at the pointer.
const hover = hoverTooltip(async (view, pos) => {
  if (!compilerReady || !view.state.wordAt(pos)) return null;
  const version = state.version;
  let answer;
  try {
    answer = await engine.call('hover', request(position(view.state.doc, pos)));
  } catch { return null; }
  if (version !== state.version || !answer || !answer.hover) return null;
  const range = answer.hover.range;
  const doc = view.state.doc;
  return {
    pos: range ? offset(doc, range.start) : pos,
    end: range ? offset(doc, range.end) : pos,
    above: true,
    create: () => {
      const dom = element('div', 'pg-hover');
      dom.append(renderMarkdown(answer.hover.markdown));
      return { dom };
    },
  };
}, { hoverTime: 350 });

// Completion: the compiler's items, filtered by CodeMirror while the word grows.
const KINDS = { method: 'method', field: 'property', variable: 'variable', object: 'class', role: 'interface',
  enum: 'enum', enumMember: 'constant', function: 'function', keyword: 'keyword', module: 'namespace', folder: 'namespace',
  argument: 'variable' };

async function completeOkkama(context) {
  if (!compilerReady) return null;
  const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/);
  const from = word ? word.from : context.pos;
  const before = context.state.sliceDoc(Math.max(0, from - 1), from);
  let trigger;
  if (before === '.') trigger = '.';
  else if (!word) {
    const call = context.state.sliceDoc(Math.max(0, context.pos - 40), context.pos).match(/([(,])\s*$/);
    if (call) trigger = call[1];
  }
  if (!word && !trigger && !context.explicit) return null;
  let answer;
  try {
    answer = await engine.call('complete', request({ ...position(context.state.doc, from), trigger }));
  } catch { return null; }
  if (context.aborted || !answer || !answer.items || !answer.items.length) return null;
  const options = answer.items.map((item, index) => ({
    label: item.label,
    detail: item.detail || undefined,
    type: KINDS[item.kind] || 'text',
    boost: -Math.min(index, 99) / 100,
    info: item.documentation ? () => renderMarkdown(item.documentation) : undefined,
    apply: item.snippet && item.insert
      ? snippet(item.insert.replace(/\$(\d+)/g, '${$1}'))
      : (item.insert && item.insert !== item.label ? item.insert : undefined),
  }));
  return { from, options, validFor: /^[A-Za-z0-9_]*$/ };
}

// Go to definition: F12, Mod-B or Ctrl/Cmd-click. Within the buffer it moves there; std opens the reference.
async function goToDefinition(view, pos = view.state.selection.main.head) {
  if (!compilerReady) return;
  let answer;
  try {
    answer = await engine.call('definition', request(position(view.state.doc, pos)));
  } catch { return; }
  const found = answer && answer.definition;
  if (!found) {
    notify('No definition here.');
    return;
  }
  if (found.path === state.path) {
    const from = offset(view.state.doc, found.range.start);
    const to = offset(view.state.doc, found.range.end);
    view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }), userEvent: 'select' });
    view.focus();
    return;
  }
  const line = found.range.start.line + 1;
  const std = found.path.match(/^std\/(.+)\.ok$/);
  const note = $('summary');
  note.textContent = `Defined in ${found.path}, line ${line}.`;
  delete note.dataset.kind;
  if (std) {
    const a = element('a', 'pg-link', `${std[1]} in the reference ↗`);
    a.href = `/man/modules/${std[1]}.html`;
    a.target = '_blank';
    a.rel = 'noopener';
    note.append(' ', a);
  }
  notify(`Defined in ${found.path}, line ${line}.`);
}

const definitionClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    event.preventDefault();
    goToDefinition(view, pos);
    return true;
  },
});

const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--pg-editor-bg)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.7', fontSize: 'var(--pg-code-size)' },
  '.cm-content': { caretColor: 'var(--yellow)', padding: '12px 0 30vh' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--pg-caret)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--pg-editor-bg)', color: 'var(--subtle)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--pg-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--pg-active-line)', color: 'var(--text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--pg-selection)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--pg-match)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--pg-match)', outline: '1px solid var(--subtle)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: '8px', boxShadow: '0 12px 40px var(--pg-shadow)' },
  '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: 'var(--line)', borderBottomColor: 'var(--line)' },
  '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: 'var(--panel)', borderBottomColor: 'var(--panel)' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: '12px', maxHeight: '18em' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--yellow)', color: '#040816' },
  '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal', marginLeft: '1em' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail': { color: '#040816' },
  '.cm-completionInfo': { maxWidth: '420px', padding: '8px 12px' },
  '.cm-panels': { backgroundColor: 'var(--panel-light)', color: 'var(--text)' },
  '.cm-panels input, .cm-panels button': { color: 'var(--text)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--pg-error)', textUnderlineOffset: '3px', textDecorationSkipInk: 'none' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--pg-warning)', textUnderlineOffset: '3px', textDecorationSkipInk: 'none' },
  '.cm-diagnostic': { fontFamily: 'var(--mono)', fontSize: '12px', whiteSpace: 'pre-wrap', padding: '6px 10px' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--pg-error)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--pg-warning)' },
});

const updates = EditorView.updateListener.of(update => {
  if (update.docChanged) {
    state.version++;
    state.results = {};
    scheduleRun();
    saveDraft();
  }
  if (update.selectionSet || update.docChanged) showCursor(update.state);
});

function showCursor(editorState) {
  const pos = position(editorState.doc, editorState.selection.main.head);
  $('cursor').textContent = `Ln ${pos.line + 1}, Col ${pos.character + 1}`;
}

const definitionKey = view => {
  goToDefinition(view);
  return true;
};

const extensions = [
  lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
  EditorState.allowMultipleSelections.of(true), indentOnInput(), indentUnit.of('    '), EditorState.tabSize.of(4),
  okkamaLanguage, syntaxHighlighting(okkamaHighlight), bracketMatching(), closeBrackets(),
  autocompletion({ override: [completeOkkama], icons: true }),
  rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(), lintGutter(),
  hover, signatureField, signatureUpdates, definitionClick,
  keymap.of([
    { key: 'Mod-Enter', run: () => { startRun(); return true; } },
    { key: 'F12', run: definitionKey },
    { key: 'Mod-b', run: definitionKey },
    { key: 'Mod-Shift-Space', run: view => { requestSignature(view); return true; } },
    {
      key: 'Escape',
      run: view => {
        if (!view.state.field(signatureField)) return false;
        view.dispatch({ effects: setSignature.of(null) });
        return true;
      },
    },
    { key: 'Shift-Alt-f', run: () => { formatBuffer(); return true; } },
    ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap,
    ...lintKeymap, indentWithTab,
  ]),
  editorTheme, updates,
  EditorView.contentAttributes.of({ 'aria-label': 'Okkama source', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
];
const editor = new EditorView({ parent: $('editor'), state: EditorState.create({ doc: '', extensions }) });

/** A new text in the editor, with a fresh undo history (an example, a link, Reset). */
function replaceBuffer(text) {
  editor.setState(EditorState.create({ doc: text, extensions }));
  state.version++;
  state.results = {};
  showCursor(editor.state);
  scheduleRun(0);
}

// ---------------------------------------------------------------- running the commands

const tests = () => $('tests').checked;
const VIEWS = {
  problems: { fn: 'check', request: () => request({ tests: tests() }) },
  format: { fn: 'fmt', request: () => request() },
  tokens: { fn: 'tokens', request: () => request({ format: $('tokens-format').value }) },
  ast: {
    fn: 'ast',
    request: () => request({ format: $('ast-format').value, mode: $('ast-mode').value, spans: $('ast-spans').checked, pruneTests: $('ast-prune').checked }),
  },
  ir: {
    fn: 'ir',
    request: () => {
      const choice = $('ir-passes').value;
      return choice.startsWith('after:')
        ? request({ tests: tests(), after: choice.slice(6) })
        : request({ tests: tests(), passes: choice });
    },
  },
  spa: { fn: 'spa', request: () => request({ tests: tests() }) },
  output: null,
  expected: null,
};

let runTimer;
function scheduleRun(delay = CHECK_DELAY) {
  clearTimeout(runTimer);
  runTimer = setTimeout(runNow, delay);
}

async function runNow() {
  if (!compilerReady) return;
  await run('problems');
  if (state.view !== 'problems' && VIEWS[state.view]) await run(state.view);
  else if (state.view === 'expected' || state.view === 'output') render();
}

async function run(view) {
  if (!compilerReady) return;
  const version = state.version;
  const spec = VIEWS[view];
  let answer;
  try {
    answer = await engine.call(spec.fn, spec.request());
  } catch (error) {
    if (version === state.version) {
      state.results[view] = { trap: String(error.message || error) };
      if (view === 'problems') {
        editor.dispatch(setDiagnostics(editor.state, []));
        renderProblemsSummary(null);
      }
      if (view === state.view) render();
    }
    return;
  }
  if (version !== state.version) return; // the text changed meanwhile: a newer run follows
  state.results[view] = answer;
  if (view === 'problems') applyDiagnostics(answer);
  if (view === state.view) render();
}

function applyDiagnostics(answer) {
  const doc = editor.state.doc;
  const found = [];
  for (const diagnostic of answer.diagnostics || []) {
    if (diagnostic.file !== state.path || !diagnostic.range) continue;
    let from = offset(doc, diagnostic.range.start);
    let to = offset(doc, diagnostic.range.end);
    if (to <= from) {
      // An empty span (an unexpected end, a missing token) still gets a character to underline.
      to = Math.min(doc.length, from + 1);
      if (to === from && from > 0) from--;
    }
    found.push({
      from, to,
      severity: diagnostic.severity === 'warning' ? 'warning' : 'error',
      source: diagnostic.kind || 'okkama',
      message: diagnostic.message,
    });
  }
  editor.dispatch(setDiagnostics(editor.state, found));
  renderProblemsSummary(answer);
}

function counts(answer) {
  let errors = 0;
  let warnings = 0;
  for (const diagnostic of answer.diagnostics || []) {
    if (diagnostic.severity === 'warning') warnings++;
    else errors++;
  }
  if (!answer.ok && !errors && (answer.stderr || '').trim()) errors = 1;
  return { errors, warnings };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function renderProblemsSummary(answer) {
  const badge = $('problems-count');
  const summary = $('summary');
  if (!answer) {
    badge.hidden = true;
    summary.textContent = 'The compiler stopped; it was restarted.';
    summary.dataset.kind = 'error';
    return;
  }
  const { errors, warnings } = counts(answer);
  const total = errors + warnings;
  badge.hidden = total === 0;
  badge.textContent = String(total);
  badge.dataset.kind = errors ? 'error' : 'warning';
  badge.setAttribute('aria-label', [errors && plural(errors, 'error'), warnings && plural(warnings, 'warning')].filter(Boolean).join(', '));
  summary.textContent = total === 0 ? '✓ No problems' : badge.getAttribute('aria-label');
  summary.dataset.kind = errors ? 'error' : warnings ? 'warning' : 'ok';
}

// ---------------------------------------------------------------- the output panel

const panel = $('panel');

function render() {
  const view = state.view;
  panel.textContent = '';
  if (view === 'expected') return renderExpected();
  if (view === 'output') return renderOutput();
  const answer = state.results[view];
  if (!answer) {
    panel.append(element('p', 'pg-empty', compilerReady ? 'Working…' : 'Waiting for the compiler…'));
    return;
  }
  if (answer.trap) {
    const box = element('div', 'pg-trap');
    box.append(element('strong', '', 'The compiler stopped on this code and was restarted.'));
    box.append(element('p', '', 'This is a bug in the compiler, not in your program. Please report it with the code: Share copies a link to it.'));
    box.append(element('pre', 'pg-out pg-muted', answer.trap));
    const link = element('a', 'pg-link', 'Report it on GitHub ↗');
    link.href = 'https://github.com/Okkama-lang/okkama/issues/new';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    box.append(link);
    panel.append(box);
    return;
  }
  if (view === 'problems') return renderProblems(answer);
  if (!answer.ok) {
    // The command failed: what the CLI prints on stderr, and its exit status.
    panel.append(diagnosticsList(answer), element('p', 'pg-exit', `exit ${answer.code}`));
    return;
  }
  if (view === 'format') return renderFormat(answer);
  if (view === 'spa') $('spa-note').textContent = answer.spbBytes ? `${answer.spbBytes.toLocaleString('en')} bytes of SPB` : '';
  if (answer.stderr) panel.append(diagnosticsList(answer));
  panel.append(element('pre', 'pg-out', answer.stdout));
}

function diagnosticsList(answer) {
  const list = element('div', 'pg-diagnostics');
  const diagnostics = answer.diagnostics || [];
  if (!diagnostics.length && answer.stderr) {
    list.append(element('pre', 'pg-out pg-diagnostic pg-error', answer.stderr));
    return list;
  }
  for (const diagnostic of diagnostics) {
    const item = element('div', `pg-diagnostic pg-${diagnostic.severity}`);
    const [head, ...rest] = (diagnostic.text || diagnostic.message).replace(/\n$/, '').split('\n');
    const local = diagnostic.file === state.path && diagnostic.range;
    const header = element(local ? 'button' : 'div', 'pg-diagnostic-head');
    if (local) {
      header.type = 'button';
      header.title = 'Show in the editor';
      header.addEventListener('click', () => {
        const from = offset(editor.state.doc, diagnostic.range.start);
        const to = offset(editor.state.doc, diagnostic.range.end);
        editor.dispatch({ selection: { anchor: from, head: Math.max(from, to) }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
        editor.focus();
      });
    }
    const parts = head.match(/^(.*?:\s)((?:[a-z]+ )?(?:error|warning)(?: at "[^"]*")?)(:.*)$/);
    if (parts) header.append(element('span', 'pg-location', parts[1]), element('span', 'pg-severity', parts[2]), parts[3]);
    else header.textContent = head;
    item.append(header);
    if (rest.length) item.append(element('pre', 'pg-out pg-snippet', rest.join('\n')));
    list.append(item);
  }
  return list;
}

function renderProblems(answer) {
  $('command-problems').textContent = `okkama check${tests() ? ' -t' : ''} ${state.path}`;
  if (answer.ok && !(answer.diagnostics || []).length && !answer.stderr) {
    const ok = element('div', 'pg-ok');
    ok.append(element('strong', '', '✓ No problems.'), element('p', '', 'okkama check prints nothing and exits 0.'));
    panel.append(ok);
    return;
  }
  panel.append(diagnosticsList(answer), element('p', 'pg-exit', `exit ${answer.code}`));
}

function renderFormat(answer) {
  const same = answer.stdout === editor.state.doc.toString();
  $('format-note').textContent = same ? 'Already formatted.' : 'The formatter would change this file.';
  $('apply-format').disabled = same;
  const pre = element('pre', 'pg-out pg-code');
  const code = element('code');
  highlightInto(code, answer.stdout);
  pre.append(code);
  panel.append(pre);
}

function renderExpected() {
  const example = state.example;
  if (!example || example.expected === null) {
    panel.append(element('p', 'pg-empty', 'Open an example of the Bible to see what it prints.'));
    return;
  }
  $('expected-command').textContent = example.rejected
    ? `okkama run ${example.name}.ok, stderr`
    : `okkama run${example.tests ? ' -t' : ''} ${example.name}.ok`;
  let note;
  if (example.rejected) note = 'The diagnostic the Bible shows.';
  else if (example.runs) {
    note = 'What the program prints, from the Bible (and “exit N” for a status other than 0).';
    const ran = run$.last;
    if (ran && ran.source === example.source && ran.path === `${example.name}.ok`) {
      const trimmed = ran.stdout.replace(/\n+$/, '');
      const lines = trimmed ? trimmed.split('\n') : [];
      if (ran.exit !== 0) lines.push(`exit ${ran.exit}`);
      note += lines.join('\n') === example.expected.replace(/\n+$/, '')
        ? ' ✓ The playground’s run printed the same.'
        : ' The playground’s run printed something else: see Output.';
    } else note += ' Run it to compare.';
  } else if (example.tests) note = 'A test suite’s report, from the Bible. The playground does not run tests yet.';
  else note = 'What the program prints, from the Bible. It needs what the playground does not offer (files, processes or the environment), so it runs only with okkama.';
  const checked = state.results.problems;
  if (example.rejected && checked && !checked.trap) {
    const said = (checked.stderr || '').trimEnd();
    const shown = example.expected.trimEnd();
    if (said === shown) note += ' ✓ The playground’s check says the same.';
    else if (said.startsWith(shown)) note += ' ✓ The playground’s check says it too, and more: check reports every error, run stops at the first.';
    else if (checked.ok) note += ' It fails when it runs, which the playground cannot show yet.';
    else note += ' The playground’s check says something else: see Problems.';
  }
  $('expected-note').textContent = note;
  panel.append(element('pre', 'pg-out', example.expected || '(prints nothing)'));
}

// Tabs: arrow keys move between them, as on the home page.
const tabs = [...document.querySelectorAll('.pg-tab')];
function selectView(view, focus = false) {
  state.view = view;
  for (const tab of tabs) {
    const selected = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected) {
      panel.setAttribute('aria-labelledby', tab.id);
      if (focus) tab.focus();
    }
  }
  for (const set of document.querySelectorAll('.pg-option-set')) set.hidden = set.dataset.for !== view;
  panel.scrollTop = 0;
  render();
  if (VIEWS[view] && !state.results[view]) run(view);
}
tabs.forEach(tab => {
  tab.addEventListener('click', () => selectView(tab.dataset.view));
  tab.addEventListener('keydown', event => {
    const shown = tabs.filter(item => !item.hidden);
    const index = shown.indexOf(tab);
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % shown.length;
    else if (event.key === 'ArrowLeft') next = (index + shown.length - 1) % shown.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = shown.length - 1;
    else return;
    event.preventDefault();
    selectView(shown[next].dataset.view, true);
  });
});

for (const [id, view] of [['tokens-format', 'tokens'], ['ast-format', 'ast'], ['ast-mode', 'ast'], ['ast-spans', 'ast'], ['ast-prune', 'ast'], ['ir-passes', 'ir']]) {
  $(id).addEventListener('change', () => {
    delete state.results[view];
    render();
    run(view);
  });
}
$('tests').addEventListener('change', () => {
  state.results = {};
  render();
  scheduleRun(0);
});

$('copy-output').addEventListener('click', () => {
  if (state.view === 'expected') return copyText(state.example ? state.example.expected || '' : '');
  if (state.view === 'output') return run$.console ? copyText(run$.box.innerText) : notify('Nothing to copy yet.');
  const answer = state.results[state.view];
  if (!answer || answer.trap) return notify('Nothing to copy yet.');
  return copyText(answer.ok && state.view !== 'problems' ? answer.stdout : answer.stderr || answer.stdout || '');
});

async function formatBuffer() {
  if (!compilerReady) return;
  const version = state.version;
  let answer;
  try {
    answer = await engine.call('fmt', request());
  } catch { return; }
  if (version !== state.version) return;
  if (!answer.ok) {
    notify('The file does not parse, so it cannot be formatted. See Problems.');
    selectView('problems');
    return;
  }
  if (answer.stdout === editor.state.doc.toString()) {
    notify('Already formatted.');
    return;
  }
  const head = Math.min(editor.state.selection.main.head, answer.stdout.length);
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: answer.stdout }, selection: { anchor: head }, userEvent: 'input.format' });
  notify('Formatted.');
}
$('format-button').addEventListener('click', formatBuffer);
$('apply-format').addEventListener('click', () => {
  const answer = state.results.format;
  if (!answer || !answer.ok) return;
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: answer.stdout }, userEvent: 'input.format' });
  editor.focus();
});

// ---------------------------------------------------------------- running programs

// `okkama run` in the page: okkama-wasm builds the SPB (the CLI's diagnostics and warnings), sparrow-wasm runs it in
// a worker of its own under the playground's profile (steps, memory and output budgets; files, sockets, processes and
// the environment refused) with the stdin field as standard input, and the page shows the output by its moments on
// the program's clock: a sleep is not waited for while the program runs, the page replays it. A failure is drawn
// with its place and stack in the sources, as `okkama run` prints it (okkama-wasm's failureText).
const runtime = new Runtime();
let runtimeReady = false;
const STDIN_KEY = 'okkama-playground-stdin';
const run$ = {
  phase: 'idle', // idle | loading | building | running | replaying
  handle: null,
  timer: null,
  box: null, // the Output panel's content for the last run
  console: null,
  last: null, // {source, path, stdout, exit} of the last finished run, for Expected
  skip: null,
};

runtime.addEventListener('progress', ({ detail }) => {
  if (run$.phase !== 'loading') return;
  const percent = detail.total ? Math.min(100, Math.round(detail.loaded / detail.total * 100)) : null;
  $('output-note').textContent = percent === null ? 'Loading Sparrow…' : `Loading Sparrow… ${percent}%`;
});

function loadRuntime() {
  return runtime.load().then(() => {
    runtimeReady = true;
    if (compilerReady) setStatus('ready', `Ready · okkama ${engine.version.version} · Sparrow`);
    return runtime;
  });
}

function setRunPhase(phase) {
  run$.phase = phase;
  const button = $('run-button');
  const label = { idle: 'Run', loading: 'Stop', building: 'Stop', running: 'Stop', replaying: 'Skip' }[phase];
  $('run-label').textContent = label;
  button.querySelector('.pg-run-icon').textContent = phase === 'idle' ? '▶' : phase === 'replaying' ? '⏭' : '■';
  button.classList.toggle('pg-running', phase !== 'idle');
  button.title = phase === 'idle' ? 'Run the program (Ctrl+Enter)'
    : phase === 'replaying' ? 'Show the rest of the output now' : 'Stop the program';
  button.setAttribute('aria-label', phase === 'idle' ? 'Run the program' : phase === 'replaying' ? 'Skip the waits' : 'Stop the program');
}

/** Strip terminal escape sequences (CSI) from program output: the page is not a terminal. */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

function appendOutput(stream, text) {
  const pre = run$.console;
  const clean = text.replace(ESCAPES, '');
  if (!clean) return;
  const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8 && panel.scrollHeight - panel.scrollTop - panel.clientHeight < 24;
  const last = pre.lastChild;
  if (last && last.dataset.stream === stream) last.textContent += clean;
  else {
    const span = element('span', stream === 'stderr' ? 'pg-stderr' : 'pg-stdout', clean);
    span.dataset.stream = stream;
    pre.append(span);
  }
  if (stick && run$.box.isConnected) panel.scrollTop = panel.scrollHeight;
}

function runNote(text) {
  $('output-note').textContent = text;
}

function newRunBox() {
  const box = element('div', 'pg-run-out');
  run$.console = element('pre', 'pg-out pg-console');
  run$.console.setAttribute('aria-label', 'Program output');
  box.append(run$.console);
  run$.box = box;
  if (state.view === 'output') render();
  return box;
}

function finishRun(lines) {
  for (const line of lines) run$.box.append(line);
  setRunPhase('idle');
  if (state.view === 'output' || state.view === 'expected') render();
}

const seconds = ms => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${Math.round(ms)} ms`);

async function startRun() {
  if (run$.phase === 'replaying') return run$.skip && run$.skip();
  if (run$.phase !== 'idle') return stopRun();
  if (!compilerReady) return undefined;
  const source = editor.state.doc.toString();
  const path = state.path;
  const stdin = $('stdin').value;
  $('command-output').textContent = `okkama run ${path}`;
  selectView('output');
  newRunBox();
  if (!runtimeReady) {
    setRunPhase('loading');
    runNote('Loading Sparrow…');
    try {
      await loadRuntime();
    } catch (error) {
      setRunPhase('idle');
      runNote('');
      finishRun([element('p', 'pg-trap-line', `Sparrow did not load: ${error.message || error}. Check the connection and try again.`)]);
      return undefined;
    }
    if (run$.phase !== 'loading') return undefined; // stopped while loading
  }
  setRunPhase('building');
  runNote('Building…');
  let built;
  try {
    built = await engine.call('build', { source, path });
  } catch (error) {
    runNote('');
    finishRun([trapBox('The compiler stopped while building this program and was restarted.', error.message || String(error))]);
    return undefined;
  }
  if (run$.phase !== 'building') return undefined;
  if (!built.ok) {
    // As `okkama run`: the diagnostics on stderr and status 1.
    runNote('The program does not build.');
    finishRun([diagnosticsList(built), element('p', 'pg-exit', `exit ${built.code}`)]);
    return undefined;
  }
  if (built.stderr) appendOutput('stderr', built.stderr);
  setRunPhase('running');
  runNote('Running…');
  const started = performance.now();
  run$.handle = runtime.run(built.spb, {
    stdin,
    onRequirements: needs => {
      if (needs.refused && needs.refused.length) run$.box.prepend(refusedBox(needs.refused));
      if (needs.files && needs.files.length) runNote('Running… (loading the CLDR tables it reads)');
    },
  });
  const outcome = await run$.handle.done;
  run$.handle = null;
  if (outcome.interrupted === 'stop') {
    runNote(`Stopped after ${seconds(performance.now() - started)}.`);
    finishRun([element('p', 'pg-exit', 'stopped')]);
    return undefined;
  }
  if (outcome.interrupted === 'watchdog') {
    // The runtime's own words for an interrupted run (`okkama run --timeout`).
    appendOutput('stderr', 'Execution interrupted\n');
    runNote(`The playground stopped it after ${seconds(runtime.watchdogMs)} of computing.`);
    finishRun([]);
    return undefined;
  }
  if (outcome.trap) {
    runNote('');
    finishRun([trapBox('Sparrow stopped on this program (a runtime trap). This is a bug in the runtime, not in your program; please report it with the code.', outcome.trap)]);
    return undefined;
  }
  if (outcome.error) {
    runNote('');
    finishRun([element('p', 'pg-trap-line', outcome.error)]);
    return undefined;
  }
  const result = outcome.result;
  let failure = '';
  if (result.report) {
    failure = result.report;
    try {
      const drawn = await engine.call('failureText', { report: result.report, uncaught: result.uncaught });
      if (drawn.ok && typeof drawn.text === 'string') failure = drawn.text;
    } catch { /* the report without its place */ }
  }
  replayOutput(result, outcome.elapsed, () => {
    if (failure) appendOutput('stderr', failure);
    const stdout = result.output.filter(piece => piece.stream === 'stdout').map(piece => piece.text).join('');
    run$.last = { source, path, stdout, exit: result.exit };
    const clock = result.output.length ? result.output[result.output.length - 1].t / 1e6 : 0;
    const timing = clock > outcome.elapsed + 50 ? `${seconds(clock)} on the program's clock, ${seconds(outcome.elapsed)} to compute` : `${seconds(outcome.elapsed)}`;
    runNote(`Ran in ${timing}.${tests() ? ' Tests do not run in the playground yet: this was main.' : ''}`);
    finishRun([element('p', `pg-exit${result.exit ? ' pg-exit-failed' : ''}`, `exit ${result.exit}`)]);
  });
  return undefined;
}

/** Show `result.output` by its marks: what the program wrote at t appears t after the run began, not sooner. */
function replayOutput(result, elapsed, done) {
  const pieces = result.output;
  const base = performance.now() - elapsed;
  let at = 0;
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    clearTimeout(run$.timer);
    run$.skip = null;
    done();
  };
  const step = () => {
    const now = performance.now() - base;
    while (at < pieces.length && pieces[at].t / 1e6 <= now) {
      appendOutput(pieces[at].stream, pieces[at].text);
      at++;
    }
    if (at >= pieces.length) return end();
    run$.timer = setTimeout(step, Math.max(0, pieces[at].t / 1e6 - (performance.now() - base)));
    return undefined;
  };
  run$.skip = () => {
    while (at < pieces.length) {
      appendOutput(pieces[at].stream, pieces[at].text);
      at++;
    }
    end();
  };
  step();
  if (!over) {
    setRunPhase('replaying');
    runNote('Replaying the output on the program’s clock…');
  }
}

function stopRun() {
  if (run$.handle) run$.handle.stop();
  else if (run$.phase === 'loading' || run$.phase === 'building') {
    setRunPhase('idle');
    runNote('Stopped.');
  }
}

function refusedBox(refused) {
  const box = element('div', 'pg-refused');
  box.setAttribute('role', 'note');
  box.append(element('strong', '', 'This program uses what the playground does not offer.'));
  box.append(element('p', '', 'Files, sockets, processes, the environment and the terminal stay outside the browser. The program runs until it reaches one of these and stops there with “not available in the playground”; run it with okkama on your machine for the rest.'));
  const list = element('ul');
  for (const symbol of refused.slice(0, 8)) list.append(element('li', '', symbol));
  if (refused.length > 8) list.append(element('li', '', `and ${refused.length - 8} more`));
  box.append(list);
  return box;
}

function trapBox(title, detail) {
  const box = element('div', 'pg-trap');
  box.append(element('strong', '', title));
  box.append(element('pre', 'pg-out pg-muted', detail));
  const link = element('a', 'pg-link', 'Report it on GitHub ↗');
  link.href = 'https://github.com/Okkama-lang/okkama/issues/new';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  box.append(link);
  return box;
}

function renderOutput() {
  $('command-output').textContent = `okkama run ${state.path}`;
  if (run$.box) {
    panel.append(run$.box);
    return;
  }
  const empty = element('div', 'pg-empty');
  empty.append(element('p', '', 'Press Run (Ctrl+Enter) to build the program and run it on Sparrow, in your browser.'));
  empty.append(element('p', 'pg-muted-small', 'Files, sockets, processes and the environment are not available here; a program gets 5·10⁷ steps, 256 MiB and 1 MiB of output, and 15 s of computing.'));
  panel.append(empty);
}

$('run-button').addEventListener('click', () => startRun());
{
  const stdin = $('stdin');
  stdin.value = storage.get(STDIN_KEY) || '';
  const toggle = $('stdin-toggle');
  const mark = () => { toggle.textContent = stdin.value ? 'stdin •' : 'stdin'; };
  mark();
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    $('stdin-box').hidden = !open;
    if (open) stdin.focus();
  });
  stdin.addEventListener('input', () => {
    storage.set(STDIN_KEY, stdin.value);
    mark();
  });
  stdin.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      startRun();
    }
  });
}

// ---------------------------------------------------------------- examples, links, drafts

function setPath(path) {
  state.path = path;
  $('file-name').textContent = path;
  $('command-problems').textContent = `okkama check${tests() ? ' -t' : ''} ${path}`;
}

function setUrl({ example = null, hash = '' } = {}) {
  const url = new URL(location.href);
  url.search = '';
  if (example) url.searchParams.set('example', example);
  url.hash = hash;
  window.history.replaceState(null, '', url);
  return url;
}

function leaveExample() {
  state.example = null;
  $('example').value = '';
  $('tab-expected').hidden = true;
  $('example-hint').textContent = '';
  if (state.view === 'expected') selectView('problems');
}

function openExample(name, { updateUrl = true } = {}) {
  const example = examples && examples.examples.find(item => item.name === name);
  if (!example) {
    notify(`There is no example named ${name}.`);
    return false;
  }
  state.example = example;
  $('tests').checked = example.tests;
  setPath(`${example.name}.ok`);
  replaceBuffer(example.source);
  $('example').value = example.name;
  $('tab-expected').hidden = example.expected === null;
  const chapter = examples.chapters[example.chapter];
  const runs = example.runs ? ' It runs here: press Run.' : example.rejected ? ' The compiler rejects it on purpose.' : example.tests ? ' A test suite: the playground checks it, tests do not run here yet.' : ' It needs files, processes or the environment, so it does not run here.';
  $('example-hint').textContent = (chapter
    ? `From the Okkama Bible, chapter ${Number(example.chapter)}: ${chapter}.`
    : 'From the Okkama Bible.') + runs;
  if (updateUrl) setUrl({ example: example.name });
  if (state.view === 'expected' && example.expected === null) selectView('problems');
  else render();
  return true;
}

function fillExamples() {
  const select = $('example');
  const groups = new Map();
  for (const example of examples.examples) {
    const key = example.chapter || 'other';
    if (!groups.has(key)) {
      const group = document.createElement('optgroup');
      const title = examples.chapters[key];
      group.label = title ? `${Number(key)}. ${title}` : 'Other';
      groups.set(key, group);
      select.append(group);
    }
    const option = document.createElement('option');
    option.value = example.name;
    option.textContent = example.name.replace(/^\d\d-/, '') + (example.rejected ? ' (rejected)' : example.tests ? ' (tests)' : example.runs ? ' · runs' : '');
    groups.get(key).append(option);
  }
}

function openOwnCode() {
  leaveExample();
  setPath('main.ok');
  replaceBuffer(storage.get(DRAFT_KEY) || SAMPLE);
}

$('example').addEventListener('change', event => {
  if (event.target.value) openExample(event.target.value);
  else {
    openOwnCode();
    setUrl();
  }
});

let draftTimer;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    // An example is kept by its link; only the reader's own code is a draft.
    if (!state.example) storage.set(DRAFT_KEY, editor.state.doc.toString());
  }, 500);
}

$('share-button').addEventListener('click', () => {
  const source = editor.state.doc.toString();
  let url;
  if (state.example && source === state.example.source) url = setUrl({ example: state.example.name });
  else {
    const bytes = new TextEncoder().encode(source).length;
    if (bytes > SHARE_LIMIT) {
      notify(`Too long for a link: ${Math.ceil(bytes / 1024)} KB, the limit is ${SHARE_LIMIT / 1024} KB.`);
      return;
    }
    url = setUrl({ hash: `code=${base64url(source)}` });
  }
  copyText(url.toString(), 'Link copied.');
});

$('reset-button').addEventListener('click', () => {
  leaveExample();
  setPath('main.ok');
  storage.remove(DRAFT_KEY);
  $('tests').checked = false;
  replaceBuffer(SAMPLE);
  setUrl();
});

function sharedCode() {
  const match = location.hash.match(/^#code=([A-Za-z0-9_-]*)$/);
  if (!match) return null;
  try {
    return unbase64url(match[1]);
  } catch {
    notify('The code in this link could not be read.');
    return null;
  }
}

// ---------------------------------------------------------------- start

const wanted = new URL(location.href).searchParams.get('example');
const shared = sharedCode();
if (shared !== null) replaceBuffer(shared);
else if (!wanted) replaceBuffer(storage.get(DRAFT_KEY) || SAMPLE);
selectView('problems');

const examplesLoaded = fetch(new URL('./examples.json', import.meta.url))
  .then(response => (response.ok ? response.json() : Promise.reject(new Error(response.statusText))))
  .then(data => {
    examples = data;
    fillExamples();
    if (wanted && shared === null && !openExample(wanted, { updateUrl: false })) replaceBuffer(storage.get(DRAFT_KEY) || SAMPLE);
  })
  .catch(() => {
    $('example').disabled = true;
    if (wanted && shared === null) replaceBuffer(storage.get(DRAFT_KEY) || SAMPLE);
  });

function passNames(version) {
  // The compiler's IR passes in their order (version().passes, the list `okkama ir --passes` takes).
  const select = $('ir-passes');
  for (const pass of version.passes || []) {
    const option = document.createElement('option');
    option.value = `after:${pass}`;
    option.textContent = `after ${pass}`;
    select.append(option);
  }
}

engine.load().then(async version => {
  await examplesLoaded;
  if (examples) {
    const files = {};
    for (const [path, text] of Object.entries(examples.files)) if (path.endsWith('.ok')) files[path] = text;
    await engine.setFiles(files).catch(() => {});
  }
  passNames(version);
  compilerReady = true;
  $('progress-bar').style.width = '100%';
  setStatus('ready', `Ready · okkama ${version.version}`);
  $('run-button').disabled = false;
  // Sparrow comes next, in the background, so a run starts at once and the page works offline afterwards.
  loadRuntime().catch(() => { /* fetched again on Run */ });
  $('version-line').textContent = `okkama ${version.version} · ${version.stdModules} std modules`;
  state.results = {};
  render();
  runNow();
}).catch(error => {
  const message = String(error && error.message || error);
  const unsupported = typeof WebAssembly === 'undefined' ? ' This browser has no WebAssembly.' : '';
  setStatus('error', `The compiler did not load: ${message}.${unsupported}`);
  panel.textContent = '';
  panel.append(element('p', 'pg-empty', 'The compiler did not load. Check the connection and reload the page.'));
});

// For tests and the curious: the page's parts.
window.okkamaPlayground = {
  engine, runtime, editor, state, openExample, selectView, run, startRun,
  get running() { return run$.phase; },
  get ready() { return compilerReady; },
  get lastError() { return lastError; },
};
