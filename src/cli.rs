//! The command line: `okfs [PATH]`, `okfs theme check <file>`, `okfs theme list` and
//! `okfs completions <shell>`.

use std::io::{self, IsTerminal};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use clap::{Args, CommandFactory, Parser, Subcommand};
use clap_complete::Shell;

use crate::every;
use crate::index::{Follow, Index};
use crate::lan::{self, Scan};
use crate::paths::Root;
use crate::server::{self, App, Options, ThemeChoice};
use crate::theme;

const EXAMPLES: &str = "\
Examples:
  okfs                            serve this folder at http://127.0.0.1:8080/
  okfs ~/photos --port 9000       serve another folder on another port
  okfs --port 0                   serve on any free port
  okfs --bind 0.0.0.0             let other machines on the network in
  okfs --bind 0.0.0.0 --qr        and print a QR code a phone can scan to open it
  okfs --no-open                  serve without opening the browser
  okfs --index index.html         open a folder that holds an index.html as that page
  okfs --theme paper              start in a built-in theme (see: okfs theme list)
  okfs --theme ./mine.css         start in your own theme
  okfs theme check ./mine.css     check a theme file against the contract
  okfs --allow-delete             let visitors delete files and folders
  okfs --rescan 6h                read the whole tree again every 6 hours instead of watching it
  okfs completions zsh            print the completions for a shell

Everything is read only unless you pass --allow-delete. There is no upload and no editing.";

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
    #[arg(short, long, default_value = "127.0.0.1", value_name = "ADDR", value_parser = address)]
    bind: IpAddr,

    /// Port to listen on, 0 for any free one. Without it, 8080 or the next free port after it
    #[arg(short, long)]
    port: Option<u16>,

    /// Print a QR code for the address another device can use. Needs a terminal
    #[arg(long)]
    qr: bool,

    /// Do not open the browser. It is never opened without a terminal or over SSH
    #[arg(long)]
    no_open: bool,

    /// Open a folder that holds a file of this name as that page: --index index.html
    #[arg(long, value_name = "FILE")]
    index: Option<String>,

    /// Theme a new visitor starts in: a built-in name or a theme file
    #[arg(long, default_value = "default", value_name = "NAME|FILE", help_heading = "Look")]
    theme: String,

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

    /// Let anyone who can reach the address delete files and folders. Off by default
    #[arg(long)]
    allow_delete: bool,

    /// Read the whole tree again this often instead of watching it for changes: --rescan 6h.
    /// For a tree too big to watch, or a network share that other machines write to
    #[arg(long, value_name = "EVERY", value_parser = every::parse)]
    rescan: Option<Duration>,
}

#[derive(Subcommand)]
enum Command {
    /// Work with themes
    Theme {
        #[command(subcommand)]
        action: ThemeAction,
    },
    /// Print the completions for a shell, to load from its startup file or a completions folder
    Completions { shell: Shell },
    /// Print the manual page, okfs(1), for packages to install
    #[command(hide = true)]
    Manpage,
    /// Draw the first page of the PDF on standard input. okfs runs this itself: see `pdf`
    #[command(hide = true)]
    PdfPage { width: u32 },
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
        Some(Command::Completions { shell }) => {
            clap_complete::generate(shell, &mut Cli::command(), "okfs", &mut io::stdout());
            Ok(())
        }
        Some(Command::Manpage) => match clap_mangen::Man::new(Cli::command()).render(&mut io::stdout()) {
            // Read only in part, as by `head`: what was read is what was wanted.
            Err(error) if error.kind() != io::ErrorKind::BrokenPipe => {
                Err(format!("cannot write the manual page: {error}"))
            }
            _ => Ok(()),
        },
        Some(Command::PdfPage { width }) => {
            // Its failures are for the server that started it, which reads the exit code alone.
            return match crate::pdf::page(width) {
                Ok(()) => ExitCode::SUCCESS,
                Err(_) => ExitCode::FAILURE,
            };
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

/// okfs itself, to start again for the work it does in a process of its own.
fn this_program() -> Option<PathBuf> {
    // On Linux this name still leads to the running program after its file has been replaced.
    let running = PathBuf::from("/proc/self/exe");
    if running.exists() {
        return Some(running);
    }
    std::env::current_exe().ok()
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

/// An address to listen on: an IP address, or `localhost` for 127.0.0.1.
fn address(text: &str) -> Result<IpAddr, String> {
    if text.eq_ignore_ascii_case("localhost") {
        return Ok(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
    text.parse()
        .map_err(|_| "not an IP address such as 127.0.0.1 or 0.0.0.0, or localhost".to_owned())
}

/// The port okfs listens on when none is given.
const PORT: u16 = 8080;
/// Ports tried after it when it is busy and none was given, at most.
const PORTS_AFTER: u16 = 20;

/// Listens on `bind`, at the port asked for or, when none was, at the first free one from 8080.
/// A port that was asked for is never traded for another: a proxy or a bookmark points at it.
async fn listen(bind: IpAddr, asked: Option<u16>) -> Result<tokio::net::TcpListener, String> {
    let ports = match asked {
        Some(port) => port..=port,
        None => PORT..=PORT + PORTS_AFTER,
    };
    let (first, last) = (*ports.start(), *ports.end());
    for port in ports {
        let address = SocketAddr::new(bind, port);
        match tokio::net::TcpListener::bind(address).await {
            Ok(listener) => return Ok(listener),
            Err(error) if error.kind() == io::ErrorKind::AddrInUse && port < last => {}
            Err(error) if error.kind() == io::ErrorKind::AddrInUse && asked.is_some() => {
                return Err(format!(
                    "cannot listen on {address}: the port is busy. Pass another --port, or --port 0 for any free one"
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
                return Err(format!(
                    "cannot listen on {bind}: ports {first} to {last} are all busy. Pass --port 0 for any free one"
                ));
            }
            Err(error) => return Err(format!("cannot listen on {address}: {error}")),
        }
    }
    unreachable!("a range of ports is never empty")
}

/// Ends when okfs is asked to stop: Ctrl-C in a terminal, or SIGTERM from a service manager such as
/// systemd or docker.
async fn stopped() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut terminate) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

/// Whether to open the browser: not when asked not to, not when output goes anywhere but a
/// terminal (a service, a pipe), and not over SSH, where it would open on the far machine.
fn should_open(no_open: bool, terminal: bool, ssh: bool) -> bool {
    !no_open && terminal && !ssh
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
    if let Some(header) = &args.header
        && !header.is_file()
    {
        return Err(format!("--header {} is not a file", header.display()));
    }

    let options = Options {
        title: args.title,
        theme,
        accent: args.accent,
        header: args.header,
        index: args.index,
        allow_hosts: args.allow_host,
        check_host: true,
        allow_delete: args.allow_delete,
        cache: dirs::cache_dir().map(|dir| dir.join("okfs").join("thumbs")),
        drawer: this_program(),
        pdf_limit: crate::pdf::LIMIT,
    };
    let theme_name = match &options.theme {
        ThemeChoice::BuiltIn(name) => name.clone(),
        ThemeChoice::File(path) => path.display().to_string(),
    };
    let follow = args.rescan.map_or(Follow::Watch, Follow::Rescan);
    let index = Index::spawn(root.clone(), follow);
    let app = App::new(root.clone(), std::sync::Arc::clone(&index), options)?;
    std::thread::spawn(crate::render::warm);

    let runtime = tokio::runtime::Runtime::new().map_err(|error| format!("cannot start: {error}"))?;
    runtime.block_on(async {
        let listener = listen(args.bind, args.port).await?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("cannot listen on {}: {error}", args.bind))?;
        println!("okfs {}", env!("CARGO_PKG_VERSION"));
        let writes = if args.allow_delete {
            "visitors can delete"
        } else {
            "read only"
        };
        println!("  serving  {} ({writes})", root.dir().display());
        if let Follow::Rescan(every) = follow {
            println!("  rescan   every {}", every::spoken(every));
        }
        if args.port.is_none() && address.port() != PORT {
            println!("  port     {}, as {PORT} is busy", address.port());
        }
        let addresses = lan::addresses(address.ip(), &lan::found());
        for (index, ip) in addresses.iter().enumerate() {
            let label = if index == 0 { "at" } else { "" };
            println!("  {label:<8} {}", lan::link(*ip, address.port()));
        }
        println!("  theme    {theme_name}");
        if args.qr {
            match lan::scan(
                address.ip(),
                &addresses,
                address.port(),
                std::io::stdout().is_terminal(),
            ) {
                Scan::Code(lines) => {
                    println!();
                    for line in lines {
                        println!("  {line}");
                    }
                }
                Scan::Nothing(why) => println!("  qr       {why}"),
                Scan::Skipped => {}
            }
        }
        let ssh = std::env::var_os("SSH_CONNECTION").is_some() || std::env::var_os("SSH_TTY").is_some();
        if should_open(args.no_open, std::io::stdout().is_terminal(), ssh)
            && let Some(ip) = addresses.first()
        {
            let link = lan::link(*ip, address.port());
            if let Err(error) = webbrowser::open(&link) {
                println!("  open     could not open the browser: {error}");
            }
        }
        axum::serve(listener, server::router(app))
            .with_graceful_shutdown(async move {
                stopped().await;
                // An open page holds a stream that would never end by itself.
                index.feed().close();
            })
            .await
            .map_err(|error| format!("the server stopped: {error}"))
    })
}

#[cfg(test)]
mod tests {
    use super::should_open;

    #[test]
    fn opens_only_in_a_local_terminal_unless_told_not_to() {
        assert!(should_open(false, true, false));
        assert!(!should_open(true, true, false));
        assert!(!should_open(false, false, false));
        assert!(!should_open(false, true, true));
    }
}
