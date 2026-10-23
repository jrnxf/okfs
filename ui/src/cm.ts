// The editor itself: CodeMirror, in a chunk of its own. The page fetches it the first time a file is edited, and only
// on a server that lets files change: a page that only reads never loads it.

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { xml } from "@codemirror/lang-xml";
import {
  HighlightStyle,
  type LanguageSupport,
  StreamLanguage,
  type StreamParser,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/** What the page holds of an editor it put up. */
export interface Editing {
  /** The text as it is now, its lines joined by `\n`. */
  text(): string;
  /** Puts other text in, as a change of its own that undo takes back. */
  replace(text: string): void;
  /** Wraps long lines, or not. */
  wrap(on: boolean): void;
  focus(): void;
  destroy(): void;
}

export interface Mount {
  /** The file's extension, lowercase, for its language. */
  ext: string;
  /** The nonce the page's policy lets a style element in with: CodeMirror adds its styles as one. */
  nonce?: string;
  wrap: boolean;
  /** Called after each change to the text. */
  changed: () => void;
  /** Mod-s. */
  save: () => void;
}

const legacy = (parser: StreamParser<unknown>): Extension => StreamLanguage.define(parser);

/** The language a file is colored as, by its extension. None for a file whose language is not here. */
function languageOf(ext: string): Extension | LanguageSupport {
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "md":
    case "markdown":
      return markdown();
    case "py":
      return python();
    case "rs":
      return rust();
    case "json":
      return json();
    case "css":
    case "scss":
      return css();
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return html();
    case "xml":
    case "svg":
      return xml();
    case "sh":
    case "bash":
    case "zsh":
      return legacy(shell);
    case "toml":
      return legacy(toml);
    case "yaml":
    case "yml":
      return legacy(yaml);
    default:
      return [];
  }
}

/** The colors of the code, from the theme's own tokens: a theme that changes them changes the editor too. */
const colors = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], color: "var(--syn-comment)" },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier, t.definitionKeyword, t.moduleKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.attributeValue], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: "var(--syn-number)" },
  {
    tag: [
      t.heading,
      t.function(t.variableName),
      t.function(t.propertyName),
      t.standard(t.variableName),
      t.typeName,
      t.className,
      t.tagName,
      t.namespace,
    ],
    color: "var(--syn-title)",
  },
  { tag: t.heading, fontWeight: "var(--weight-strong)" },
  { tag: t.strong, fontWeight: "var(--weight-strong)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
  { tag: t.invalid, color: "var(--accent)" },
]);

/** The editor in the page's own look, from the theme's tokens. */
const look = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--surface)", color: "var(--fg)", fontSize: "var(--text-s)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", overscrollBehavior: "contain" },
  ".cm-content": { padding: "10px 0", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 16px 0 4px" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "1.5px solid var(--accent)" },
  ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--faint)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px", minWidth: "28px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent-soft) 70%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)",
  },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--syn-number) 22%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--hover)", outline: "1px solid var(--line-strong)" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--faint)", padding: "0 4px" },
  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--fg)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "var(--border)" },
  ".cm-panel.cm-search": { padding: "6px 10px", fontFamily: "var(--font-ui)", fontSize: "var(--text-s)" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { font: "inherit", color: "var(--fg)" },
  ".cm-textfield": { backgroundColor: "var(--sunken)", border: "var(--border)", borderRadius: "var(--radius)", padding: "2px 6px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--surface)", border: "var(--border)", borderRadius: "var(--radius)" },
  ".cm-tooltip": { backgroundColor: "var(--surface)", border: "var(--border)", borderRadius: "var(--radius)", boxShadow: "var(--shadow)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--fg)" },
});

/** Puts up an editor in `parent`, holding `text`. */
export function mount(parent: HTMLElement, text: string, options: Mount): Editing {
  const wrapping = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        EditorState.lineSeparator.of("\n"),
        indentOnInput(),
        syntaxHighlighting(colors),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: false }),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (options.save(), true) },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        look,
        languageOf(options.ext),
        wrapping.of(options.wrap ? EditorView.lineWrapping : []),
        options.nonce ? EditorView.cspNonce.of(options.nonce) : [],
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.changed();
        }),
        EditorView.contentAttributes.of({ "aria-label": "File text", spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
      ],
    }),
  });
  return {
    text: () => view.state.doc.toString(),
    replace: (next) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } }),
    wrap: (on) => view.dispatch({ effects: wrapping.reconfigure(on ? EditorView.lineWrapping : []) }),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
