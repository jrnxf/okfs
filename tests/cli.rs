//! The okfs program itself, started the way a person or a service starts it.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use tempfile::TempDir;

/// A running okfs, stopped when dropped.
struct Running {
    child: Child,
    port: u16,
    /// The key in the address it printed, when it asks for one.
    key: Option<String>,
    /// What it printed before its theme line: the folder, the addresses and who can reach them.
    said: String,
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Starts okfs on `served` with `args`, on a port the system picks, and waits until it listens.
fn start(served: &Path, cache: &Path, args: &[&str]) -> Running {
    launch(served, cache, &[&["--port", "0"], args].concat())
}

/// Starts okfs on `served` with `args` alone, and waits until it listens.
fn launch(served: &Path, cache: &Path, args: &[&str]) -> Running {
    let mut child = Command::new(env!("CARGO_BIN_EXE_okfs"))
        .arg("--no-open")
        .args(args)
        .arg(served)
        .env("XDG_CACHE_HOME", cache)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut said = String::new();
    let (port, key) = loop {
        let line = lines.next().expect("okfs printed its address").unwrap();
        said.push_str(&line);
        said.push('\n');
        if let Some(link) = line.trim_start().strip_prefix("at") {
            let (link, key) = link.trim().split_once("/?key=").unwrap_or((link.trim(), ""));
            let port = link.trim_end_matches('/').rsplit(':').next().unwrap();
            break (port.parse().unwrap(), (!key.is_empty()).then(|| key.to_owned()));
        }
    };
    // The lines after the address are read too, so it never waits on a full pipe.
    for line in lines
        .by_ref()
        .take_while(|line| line.as_ref().is_ok_and(|line| !line.starts_with("  theme")))
    {
        said.push_str(&line.unwrap());
        said.push('\n');
    }
    std::thread::spawn(move || lines.for_each(drop));
    Running { child, port, key, said }
}

/// Starts okfs on a folder of its own, with one file in it.
fn site(args: &[&str]) -> (TempDir, Running) {
    let tmp = TempDir::new().unwrap();
    let served = tmp.path().join("served");
    fs::create_dir_all(served.join("docs")).unwrap();
    fs::write(served.join("docs/note.txt"), "note").unwrap();
    let running = start(&served, &tmp.path().join("cache"), args);
    (tmp, running)
}

/// The status okfs answers a listing with, asked over the loopback address with this Host, with the
/// key it printed when it asks for one.
fn status(okfs: &Running, host: &str) -> u16 {
    let key = okfs.key.as_deref().map(|key| format!("&key={key}")).unwrap_or_default();
    ask(okfs.port, host, &format!("/api/list?path=docs{key}"), "").0
}

/// What okfs answers `path` with, asked as curl does, over the loopback address with this Host
/// and these further header lines.
fn ask(port: u16, host: &str, path: &str, headers: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nAccept: */*\r\n{headers}Connection: close\r\n\r\n"
    )
    .unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    let status = answer.split(' ').nth(1).unwrap().parse().unwrap();
    (status, answer)
}

#[test]
fn every_address_answers_only_to_plain_addresses_localhost_and_the_names_it_is_given() {
    for bind in ["127.0.0.1", "0.0.0.0"] {
        let (_tmp, okfs) = site(&["--bind", bind, "--allow-host", "files.example.test"]);
        let port = okfs.port;
        for host in [
            format!("127.0.0.1:{port}"),
            format!("10.94.1.206:{port}"),
            format!("[::1]:{port}"),
            format!("localhost:{port}"),
            "files.example.test".to_owned(),
            "FILES.example.test:443".to_owned(),
        ] {
            assert_eq!(status(&okfs, &host), 200, "--bind {bind}, Host: {host}");
        }
        for host in [
            "evil.example",
            "rebound.attacker.test:8080",
            "files.example.test.evil.example",
        ] {
            assert_eq!(status(&okfs, host), 403, "--bind {bind}, Host: {host}");
        }
    }
}

#[test]
fn beyond_loopback_with_no_name_given_plain_addresses_still_answer() {
    let (_tmp, okfs) = site(&["--bind", "0.0.0.0"]);
    let port = okfs.port;
    for host in [
        format!("127.0.0.1:{port}"),
        format!("192.168.1.20:{port}"),
        format!("localhost:{port}"),
    ] {
        assert_eq!(status(&okfs, &host), 200, "Host: {host}");
    }
    assert_eq!(status(&okfs, "my-laptop.local:8080"), 403);
}

#[test]
fn beyond_loopback_only_a_link_with_the_key_gets_in() {
    let (_tmp, okfs) = site(&["--bind", "0.0.0.0"]);
    let port = okfs.port;
    let key = okfs.key.clone().expect("a key in the address");
    assert_eq!(key.len(), 22, "{key}");
    // Every address printed carries it, and the line under them says what it lets in.
    let links: Vec<&str> = okfs.said.lines().filter(|line| line.contains("http://")).collect();
    assert!(
        !links.is_empty() && links.iter().all(|line| line.ends_with(&format!("/?key={key}"))),
        "{}",
        okfs.said
    );
    assert!(
        okfs.said
            .contains("  key      on: anyone with one of these links can read every file shown"),
        "{}",
        okfs.said
    );
    assert!(!okfs.said.contains("open to"), "{}", okfs.said);

    let host = format!("192.168.1.20:{port}");
    for path in [
        "/",
        "/docs/note.txt",
        "/raw/docs/note.txt",
        "/zip/",
        "/api/list?path=",
        "/api/events",
        "/assets/app.css",
    ] {
        let (status, answer) = ask(port, &host, path, "");
        assert_eq!(status, 401, "{path}");
        assert!(!answer.contains("note"), "{path}: {answer}");
        let wrong = if path.contains('?') { "&key=wrong" } else { "?key=wrong" };
        assert_eq!(ask(port, &host, &format!("{path}{wrong}"), "").0, 401, "{path}");
    }
    // curl gets the file with the key in its address.
    for path in ["/docs/note.txt", "/raw/docs/note.txt"] {
        let (status, answer) = ask(port, &host, &format!("{path}?key={key}"), "");
        assert_eq!(status, 200, "{path}");
        assert!(answer.ends_with("\r\n\r\nnote"), "{path}: {answer}");
    }
    // Or with the cookie a browser keeps, named for the port.
    let cookie = format!("Cookie: okfs-key-{port}={key}\r\n");
    assert_eq!(ask(port, &host, "/raw/docs/note.txt", &cookie).0, 200);
    // A wrong host is refused before any key is looked at.
    assert_eq!(
        ask(port, "evil.example", &format!("/raw/docs/note.txt?key={key}"), "").0,
        403
    );
}

#[test]
fn on_loopback_no_key_is_asked_for_unless_told_to() {
    let (_tmp, okfs) = site(&[]);
    assert_eq!(okfs.key, None);
    assert!(
        !okfs.said.contains("key") && !okfs.said.contains("open to"),
        "{}",
        okfs.said
    );
    assert_eq!(ask(okfs.port, "localhost", "/raw/docs/note.txt", "").0, 200);

    let (_tmp, okfs) = site(&["--key"]);
    let key = okfs.key.clone().expect("a key with --key");
    assert!(okfs.said.contains("http://127.0.0.1:"), "{}", okfs.said);
    assert!(okfs.said.contains("  key      on:"), "{}", okfs.said);
    assert_eq!(ask(okfs.port, "localhost", "/raw/docs/note.txt", "").0, 401);
    assert_eq!(
        ask(okfs.port, "localhost", &format!("/raw/docs/note.txt?key={key}"), "").0,
        200
    );
}

#[test]
fn with_no_key_anyone_who_reaches_the_address_gets_in_and_is_told_so() {
    let (_tmp, okfs) = site(&["--bind", "0.0.0.0", "--no-key"]);
    assert_eq!(okfs.key, None);
    assert!(
        okfs.said
            .contains("  open to  anyone who can reach these addresses can read every file shown"),
        "{}",
        okfs.said
    );
    assert_eq!(
        ask(
            okfs.port,
            &format!("192.168.1.20:{}", okfs.port),
            "/raw/docs/note.txt",
            ""
        )
        .0,
        200
    );

    let (_tmp, okfs) = site(&["--bind", "0.0.0.0", "--no-key", "--allow-delete"]);
    assert!(
        okfs.said
            .contains("  open to  anyone who can reach these addresses can read and delete every file shown"),
        "{}",
        okfs.said
    );

    let (ended, error) = run(&["--no-open", "--key", "--no-key", "."]);
    assert!(!ended.success());
    assert!(error.contains("cannot be used with"), "{error}");
}

#[test]
fn a_rescan_is_said_at_start_and_a_span_that_is_not_one_is_refused() {
    let (_tmp, okfs) = site(&["--rescan", "6h"]);
    assert!(okfs.said.contains("rescan   every 6h"), "{}", okfs.said);
    assert_eq!(status(&okfs, "localhost"), 200);

    let (_tmp, okfs) = site(&[]);
    assert!(!okfs.said.contains("rescan"), "{}", okfs.said);

    for wrong in ["0s", "6", "soon"] {
        let output = Command::new(env!("CARGO_BIN_EXE_okfs"))
            .args(["--no-open", "--rescan", wrong, "."])
            .output()
            .unwrap();
        assert!(!output.status.success(), "--rescan {wrong}");
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(error.contains("not a span of time"), "--rescan {wrong}: {error}");
    }
}

/// Runs okfs with `args` until it ends, and returns how it ended and what it wrote to stderr.
fn run(args: &[&str]) -> (ExitStatus, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_okfs")).args(args).output().unwrap();
    (output.status, String::from_utf8_lossy(&output.stderr).into_owned())
}

/// Waits for okfs to end by itself, for at most `limit`.
fn ended(child: &mut Child, limit: Duration) -> Option<ExitStatus> {
    let since = Instant::now();
    while since.elapsed() < limit {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

#[test]
fn a_busy_port_is_passed_over_only_when_no_port_was_given() {
    // 8080 is held here, unless something else on this machine holds it already.
    let _held = TcpListener::bind("127.0.0.1:8080");
    let tmp = TempDir::new().unwrap();
    fs::create_dir_all(tmp.path().join("docs")).unwrap();
    let okfs = launch(tmp.path(), &tmp.path().join("cache"), &[]);
    assert_ne!(okfs.port, 8080);
    assert!(
        okfs.said.contains(&format!("port     {}, as 8080 is busy", okfs.port)),
        "{}",
        okfs.said
    );
    assert_eq!(status(&okfs, "localhost"), 200);
}

#[test]
fn a_busy_port_that_was_asked_for_is_never_traded_for_another() {
    let held = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = held.local_addr().unwrap().port().to_string();
    let tmp = TempDir::new().unwrap();
    let (ended, error) = run(&["--no-open", "--port", &port, tmp.path().to_str().unwrap()]);
    assert!(!ended.success());
    assert!(error.contains(&format!("cannot listen on 127.0.0.1:{port}")), "{error}");
    assert!(error.contains("--port 0 for any free one"), "{error}");
}

#[test]
fn localhost_is_an_address_to_listen_on() {
    let (_tmp, okfs) = site(&["--bind", "localhost"]);
    assert!(okfs.said.contains("http://127.0.0.1:"), "{}", okfs.said);
    assert_eq!(status(&okfs, "localhost"), 200);

    let (ended, error) = run(&["--no-open", "--bind", "files.example.test", "."]);
    assert!(!ended.success());
    assert!(error.contains("not an IP address"), "{error}");
}

#[cfg(unix)]
#[test]
fn sigterm_stops_okfs_as_ctrl_c_does_even_with_a_page_open() {
    for signal in ["TERM", "INT"] {
        let (_tmp, mut okfs) = site(&[]);
        // An open page holds a stream of changes that never ends by itself.
        let mut stream = TcpStream::connect(("127.0.0.1", okfs.port)).unwrap();
        write!(stream, "GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
        let mut first = [0; 12];
        stream.read_exact(&mut first).unwrap();
        assert_eq!(&first, b"HTTP/1.1 200");

        let pid = okfs.child.id().to_string();
        assert!(
            Command::new("kill")
                .args(["-s", signal, &pid])
                .status()
                .unwrap()
                .success()
        );
        let status = ended(&mut okfs.child, Duration::from_secs(5)).expect("okfs stopped");
        assert!(status.success(), "SIG{signal}: {status}");
    }
}

#[test]
fn completions_and_the_manual_page_are_printed_for_packages() {
    for shell in ["bash", "zsh", "fish", "elvish", "powershell"] {
        let output = Command::new(env!("CARGO_BIN_EXE_okfs"))
            .args(["completions", shell])
            .output()
            .unwrap();
        assert!(output.status.success(), "{shell}");
        let text = String::from_utf8_lossy(&output.stdout);
        assert!(
            text.contains("okfs") && text.contains("allow-delete"),
            "{shell}: {text}"
        );
    }
    let output = Command::new(env!("CARGO_BIN_EXE_okfs"))
        .arg("manpage")
        .output()
        .unwrap();
    assert!(output.status.success());
    let page = String::from_utf8_lossy(&output.stdout);
    assert!(page.starts_with(".ie") || page.contains(".TH okfs 1"), "{page}");
    assert!(page.contains("allow\\-delete"), "{page}");

    let (ended, error) = run(&["completions", "tcsh"]);
    assert!(!ended.success());
    assert!(error.contains("invalid value 'tcsh'"), "{error}");
}
