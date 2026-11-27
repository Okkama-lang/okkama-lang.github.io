// What the playground takes from CodeMirror 6: one ES module, ../codemirror.min.js (build.sh).
export { EditorState, StateField, StateEffect, Compartment, Prec, RangeSetBuilder } from '@codemirror/state';
export {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, Decoration, ViewPlugin, hoverTooltip,
  showTooltip, tooltips, placeholder,
} from '@codemirror/view';
export {
  StreamLanguage, LanguageSupport, HighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput,
  indentUnit, foldGutter, foldKeymap, StringStream, indentService,
} from '@codemirror/language';
export { history, defaultKeymap, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
export {
  autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, snippet, startCompletion,
} from '@codemirror/autocomplete';
export { linter, setDiagnostics, lintGutter, lintKeymap, forceLinting } from '@codemirror/lint';
export { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
export { tags } from '@lezer/highlight';
