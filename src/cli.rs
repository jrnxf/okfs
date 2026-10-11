//! The command line: `okfs [PATH]`, `okfs theme check <file>` and `okfs theme list`.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};

use crate::index::Index;
use crate::paths::Root;
use crate::server::{self, App, Options, ThemeChoice};
use crate::theme;

const EXAMPLES: &str = "\
Examples:
  okfs                            serve this folder at http://127.0.0.1:8080/
  okfs ~/photos --port 9000       serve another folder on another port
  okfs --bind 0.0.0.0             let other machines on the network in
  okfs --index index.html         open a folder that holds an index.html as that page
  okfs --theme paper              start in a built-in theme (see: okfs theme list)
  okfs --theme ./mine.css         start in your own theme
  okfs theme check ./mine.css     check a theme file against the contract

Everything is read only. There is no upload, no delete and no editing.";

/// A web file browser. Run it in a folder and flip through every file inside.
#[derive(Parser)]
#[command(name = "okfs", version, after_help = EXAMPLES, args_conflicts_with_subcommands = true)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[command(flatten)]
    serve: Serve,
}

#[derive(Args)]
struct Serve {
    /// The folder to serve
    #[arg(default_value = ".", value_name = "PATH")]
    path: PathBuf,

    /// Address to listen on. Use 0.0.0.0 to let other machines in
    #[arg(short, long, default_value = "127.0.0.1", value_name = "ADDR")]
    bind: IpAddr,

    /// Port to listen on
    #[arg(short, long, default_value_t = 8080)]
    port: u16,

    /// Open a folder that holds a file of this name as that page: --index index.html
    #[arg(long, value_name = "FILE")]
    index: Option<String>,

    /// Theme a new visitor starts in: a built-in name or a theme file
    #[arg(long, default_value = "default", value_name = "NAME|FILE", help_heading = "Look")]
    theme: String,

    /// Your own stylesheet, loaded after the theme. Class names are not a promise
    #[arg(long, value_name = "FILE", help_heading = "Look")]
    css: Option<PathBuf>,

    /// A Markdown note shown above every folder
    #[arg(long, value_name = "FILE.md", help_heading = "Look")]
    header: Option<PathBuf>,

    /// Name shown in the corner and the browser tab
    #[arg(long, default_value = "okfs", value_name = "TEXT", help_heading = "Look")]
    title: String,

    /// Accent color in every theme, as hex: "#2d6a4f"
    #[arg(long, value_name = "COLOR", help_heading = "Look")]
    accent: Option<String>,

    /// Show and serve dotfiles. Left out by default
    #[arg(short = 'H', long)]
    hidden: bool,

    /// Also answer to this host name, for a proxy or a tunnel. Repeatable
    #[arg(long, value_name = "NAME")]
    allow_host: Vec<String>,
}

#[derive(Subcommand)]
enum Command {
    /// Work with themes
    Theme {
        #[command(subcommand)]
        action: ThemeAction,
    },
}

#[derive(Subcommand)]
enum ThemeAction {
    /// Check a theme file against the contract
    Check { file: PathBuf },
    /// List the built-in themes
    List,
}

pub fn run() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Some(Command::Theme {
            action: ThemeAction::Check { file },
        }) => theme_check(&file),
        Some(Command::Theme {
            action: ThemeAction::List,
        }) => {
            theme_list();
            Ok(())
        }
        None => serve(cli.serve),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("okfs: {message}");
            ExitCode::FAILURE
        }
    }
}

fn theme_check(file: &std::path::Path) -> Result<(), String> {
    let (_, theme) = server::read_theme(file)?;
    println!("{}: ok ({})", file.display(), theme.name);
    Ok(())
}

fn theme_list() {
    for (id, _) in theme::BUILT_IN {
        if let Some(theme) = theme::built_in(id) {
            println!("{id:<10} {}", theme.about);
        }
    }
}

fn serve(args: Serve) -> Result<(), String> {
    let root =
        Root::new(&args.path, args.hidden).map_err(|error| format!("cannot serve {}: {error}", args.path.display()))?;
    let theme = if theme::built_in(&args.theme).is_some() {
        ThemeChoice::BuiltIn(args.theme.clone())
    } else if std::path::Path::new(&args.theme).is_file() {
        ThemeChoice::File(PathBuf::from(&args.theme))
    } else {
        let names: Vec<&str> = theme::BUILT_IN.iter().map(|(id, _)| *id).collect();
        return Err(format!(
            "{} is not a built-in theme ({}) and not a file",
            args.theme,
            names.join(", ")
        ));
    };
    if let Some(accent) = &args.accent
        && (!accent.starts_with('#') || theme::opaque_color(accent).is_none())
    {
        return Err(format!("--accent {accent} is not a hex color such as #2d6a4f"));
    }
    if let Some(index) = &args.index
        && (index.is_empty() || index == "." || index == ".." || index.contains(['/', '\\']))
    {
        return Err(format!("--index {index} is not a plain file name such as index.html"));
    }
    for (flag, file) in [("--css", &args.css), ("--header", &args.header)] {
        if let Some(file) = file
            && !file.is_file()
        {
            return Err(format!("{flag} {} is not a file", file.display()));
        }
    }

    let options = Options {
        title: args.title,
        theme,
        accent: args.accent,
        css: args.css,
        header: args.header,
        index: args.index,
        allow_hosts: args.allow_host,
        check_host: args.bind.is_loopback(),
        cache: dirs::cache_dir().map(|dir| dir.join("okfs").join("thumbs")),
    };
    let theme_name = match &options.theme {
        ThemeChoice::BuiltIn(name) => name.clone(),
        ThemeChoice::File(path) => path.display().to_string(),
    };
    let app = App::new(root.clone(), Index::spawn(root.clone()), options)?;
    std::thread::spawn(crate::render::warm);

    let runtime = tokio::runtime::Runtime::new().map_err(|error| format!("cannot start: {error}"))?;
    runtime.block_on(async {
        let address = SocketAddr::new(args.bind, args.port);
        let listener = tokio::net::TcpListener::bind(address)
            .await
            .map_err(|error| format!("cannot listen on {address}: {error}"))?;
        let address = listener.local_addr().unwrap_or(address);
        println!("okfs {}", env!("CARGO_PKG_VERSION"));
        println!("  serving  {} (read only)", root.dir().display());
        println!("  at       http://{address}/");
        println!("  theme    {theme_name}");
        axum::serve(listener, server::router(app))
            .with_graceful_shutdown(async {
                let _ = tokio::signal::ctrl_c().await;
            })
            .await
            .map_err(|error| format!("the server stopped: {error}"))
    })
}
