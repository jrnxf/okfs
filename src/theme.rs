//! The theme contract: a theme is one CSS file that sets tokens and nothing else.
//! This is the checker behind `okfs theme check` and behind `--theme <file>`.

use std::fmt;

/// The contract itself: the default value of every token.
pub const TOKENS_CSS: &str = include_str!("../ui/src/styles/tokens.css");

/// The themes compiled into the binary, in the order the switcher lists them.
pub const BUILT_IN: [(&str, &str); 5] = [
    ("default", include_str!("../themes/default.css")),
    ("paper", include_str!("../themes/paper.css")),
    ("terminal", include_str!("../themes/terminal.css")),
    ("fjord", include_str!("../themes/fjord.css")),
    ("riso", include_str!("../themes/riso.css")),
];

const COLORS: [&str; 25] = [
    "--bg",
    "--surface",
    "--sunken",
    "--fg",
    "--muted",
    "--faint",
    "--line",
    "--line-strong",
    "--accent",
    "--accent-fg",
    "--accent-soft",
    "--hover",
    "--scrim",
    "--kind-folder",
    "--kind-image",
    "--kind-media",
    "--kind-doc",
    "--kind-code",
    "--kind-data",
    "--kind-archive",
    "--syn-comment",
    "--syn-keyword",
    "--syn-string",
    "--syn-number",
    "--syn-title",
];
const FONTS: [&str; 4] = ["--font-ui", "--font-mono", "--font-prose", "--font-display"];
const OTHER: [&str; 13] = [
    "--text",
    "--weight",
    "--weight-strong",
    "--tracking",
    "--label-case",
    "--radius",
    "--radius-lg",
    "--line-w",
    "--density",
    "--shadow",
    "--shadow-tile",
    "--icon-set",
    "--icon-stroke",
];

/// Every token a theme may set.
pub fn tokens() -> impl Iterator<Item = &'static str> {
    COLORS.into_iter().chain(FONTS).chain(OTHER)
}

const LIGHT: &str = ":root";
const DARK: &str = ":root[data-scheme=\"dark\"]";

/// Text must stay readable: WCAG AA for body text.
const MIN_TEXT_CONTRAST: f64 = 4.5;
/// Tertiary text (placeholders, separators, icons) is not body text, but it must still be seen: WCAG AA for graphics.
const MIN_FAINT_CONTRAST: f64 = 3.0;
/// The accent carries short labels and the selection, not body text: WCAG AA for large text.
const MIN_ACCENT_CONTRAST: f64 = 3.0;

const FORBIDDEN: [(&str, &str); 9] = [
    ("url(", "a theme may not load anything: no url()"),
    ("image(", "a theme may not load anything: no image()"),
    ("image-set(", "a theme may not load anything: no image-set()"),
    ("src(", "a theme may not load anything: no src()"),
    ("element(", "element() is not allowed"),
    ("expression(", "expression() is not allowed"),
    ("!important", "!important is not allowed"),
    ("\\", "escapes are not allowed"),
    ("@", "at-rules are not allowed"),
];

/// A theme that passed the checker.
#[derive(Debug, Clone, PartialEq)]
pub struct Theme {
    pub name: String,
    pub author: Option<String>,
    pub about: String,
    pub light: Vec<(String, String)>,
    pub dark: Vec<(String, String)>,
}

/// One reason a theme file was refused.
#[derive(Debug, Clone, PartialEq)]
pub struct Problem {
    pub line: usize,
    pub message: String,
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "line {}: {}", self.line, self.message)
    }
}

/// The three colors the switcher shows for a theme: page, text and accent.
pub type Swatch = [String; 3];

impl Theme {
    /// The theme as CSS, written back from what the checker read and nothing else.
    pub fn to_css(&self) -> String {
        let block = |selector: &str, decls: &[(String, String)]| {
            let mut out = format!("{selector} {{\n");
            for (token, value) in decls {
                out.push_str(&format!("  {token}: {value};\n"));
            }
            out.push_str("}\n");
            out
        };
        block(LIGHT, &self.light) + &block(DARK, &self.dark)
    }

    pub fn swatch(&self, dark: bool) -> Swatch {
        let base = defaults();
        ["--bg", "--fg", "--accent"].map(|token| effective(self, base, dark, token).unwrap_or_default())
    }
}

/// The default theme, read from the contract file.
pub fn defaults() -> &'static Theme {
    static DEFAULTS: std::sync::LazyLock<Theme> = std::sync::LazyLock::new(|| {
        let (theme, problems) = parse(TOKENS_CSS);
        assert!(problems.is_empty(), "tokens.css is malformed: {problems:?}");
        theme
    });
    &DEFAULTS
}

/// A built-in theme by name.
pub fn built_in(name: &str) -> Option<Theme> {
    let (_, css) = BUILT_IN.iter().find(|(id, _)| *id == name)?;
    Some(check(css).expect("built-in themes pass the checker"))
}

/// Checks a theme file. Returns the theme, or every reason it is refused.
pub fn check(css: &str) -> Result<Theme, Vec<Problem>> {
    let (theme, mut problems) = parse(css);
    if theme.name.is_empty() {
        problems.insert(
            0,
            Problem {
                line: 1,
                message: "the file must start with a comment that names the theme: /* @name My Theme */".to_owned(),
            },
        );
    }
    if problems.is_empty() {
        problems.extend(contrast_problems(&theme));
    }
    if problems.is_empty() { Ok(theme) } else { Err(problems) }
}

/// What a token resolves to in one scheme, following the same cascade the page does:
/// the dark blocks win over the light ones, and a theme wins over the default.
fn effective(theme: &Theme, base: &Theme, dark: bool, token: &str) -> Option<String> {
    let find = |decls: &[(String, String)]| {
        decls
            .iter()
            .rev()
            .find(|(name, _)| name == token)
            .map(|(_, value)| value.clone())
    };
    let dark_value = || find(&theme.dark).or_else(|| find(&base.dark));
    dark.then(dark_value)
        .flatten()
        .or_else(|| find(&theme.light))
        .or_else(|| find(&base.light))
}

fn contrast_problems(theme: &Theme) -> Vec<Problem> {
    let base = defaults();
    let mut problems = Vec::new();
    for dark in [false, true] {
        let scheme = if dark { "dark" } else { "light" };
        let color = |token: &str| effective(theme, base, dark, token).and_then(|v| opaque_color(&v));
        let pairs = [
            ("--fg", "--bg", MIN_TEXT_CONTRAST),
            ("--fg", "--surface", MIN_TEXT_CONTRAST),
            ("--faint", "--bg", MIN_FAINT_CONTRAST),
            ("--accent-fg", "--accent", MIN_ACCENT_CONTRAST),
        ];
        for (text, back, least) in pairs {
            let (Some(a), Some(b)) = (color(text), color(back)) else {
                continue;
            };
            let ratio = contrast(a, b);
            if ratio < least {
                problems.push(Problem {
                    line: 1,
                    message: format!(
                        "{scheme}: {text} on {back} has contrast {ratio:.2}:1, the least allowed is {least}:1"
                    ),
                });
            }
        }
    }
    problems
}

/// Reads the two blocks of a theme file. Does not require the header and does not judge contrast.
fn parse(css: &str) -> (Theme, Vec<Problem>) {
    let mut theme = Theme {
        name: String::new(),
        author: None,
        about: String::new(),
        light: Vec::new(),
        dark: Vec::new(),
    };
    let mut problems = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    let mut scan = Scanner { css, at: 0 };

    scan.skip_space();
    if let Some(header) = scan.comment() {
        read_header(header, &mut theme);
    }

    loop {
        if let Err(problem) = scan.skip_blank() {
            problems.push(problem);
            break;
        }
        if scan.done() {
            break;
        }
        let line = scan.line();
        let Some(open) = scan.rest().find('{') else {
            problems.push(Problem {
                line,
                message: "expected a block: :root { ... }".to_owned(),
            });
            break;
        };
        let selector = squeeze(&scan.rest()[..open]).replace('\'', "\"");
        scan.at += open + 1;
        let body_line = scan.line();
        let Some(close) = scan.rest().find('}') else {
            problems.push(Problem {
                line,
                message: "this block is never closed".to_owned(),
            });
            break;
        };
        let body = &scan.rest()[..close];
        scan.at += close + 1;

        let decls = match selector.as_str() {
            LIGHT => &mut theme.light,
            DARK => &mut theme.dark,
            _ if selector.starts_with('@') => {
                problems.push(Problem {
                    line,
                    message: format!("at-rules are not allowed: {selector}"),
                });
                continue;
            }
            _ => {
                problems.push(Problem {
                    line,
                    message: format!(
                        "selector {selector} is not allowed: a theme has exactly two blocks, {LIGHT} and {DARK}"
                    ),
                });
                continue;
            }
        };
        if seen.contains(&selector.as_str()) {
            problems.push(Problem {
                line,
                message: format!("{selector} appears twice"),
            });
            continue;
        }
        seen.push(if selector == LIGHT { LIGHT } else { DARK });
        if body.contains('{') {
            problems.push(Problem {
                line: body_line,
                message: "blocks may not be nested".to_owned(),
            });
            continue;
        }
        read_block(body, body_line, decls, &mut problems);
    }

    for (selector, position) in [(LIGHT, 0), (DARK, 1)] {
        match seen.iter().position(|s| *s == selector) {
            None => problems.push(Problem {
                line: scan.line(),
                message: format!("the {selector} block is missing (it may be empty)"),
            }),
            Some(found) if found != position => problems.push(Problem {
                line: 1,
                message: format!("{LIGHT} must come before {DARK}"),
            }),
            Some(_) => {}
        }
    }
    problems.dedup();
    (theme, problems)
}

fn read_header(comment: &str, theme: &mut Theme) {
    let mut about = Vec::new();
    for line in comment.lines() {
        let line = line.trim().trim_start_matches('*').trim();
        if !line.contains('@') {
            if !line.is_empty() {
                about.push(line);
            }
            continue;
        }
        for field in line.split('@').skip(1) {
            let (key, value) = field.split_once(char::is_whitespace).unwrap_or((field, ""));
            let value = value.trim().to_owned();
            match key {
                "name" => theme.name = value,
                "author" if !value.is_empty() => theme.author = Some(value),
                _ => {}
            }
        }
    }
    theme.about = about.join(" ");
}

fn read_block(body: &str, first_line: usize, decls: &mut Vec<(String, String)>, problems: &mut Vec<Problem>) {
    let body = blank_comments(body);
    let mut line = first_line;
    for piece in body.split(';') {
        let here = line
            + piece
                .chars()
                .take_while(|c| c.is_whitespace())
                .filter(|c| *c == '\n')
                .count();
        line += piece.matches('\n').count();
        let decl = piece.trim();
        if decl.is_empty() {
            continue;
        }
        let mut refuse = |message: String| problems.push(Problem { line: here, message });
        let Some((token, value)) = decl.split_once(':') else {
            refuse(format!("expected a token and a value: {}", squeeze(decl)));
            continue;
        };
        let (token, value) = (token.trim(), squeeze(value));
        if !tokens().any(|known| known == token) {
            refuse(format!(
                "{token} is not a token: a theme may only set the {} listed tokens",
                tokens().count()
            ));
            continue;
        }
        match check_value(token, &value) {
            Ok(()) => decls.push((token.to_owned(), value)),
            Err(message) => refuse(format!("{token}: {message}")),
        }
    }
}

fn check_value(token: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("the value is empty".to_owned());
    }
    if value.len() > 400 {
        return Err("the value is too long".to_owned());
    }
    let lower = value.to_ascii_lowercase();
    for (needle, why) in FORBIDDEN {
        if lower.contains(needle) {
            return Err(why.to_owned());
        }
    }
    if let Some(bad) = value.chars().find(|c| "<>{}".contains(*c) || c.is_control()) {
        return Err(format!("the character {bad:?} is not allowed"));
    }

    let within = |unit: &str, low: f64, high: f64| -> Result<(), String> {
        let number = match lower.strip_suffix(unit) {
            Some(number) if !unit.is_empty() => number,
            _ if lower == "0" || unit.is_empty() => lower.as_str(),
            _ => return Err(format!("expected a value in {unit}, such as {high}{unit}")),
        };
        match number.parse::<f64>() {
            Ok(n) if (low..=high).contains(&n) => Ok(()),
            Ok(_) => Err(format!("{value} is out of bounds: {low}{unit} to {high}{unit}")),
            Err(_) => Err(format!("{value} is not a number")),
        }
    };
    let one_of = |allowed: &[&str]| -> Result<(), String> {
        if allowed.contains(&lower.as_str()) {
            Ok(())
        } else {
            Err(format!("{value} is not one of: {}", allowed.join(", ")))
        }
    };

    match token {
        "--text" => within("px", 12.0, 16.0),
        "--density" => within("", 0.8, 1.3),
        "--radius" => within("px", 0.0, 12.0),
        "--radius-lg" => within("px", 0.0, 20.0),
        "--line-w" => within("px", 1.0, 2.0),
        "--icon-stroke" => within("", 1.0, 2.0),
        "--weight" | "--weight-strong" => within("", 100.0, 900.0),
        "--tracking" if lower.ends_with("px") => within("px", -1.0, 2.0),
        "--tracking" => within("em", -0.05, 0.15),
        "--icon-set" => one_of(&["line", "solid", "none"]),
        "--label-case" => one_of(&["none", "uppercase"]),
        "--bg" | "--surface" | "--fg" | "--faint" | "--accent" | "--accent-fg" => match opaque_color(value) {
            Some(_) => Ok(()),
            None => Err(format!(
                "{value} must be an opaque hex or rgb() color so its contrast can be checked"
            )),
        },
        _ if COLORS.contains(&token) => {
            const FUNCTIONS: [&str; 11] = [
                "rgb(",
                "rgba(",
                "hsl(",
                "hsla(",
                "hwb(",
                "lab(",
                "lch(",
                "oklab(",
                "oklch(",
                "color(",
                "color-mix(",
            ];
            let named = lower.chars().all(|c| c.is_ascii_lowercase());
            let hex = lower.strip_prefix('#').is_some_and(is_hex);
            if named || hex || FUNCTIONS.iter().any(|f| lower.starts_with(f)) {
                Ok(())
            } else {
                Err(format!("{value} is not a color"))
            }
        }
        _ => Ok(()),
    }
}

fn is_hex(digits: &str) -> bool {
    matches!(digits.len(), 3 | 4 | 6 | 8) && digits.chars().all(|c| c.is_ascii_hexdigit())
}

/// Parses `#rgb`, `#rrggbb` and `rgb(r g b)`. Colors with transparency are refused.
pub fn opaque_color(value: &str) -> Option<[f64; 3]> {
    let value = value.trim().to_ascii_lowercase();
    if let Some(hex) = value.strip_prefix('#') {
        if !is_hex(hex) {
            return None;
        }
        let wide: String = match hex.len() {
            3 | 4 => hex.chars().flat_map(|c| [c, c]).collect(),
            _ => hex.to_owned(),
        };
        if wide.len() == 8 && &wide[6..] != "ff" {
            return None;
        }
        let channel = |i: usize| u8::from_str_radix(&wide[i..i + 2], 16).ok().map(f64::from);
        return Some([channel(0)?, channel(2)?, channel(4)?]);
    }
    let inner = value
        .strip_prefix("rgb(")
        .or_else(|| value.strip_prefix("rgba("))?
        .strip_suffix(')')?;
    if inner.contains('/') {
        return None;
    }
    let parts: Vec<f64> = inner
        .split([',', ' '])
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<f64>().ok().filter(|n| (0.0..=255.0).contains(n)))
        .collect::<Option<_>>()?;
    <[f64; 3]>::try_from(parts).ok()
}

/// WCAG 2 contrast ratio between two sRGB colors.
pub fn contrast(a: [f64; 3], b: [f64; 3]) -> f64 {
    let luminance = |rgb: [f64; 3]| {
        let linear = rgb.map(|channel| {
            let c = channel / 255.0;
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        });
        0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
    };
    let (a, b) = (luminance(a), luminance(b));
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}

/// Collapses runs of whitespace so values and selectors compare cleanly.
fn squeeze(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Replaces comments with spaces, keeping line breaks so line numbers stay true.
fn blank_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        let end = rest[start..].find("*/").map_or(rest.len(), |end| start + end + 2);
        out.extend(rest[start..end].chars().map(|c| if c == '\n' { '\n' } else { ' ' }));
        rest = &rest[end..];
    }
    out + rest
}

struct Scanner<'a> {
    css: &'a str,
    at: usize,
}

impl<'a> Scanner<'a> {
    fn rest(&self) -> &'a str {
        &self.css[self.at..]
    }

    fn done(&self) -> bool {
        self.at >= self.css.len()
    }

    fn line(&self) -> usize {
        self.css[..self.at].matches('\n').count() + 1
    }

    fn skip_space(&mut self) {
        self.at += self.rest().len() - self.rest().trim_start().len();
    }

    /// Takes one comment if the scanner is standing on it and returns its text.
    fn comment(&mut self) -> Option<&'a str> {
        let rest = self.rest().strip_prefix("/*")?;
        let end = rest.find("*/")?;
        self.at += end + 4;
        Some(&rest[..end])
    }

    /// Skips whitespace and comments between blocks.
    fn skip_blank(&mut self) -> Result<(), Problem> {
        loop {
            self.skip_space();
            if !self.rest().starts_with("/*") {
                return Ok(());
            }
            if self.comment().is_none() {
                return Err(Problem {
                    line: self.line(),
                    message: "this comment is never closed".to_owned(),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn theme(light: &str, dark: &str) -> String {
        format!(
            "/* @name Test  @author someone */\n:root {{\n{light}\n}}\n:root[data-scheme=\"dark\"] {{\n{dark}\n}}\n"
        )
    }

    fn refused(css: &str) -> String {
        let problems = check(css).expect_err("the theme should be refused");
        problems.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn every_built_in_theme_passes() {
        for (id, css) in BUILT_IN {
            if let Err(problems) = check(css) {
                panic!("{id} is refused: {problems:?}");
            }
        }
    }

    #[test]
    fn the_contract_has_forty_two_tokens_and_the_default_sets_them_all() {
        assert_eq!(tokens().count(), 42);
        for token in tokens() {
            assert!(
                defaults().light.iter().any(|(name, _)| name == token),
                "tokens.css does not set {token}"
            );
        }
    }

    #[test]
    fn reads_the_header_and_both_blocks() {
        let css = theme("  --radius: 4px;\n  --accent: #2d6a4f;", "  --accent: #8fc7a6;");
        let read = check(&css).unwrap();
        assert_eq!(read.name, "Test");
        assert_eq!(read.author.as_deref(), Some("someone"));
        assert_eq!(read.light.len(), 2);
        assert_eq!(read.dark, [("--accent".to_owned(), "#8fc7a6".to_owned())]);
        assert_eq!(
            check(&read.to_css().replacen(":root", "/* @name Test */ :root", 1))
                .unwrap()
                .light,
            read.light
        );
    }

    #[test]
    fn refuses_other_selectors() {
        let css = theme("", "") + ".row { display: none; }\n";
        assert!(refused(&css).contains("selector .row is not allowed"));
        let css = theme("", "").replace(":root {", ":root, body {");
        assert!(refused(&css).contains("is not allowed"));
    }

    #[test]
    fn refuses_properties_that_are_not_tokens() {
        assert!(refused(&theme("  display: none;", "")).contains("display is not a token"));
        assert!(refused(&theme("  --row-h: 90px;", "")).contains("--row-h is not a token"));
    }

    #[test]
    fn refuses_anything_that_loads() {
        assert!(refused(&theme("  --shadow: url(https://example.com/x.png);", "")).contains("no url()"));
        assert!(refused(&theme("  --font-ui: URL( 'x.woff2' );", "")).contains("no url()"));
        let css = "/* @name T */\n@import \"https://example.com/a.css\";\n".to_owned() + &theme("", "");
        assert!(refused(&css).contains("at-rules are not allowed"));
        let css = theme("", "") + "@font-face { font-family: x; }\n";
        assert!(refused(&css).contains("at-rules are not allowed"));
        assert!(refused(&theme("  --font-ui: u\\72l(x);", "")).contains("escapes are not allowed"));
    }

    #[test]
    fn enforces_the_bounds() {
        for (decl, ok) in [
            ("--text: 12px", true),
            ("--text: 16px", true),
            ("--text: 11.9px", false),
            ("--text: 17px", false),
            ("--text: 1em", false),
            ("--density: 0.8", true),
            ("--density: 1.31", false),
            ("--radius: 0", true),
            ("--radius: 12px", true),
            ("--radius: 13px", false),
            ("--radius-lg: 20px", true),
            ("--radius-lg: 21px", false),
            ("--line-w: 2px", true),
            ("--line-w: 3px", false),
            ("--line-w: 0px", false),
            ("--icon-stroke: 1", true),
            ("--icon-stroke: 2.5", false),
            ("--icon-set: solid", true),
            ("--icon-set: emoji", false),
            ("--label-case: uppercase", true),
            ("--label-case: lowercase", false),
        ] {
            let result = check(&theme(&format!("  {decl};"), ""));
            assert_eq!(result.is_ok(), ok, "{decl}: {result:?}");
        }
    }

    #[test]
    fn refuses_text_that_cannot_be_read() {
        let message = refused(&theme("  --fg: #cccccc;\n  --bg: #ffffff;", ""));
        assert!(message.contains("light: --fg on --bg has contrast"), "{message}");
        // A light block alone does not reach dark mode: the default dark colors still apply there.
        assert!(!message.contains("dark:"), "{message}");
    }

    #[test]
    fn refuses_tertiary_text_that_cannot_be_seen() {
        let message = refused(&theme("  --faint: #e0e0e0;", ""));
        assert!(message.contains("light: --faint on --bg has contrast"), "{message}");
    }

    #[test]
    fn requires_the_header_and_both_blocks_once() {
        assert!(refused(":root {}\n:root[data-scheme=\"dark\"] {}\n").contains("@name"));
        assert!(refused("/* @name T */\n:root {}\n").contains("block is missing"));
        assert!(refused(&(theme("", "") + ":root {}\n")).contains(":root appears twice"));
    }

    #[test]
    fn reports_the_line_of_a_bad_declaration() {
        let problems = check(&theme("  --radius: 4px;\n  --text: 40px;", "")).unwrap_err();
        assert_eq!(problems[0].line, 4);
    }

    #[test]
    fn contrast_matches_known_values() {
        let black_on_white = contrast([0.0; 3], [255.0; 3]);
        assert!((black_on_white - 21.0).abs() < 0.01);
        assert_eq!(opaque_color("#fff"), Some([255.0; 3]));
        assert_eq!(opaque_color("rgb(20 20 18)"), Some([20.0, 20.0, 18.0]));
        assert_eq!(opaque_color("rgb(20 20 18 / 0.4)"), None);
    }
}
