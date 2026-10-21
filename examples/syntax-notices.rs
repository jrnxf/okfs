//! Prints the licenses of the syntax definitions two-face compiles into okfs, as Markdown, for the
//! notices attached to each release (see .github/workflows/release.yml).

fn main() {
    let mut md = String::from("# Syntax definitions\n\n");
    md.push_str(
        "okfs colors code with the syntax definitions bundled by two-face, curated by the bat project \
         (https://github.com/sharkdp/bat). Those that ask to be acknowledged:\n\n",
    );
    for license in two_face::acknowledgement::listing().for_syntaxes() {
        license.write_md(&mut md);
    }
    print!("{md}");
}
