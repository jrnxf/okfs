//! The okfs program itself, started the way a person or a service starts it.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tempfile::TempDir;
use tokio_rustls::rustls::crypto::ring;
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName};
use tokio_rustls::rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};

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
    ask_over(None, port, host, path, headers)
}

/// `ask`, over https when there is a certificate, trusting it alone.
fn ask_over(cert: Option<&Cert>, port: u16, host: &str, path: &str, headers: &str) -> (u16, String) {
    let tcp = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut stream: Box<dyn ReadWrite> = match cert {
        Some(cert) => Box::new(StreamOwned::new(cert.client(), tcp)),
        None => Box::new(tcp),
    };
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

trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

/// A certificate for 127.0.0.1 and localhost, made for one test, in the files okfs reads it from.
struct Cert {
    _dir: TempDir,
    der: CertificateDer<'static>,
    cert: PathBuf,
    key: PathBuf,
}

impl Cert {
    fn new() -> Self {
        let made = rcgen::generate_simple_self_signed(["127.0.0.1".to_owned(), "localhost".to_owned()]).unwrap();
        let dir = TempDir::new().unwrap();
        let (cert, key) = (dir.path().join("cert.pem"), dir.path().join("key.pem"));
        fs::write(&cert, made.cert.pem()).unwrap();
        fs::write(&key, made.signing_key.serialize_pem()).unwrap();
        Self {
            _dir: dir,
            der: made.cert.der().clone(),
            cert,
            key,
        }
    }

    /// The flags that serve with it.
    fn args(&self) -> [&str; 4] {
        [
            "--tls-cert",
            self.cert.to_str().unwrap(),
            "--tls-key",
            self.key.to_str().unwrap(),
        ]
    }

    /// A client's side of a connection to 127.0.0.1 that trusts this certificate and no other.
    fn client(&self) -> ClientConnection {
        let mut roots = RootCertStore::empty();
        roots.add(self.der.clone()).unwrap();
        let config = ClientConfig::builder_with_provider(Arc::new(ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let name = ServerName::try_from("127.0.0.1").unwrap();
        ClientConnection::new(Arc::new(config), name).unwrap()
    }
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

/// okfs in a terminal of its own, through `script`, as it opens the browser only from a terminal.
/// The browser is a script that writes down what it was started with. Stopped when dropped.
#[cfg(target_os = "linux")]
struct InTerminal {
    child: Child,
    /// What okfs printed, as it prints it.
    said: std::sync::mpsc::Receiver<String>,
}

#[cfg(target_os = "linux")]
impl Drop for InTerminal {
    fn drop(&mut self) {
        // okfs goes with its terminal.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The browser okfs opens is started with a command line that every account on the machine can
/// read, so it gets a code that works once, never the key.
#[cfg(target_os = "linux")]
#[test]
fn the_browser_okfs_opens_gets_a_one_time_code_and_never_the_key() {
    opens_the_browser_with_a_one_time_code(None);
}

/// And over https, the code it gets opens an https address.
#[cfg(target_os = "linux")]
#[test]
fn with_tls_the_browser_okfs_opens_gets_a_one_time_code_over_https() {
    opens_the_browser_with_a_one_time_code(Some(&Cert::new()));
}

#[cfg(target_os = "linux")]
fn opens_the_browser_with_a_one_time_code(cert: Option<&Cert>) {
    use std::os::unix::fs::PermissionsExt;

    let tmp = TempDir::new().unwrap();
    let served = tmp.path().join("served");
    fs::create_dir_all(served.join("docs")).unwrap();
    fs::write(served.join("docs/note.txt"), "note").unwrap();
    let opened = tmp.path().join("opened");
    let browser = tmp.path().join("browser");
    fs::write(
        &browser,
        format!("#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{}'\n", opened.display()),
    )
    .unwrap();
    fs::set_permissions(&browser, fs::Permissions::from_mode(0o755)).unwrap();
    let tls = cert
        .map(|cert| format!("'{}' ", cert.args().join("' '")))
        .unwrap_or_default();
    let okfs = format!(
        "'{}' --bind 127.0.0.1 --key --port 0 {tls}'{}'",
        env!("CARGO_BIN_EXE_okfs"),
        served.display()
    );
    let mut child = Command::new("script")
        .args(["-qefc", &okfs, "/dev/null"])
        .env("BROWSER", &browser)
        .env("XDG_CACHE_HOME", tmp.path().join("cache"))
        .env_remove("SSH_CONNECTION")
        .env_remove("SSH_TTY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("script, from util-linux, runs okfs in a terminal");
    let lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let (send, said) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in lines.map_while(Result::ok) {
            let _ = send.send(line);
        }
    });
    let okfs = InTerminal { child, said };

    let link = loop {
        let line = okfs
            .said
            .recv_timeout(Duration::from_secs(10))
            .expect("okfs printed its address");
        if let Some(link) = line.trim().strip_prefix("at") {
            break link.trim().to_owned();
        }
    };
    // The link printed for people is unchanged: it carries the key.
    let scheme = if cert.is_some() { "https" } else { "http" };
    assert!(link.starts_with(&format!("{scheme}://")), "{link}");
    let (at, key) = link.split_once("/?key=").expect("the printed link carries the key");
    let port: u16 = at.rsplit(':').next().unwrap().parse().unwrap();

    let since = Instant::now();
    let started = loop {
        if let Ok(started) = fs::read_to_string(&opened) {
            break started;
        }
        assert!(
            since.elapsed() < Duration::from_secs(10),
            "okfs never opened the browser"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(
        !started.contains(key),
        "the browser was started with the key: {started}"
    );
    let code = started
        .trim()
        .strip_prefix(&format!("{scheme}://127.0.0.1:{port}/?once="))
        .unwrap_or_else(|| panic!("the browser was started with no one-time code: {started}"));
    assert_eq!(code.len(), key.len());

    let host = format!("127.0.0.1:{port}");
    let navigate = "Sec-Fetch-Mode: navigate\r\n";
    let (status, answer) = ask_over(cert, port, &host, &format!("/?once={code}"), navigate);
    assert_eq!(status, 200, "{answer}");
    assert!(
        answer.contains(&format!("set-cookie: okfs-key-{port}={key};")),
        "{answer}"
    );
    // Over https the browser keeps the cookie to https.
    assert_eq!(answer.contains("; Secure\r\n"), cert.is_some(), "{answer}");
    // Spent: whoever reads the browser's command line from now on finds a code that opens nothing.
    let (status, answer) = ask_over(cert, port, &host, &format!("/?once={code}"), navigate);
    assert_eq!(status, 401, "{answer}");
    assert!(!answer.contains(key), "{answer}");
    assert_eq!(
        ask_over(cert, port, &host, &format!("/api/list?path=docs&once={code}"), "").0,
        401
    );
    // The key itself still opens it.
    assert_eq!(
        ask_over(cert, port, &host, &format!("/api/list?path=docs&key={key}"), "").0,
        200
    );
}

#[test]
fn with_a_certificate_okfs_serves_https_alone_with_the_key_and_the_host_check() {
    let cert = Cert::new();
    let (_tmp, okfs) = site(&[&["--bind", "0.0.0.0"][..], &cert.args()].concat());
    let (port, key) = (okfs.port, okfs.key.clone().expect("a key in the address"));
    let links: Vec<&str> = okfs.said.lines().filter(|line| line.contains("://")).collect();
    assert!(
        !links.is_empty()
            && links
                .iter()
                .all(|line| line.contains(" https://") && line.ends_with(&format!("/?key={key}"))),
        "{}",
        okfs.said
    );

    let host = format!("192.168.1.20:{port}");
    let (status, answer) = ask_over(Some(&cert), port, &host, "/raw/docs/note.txt", "");
    assert_eq!(status, 401, "{answer}");
    let (status, answer) = ask_over(Some(&cert), port, &host, &format!("/raw/docs/note.txt?key={key}"), "");
    assert_eq!(status, 200, "{answer}");
    assert!(answer.ends_with("\r\n\r\nnote"), "{answer}");
    let cookie = format!("Cookie: okfs-key-{port}={key}\r\n");
    assert_eq!(ask_over(Some(&cert), port, &host, "/raw/docs/note.txt", &cookie).0, 200);
    // A browser trades the key in its address for a cookie it keeps to https.
    let navigate = "Sec-Fetch-Mode: navigate\r\n";
    let (status, answer) = ask_over(Some(&cert), port, &host, &format!("/?key={key}"), navigate);
    assert_eq!(status, 200, "{answer}");
    assert!(
        answer.contains(&format!(
            "set-cookie: okfs-key-{port}={key}; Path=/; HttpOnly; SameSite=Strict; Secure\r\n"
        )),
        "{answer}"
    );
    assert_eq!(
        ask_over(
            Some(&cert),
            port,
            "evil.example",
            &format!("/raw/docs/note.txt?key={key}"),
            ""
        )
        .0,
        403
    );

    // Plain http gets no answer at all, so neither the key nor a file ever crosses in the clear.
    let mut plain = TcpStream::connect(("127.0.0.1", port)).unwrap();
    plain.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write!(
        plain,
        "GET /raw/docs/note.txt?key={key} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut answer = Vec::new();
    let _ = plain.read_to_end(&mut answer);
    assert!(!answer.starts_with(b"HTTP/"), "{}", String::from_utf8_lossy(&answer));
    // And okfs goes on serving after it.
    assert_eq!(
        ask_over(
            Some(&cert),
            port,
            "localhost",
            &format!("/api/list?path=docs&key={key}"),
            ""
        )
        .0,
        200
    );
}

#[test]
fn a_certificate_needs_its_key_and_a_key_its_certificate() {
    let cert = Cert::new();
    let (cert_path, key_path) = (cert.cert.to_str().unwrap(), cert.key.to_str().unwrap());
    for (given, missing) in [
        (["--tls-cert", cert_path], "--tls-key"),
        (["--tls-key", key_path], "--tls-cert"),
    ] {
        let (ended, error) = run(&[&["--no-open"][..], &given, &["."]].concat());
        assert!(!ended.success(), "{given:?}");
        assert!(
            error.contains("required arguments were not provided"),
            "{given:?}: {error}"
        );
        assert!(error.contains(missing), "{given:?}: {error}");
    }

    let other = Cert::new();
    let (ended, error) = run(&[
        "--no-open",
        "--tls-cert",
        cert_path,
        "--tls-key",
        other.key.to_str().unwrap(),
        ".",
    ]);
    assert!(!ended.success());
    assert!(error.contains("cannot serve with --tls-cert"), "{error}");

    let (ended, error) = run(&[
        "--no-open",
        "--tls-cert",
        "/nowhere/cert.pem",
        "--tls-key",
        key_path,
        ".",
    ]);
    assert!(!ended.success());
    assert!(error.contains("cannot read --tls-cert /nowhere/cert.pem"), "{error}");

    let (ended, error) = run(&["--no-open", "--tls-cert", key_path, "--tls-key", key_path, "."]);
    assert!(!ended.success());
    assert!(error.contains("holds no certificate"), "{error}");
}
