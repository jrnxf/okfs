//! Markdown and syntax highlighting, done here so the page ships no parser.
//! Highlighted code uses five classes, one per `--syn-*` token.

use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use syntect::parsing::{ParseState, Scope, ScopeStack, ScopeStackOp, SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

use crate::paths;

/// Text larger than this is not previewed at all.
pub const MAX_TEXT: u64 = 2 * 1024 * 1024;
/// Text larger than this is shown without colors: highlighting cost grows with size.
const MAX_HIGHLIGHT: usize = 512 * 1024;
/// A line longer than this is minified or generated, and highlighting it is slow and useless.
const MAX_LINE: usize = 4000;

static SYNTAXES: LazyLock<SyntaxSet> = LazyLock::new(two_face::syntax::extra_newlines);

/// Loads the syntax definitions ahead of the first preview.
pub fn warm() {
    LazyLock::force(&SYNTAXES);
    LazyLock::force(&RULES);
}

/// The five token classes, matching `--syn-comment`, `-keyword`, `-string`, `-number`, `-title`.
#[derive(Clone, Copy, PartialEq)]
enum Class {
    Comment,
    Keyword,
    String,
    Number,
    Title,
}

impl Class {
    fn name(self) -> &'static str {
        match self {
            Class::Comment => "tk-c",
            Class::Keyword => "tk-k",
            Class::String => "tk-s",
            Class::Number => "tk-n",
            Class::Title => "tk-t",
        }
    }
}

struct Rules {
    /// Checked against the whole stack first: an object key is a string, but reads as a name.
    key: Scope,
    /// Checked from the innermost scope outwards. `None` stops the search with no color.
    by_prefix: Vec<(Scope, Option<Class>)>,
}

static RULES: LazyLock<Rules> = LazyLock::new(|| {
    let scope = |name: &str| Scope::new(name).expect("a valid scope");
    let rule = |name: &str, class| (scope(name), class);
    Rules {
        key: scope("meta.mapping.key"),
        by_prefix: vec![
            rule("comment", Some(Class::Comment)),
            rule("string", Some(Class::String)),
            rule("constant.numeric", Some(Class::Number)),
            rule("constant.language", Some(Class::Keyword)),
            rule("constant.character.escape", Some(Class::Number)),
            rule("keyword.operator.word", Some(Class::Keyword)),
            rule("keyword.operator", None),
            rule("keyword", Some(Class::Keyword)),
            rule("storage", Some(Class::Keyword)),
            rule("entity.name", Some(Class::Title)),
            rule("support.function", Some(Class::Title)),
            rule("support.type", Some(Class::Title)),
            rule("support.class", Some(Class::Title)),
            rule("variable.function", Some(Class::Title)),
            rule("markup.heading", Some(Class::Title)),
            rule("markup.raw", Some(Class::String)),
        ],
    }
});

fn class_of(stack: &ScopeStack) -> Option<Class> {
    let scopes = stack.as_slice();
    if scopes.iter().any(|scope| RULES.key.is_prefix_of(*scope)) {
        return Some(Class::Title);
    }
    for scope in scopes.iter().rev() {
        for (prefix, class) in &RULES.by_prefix {
            if prefix.is_prefix_of(*scope) {
                return *class;
            }
        }
    }
    None
}

pub fn escape(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
}

fn syntax_for(name: &str, first_line: &str) -> Option<&'static SyntaxReference> {
    let set = &*SYNTAXES;
    let ext = paths::extension(name);
    set.find_syntax_by_extension(name)
        .or_else(|| set.find_syntax_by_extension(&ext))
        .or_else(|| set.find_syntax_by_token(&ext))
        .or_else(|| set.find_syntax_by_first_line(first_line))
        .filter(|syntax| syntax.name != "Plain Text")
}

/// Lines colored between two looks at whether the reader is still there.
const LOOK_EVERY: usize = 16;

/// For coloring nobody can walk away from: a fenced block, a tile's cover.
static STAYS: AtomicBool = AtomicBool::new(false);

/// Colors one run of source, calling `line` with the markup of each line. Stops with
/// `None` once `gone` is true: the reader left, and the rest would be thrown away.
fn highlight_lines(src: &str, syntax: &SyntaxReference, gone: &AtomicBool, mut line: impl FnMut(&str)) -> Option<()> {
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut html = String::new();
    for (count, text) in LinesWithEndings::from(src).enumerate() {
        if count % LOOK_EVERY == 0 && gone.load(Ordering::Relaxed) {
            return None;
        }
        html.clear();
        let ops = state.parse_line(text, &SYNTAXES).ok()?;
        let mut at = 0;
        // The class of the span that is open, so neighbours of one class share it.
        let mut open: Option<Class> = None;
        let mut gap = String::new();
        let mut emit = |upto: usize, stack: &ScopeStack, html: &mut String| {
            let piece = text[at..upto].trim_end_matches(['\n', '\r']);
            at = upto;
            if piece.is_empty() {
                return;
            }
            // Blank text waits for what follows: it joins a span only when both sides share a class.
            if piece.trim().is_empty() {
                gap.push_str(piece);
                return;
            }
            let class = class_of(stack);
            if class != open {
                if open.is_some() {
                    html.push_str("</span>");
                }
                html.push_str(&gap);
                gap.clear();
                if let Some(class) = class {
                    html.push_str("<span class=\"");
                    html.push_str(class.name());
                    html.push_str("\">");
                }
                open = class;
            }
            html.push_str(&gap);
            gap.clear();
            escape(piece, html);
        };
        for (offset, op) in ops {
            emit(offset, &stack, &mut html);
            apply(&mut stack, &op)?;
        }
        emit(text.len(), &stack, &mut html);
        if open.is_some() {
            html.push_str("</span>");
        }
        html.push_str(&gap);
        line(&html);
    }
    Some(())
}

fn apply(stack: &mut ScopeStack, op: &ScopeStackOp) -> Option<()> {
    stack.apply(op).ok()
}

fn colorable(src: &str) -> bool {
    src.len() <= MAX_HIGHLIGHT && src.lines().all(|line| line.len() <= MAX_LINE)
}

/// A file, or its start, as numbered lines.
pub struct Code {
    pub html: String,
    /// The lines of the whole file, whatever part of it is in `html`.
    pub lines: usize,
    pub highlighted: bool,
    /// Only the start of the file is in `html`.
    pub more: bool,
}

/// Renders a source file. `name` picks the syntax; unknown names come out plain.
pub fn code(src: &str, name: &str) -> Code {
    code_start(src, name, None, &STAYS)
}

/// Renders a source file, or with `first` only that many of its lines: coloring costs by
/// the line, and a file passed under a held key shows one screen of them. The limits on
/// size and line length then apply to that part alone. `gone` turning true stops the
/// coloring; what comes back is then not worth sending.
pub fn code_start(src: &str, name: &str, first: Option<usize>, gone: &AtomicBool) -> Code {
    let whole = src.strip_suffix('\n').unwrap_or(src);
    let end = first
        .and_then(|limit| whole.match_indices('\n').nth(limit.saturating_sub(1)))
        .map_or(whole.len(), |(at, _)| at);
    let more = end < whole.len();
    let src = &whole[..end];
    let syntax = colorable(src)
        .then(|| syntax_for(name, src.lines().next().unwrap_or("")))
        .flatten();
    let mut html = String::with_capacity(src.len() * 2);
    let mut lines = 0;
    let mut push = |markup: &str| {
        html.push_str("<span class=\"ln\">");
        html.push_str(markup);
        html.push_str("</span>");
        lines += 1;
    };
    let highlighted = syntax.is_some_and(|syntax| highlight_lines(src, syntax, gone, &mut push).is_some());
    if !highlighted {
        html.clear();
        lines = 0;
        let mut plain = String::new();
        for line in src.lines() {
            plain.clear();
            escape(line, &mut plain);
            html.push_str("<span class=\"ln\">");
            html.push_str(&plain);
            html.push_str("</span>");
            lines += 1;
        }
    }
    if more {
        lines = whole.lines().count();
    }
    Code {
        html,
        lines,
        highlighted,
        more,
    }
}

/// A fenced block inside Markdown: colored, with real line breaks and no line numbers.
fn fence(src: &str, lang: &str) -> String {
    let syntax = (!lang.is_empty() && colorable(src))
        .then(|| SYNTAXES.find_syntax_by_token(lang))
        .flatten();
    let mut html = String::with_capacity(src.len() * 2);
    let done = syntax.is_some_and(|syntax| {
        highlight_lines(src, syntax, &STAYS, |markup| {
            html.push_str(markup);
            html.push('\n');
        })
        .is_some()
    });
    if !done {
        html.clear();
        escape(src, &mut html);
    }
    html
}

/// Characters left as they are inside one path segment of a URL.
const SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'/')
    .add(b'\\');

/// Encodes a path relative to the served folder for use in a URL.
pub fn encode_path(rel: &str) -> String {
    rel.split('/')
        .map(|segment| utf8_percent_encode(segment, SEGMENT).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// The first path segments the server keeps for itself.
pub const RESERVED: [&str; 6] = ["api", "raw", "zip", "assets", "theme.css", "-"];

/// The address that shows a path in the browser. A top-level name that collides
/// with one of the server's own goes behind `/-/`.
pub fn view_url(encoded: &str) -> String {
    let first = encoded.split('/').next().unwrap_or("");
    if RESERVED.contains(&first) {
        format!("/-/{encoded}")
    } else {
        format!("/{encoded}")
    }
}

/// Resolves a link found in a Markdown file against the folder that file is in.
/// Returns `None` for links that already point somewhere absolute.
fn relative_target(base_dir: &str, url: &str) -> Option<String> {
    let has_scheme = url.split_once(':').is_some_and(|(scheme, _)| {
        !scheme.is_empty() && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    });
    if has_scheme || url.starts_with("//") || url.starts_with('#') || url.is_empty() {
        return None;
    }
    let cut = url.find(['?', '#']).unwrap_or(url.len());
    let (path, tail) = url.split_at(cut);
    let mut parts: Vec<String> = if path.starts_with('/') {
        Vec::new()
    } else {
        encode_path(base_dir)
            .split('/')
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect()
    };
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part.to_owned()),
        }
    }
    let slash = if path.ends_with('/') && !parts.is_empty() {
        "/"
    } else {
        ""
    };
    Some(format!("{}{slash}{tail}", parts.join("/")))
}

fn cleaner(base_dir: &str) -> ammonia::Builder<'static> {
    let base_dir = base_dir.to_owned();
    let mut builder = ammonia::Builder::default();
    builder
        .add_tags(["input"])
        .add_tag_attributes("input", ["type", "checked", "disabled"])
        .add_allowed_classes("span", ["tk-c", "tk-k", "tk-s", "tk-n", "tk-t"])
        .url_relative(ammonia::UrlRelative::PassThrough)
        .link_rel(Some("noopener noreferrer"))
        .attribute_filter(move |element, attribute, value| match (element, attribute) {
            ("input", "type") => (value == "checkbox").then(|| value.into()),
            ("img", "src") => Some(match relative_target(&base_dir, value) {
                Some(target) => format!("/raw/{target}").into(),
                None => value.into(),
            }),
            ("a", "href") => Some(match relative_target(&base_dir, value) {
                Some(target) => view_url(&target).into(),
                None => value.into(),
            }),
            _ => Some(value.into()),
        });
    builder
}

/// Renders Markdown to safe HTML. Raw HTML in the source is cleaned, never trusted.
/// `base_dir` is the folder the file is in, so its relative links and images resolve.
pub fn markdown(src: &str, base_dir: &str) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_GFM;
    let mut events = Vec::new();
    let mut block: Option<(String, String)> = None;
    for event in Parser::new_ext(src, options) {
        match (&mut block, event) {
            (None, Event::Start(Tag::CodeBlock(kind))) => {
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => info.split([' ', ',']).next().unwrap_or("").to_owned(),
                    CodeBlockKind::Indented => String::new(),
                };
                block = Some((lang, String::new()));
            }
            (Some((lang, text)), Event::End(TagEnd::CodeBlock)) => {
                let html = format!("<pre><code>{}</code></pre>", fence(text, lang));
                events.push(Event::Html(html.into()));
                block = None;
            }
            (Some((_, text)), Event::Text(chunk)) => text.push_str(&chunk),
            (_, event) => events.push(event),
        }
    }
    let mut html = String::with_capacity(src.len() * 2);
    pulldown_cmark::html::push_html(&mut html, events.into_iter());
    cleaner(base_dir).clean(&html).to_string()
}

/// True for the file whose contents are shown under its folder's listing.
pub fn is_readme(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "readme.md" | "readme.markdown")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_never_lets_script_through() {
        let html = markdown(
            "# Hi\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n<a href=\"javascript:alert(1)\">y</a>",
            "",
        );
        assert!(!html.contains("<script"), "{html}");
        assert!(!html.contains("onerror"), "{html}");
        assert!(!html.contains("javascript:"), "{html}");
        assert!(html.contains("<h1>Hi</h1>"), "{html}");
    }

    #[test]
    fn markdown_points_relative_links_into_the_served_folder() {
        let html = markdown(
            "![a](<img/a b.png>) [n](../notes.md) [o](https://example.com/) ![r](/top.png)",
            "docs/guide",
        );
        assert!(html.contains("src=\"/raw/docs/guide/img/a%20b.png\""), "{html}");
        assert!(html.contains("href=\"/docs/notes.md\""), "{html}");
        assert!(html.contains("href=\"https://example.com/\""), "{html}");
        assert!(html.contains("src=\"/raw/top.png\""), "{html}");
        // A link cannot climb out of the served folder, and a reserved name goes behind /-/.
        let html = markdown("[up](../../../etc/passwd) [api](api/x.md)", "");
        assert!(html.contains("href=\"/etc/passwd\""), "{html}");
        assert!(html.contains("href=\"/-/api/x.md\""), "{html}");
    }

    #[test]
    fn code_maps_scopes_onto_the_five_classes() {
        let out = code(
            "// note\nfn main() {\n    let n = 42;\n    println!(\"hi\");\n}\n",
            "main.rs",
        );
        assert!(out.highlighted);
        assert_eq!(out.lines, 5);
        assert!(out.html.contains("<span class=\"tk-c\">// note</span>"), "{}", out.html);
        assert!(out.html.contains("<span class=\"tk-k\">fn</span>"), "{}", out.html);
        assert!(out.html.contains("<span class=\"tk-t\">main</span>"), "{}", out.html);
        assert!(out.html.contains("<span class=\"tk-n\">42</span>"), "{}", out.html);
        assert!(
            out.html.contains("<span class=\"tk-s\">&quot;hi&quot;</span>"),
            "{}",
            out.html
        );
    }

    #[test]
    fn code_start_colors_the_first_lines_and_counts_them_all() {
        let src = "let a = 1;\nlet b = 2;\nlet c = 3;\n";
        let start = code_start(src, "a.js", Some(2), &STAYS);
        assert!(start.more);
        assert_eq!(start.lines, 3);
        assert_eq!(start.html.matches("class=\"ln\"").count(), 2);
        assert!(start.highlighted);
        // A file no longer than the limit is whole.
        let whole = code_start(src, "a.js", Some(3), &STAYS);
        assert!(!whole.more);
        assert_eq!(whole.html, code(src, "a.js").html);
        // A long line further down does not cost the start its colors.
        let long = format!("let a = 1;\nlet x = \"{}\";", "a".repeat(MAX_LINE));
        assert!(code_start(&long, "a.js", Some(1), &STAYS).highlighted);
    }

    #[test]
    fn coloring_stops_for_a_reader_who_left() {
        let gone = AtomicBool::new(true);
        let out = code_start("let a = 1;\n", "a.js", None, &gone);
        assert!(!out.highlighted);
    }

    #[test]
    fn code_escapes_markup_and_skips_colors_for_huge_lines() {
        let out = code("<b>&</b>", "notes.txt");
        assert_eq!(out.html, "<span class=\"ln\">&lt;b&gt;&amp;&lt;/b&gt;</span>");
        let long = format!("let x = \"{}\";", "a".repeat(MAX_LINE));
        assert!(!code(&long, "a.js").highlighted);
    }
}
