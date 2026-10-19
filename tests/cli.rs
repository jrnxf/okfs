//! The okfs program itself, started the way a person or a service starts it.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};

use tempfile::TempDir;

/// A running okfs, stopped when dropped.
struct Running {
    child: Child,
    port: u16,
    /// What it printed before the address, and the address line itself.
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
    let mut child = Command::new(env!("CARGO_BIN_EXE_okfs"))
        .args(["--port", "0", "--no-open"])
        .args(args)
        .arg(served)
        .env("XDG_CACHE_HOME", cache)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut said = String::new();
    let port = loop {
        let line = lines.next().expect("okfs printed its address").unwrap();
        said.push_str(&line);
        said.push('\n');
        if let Some(link) = line.trim_start().strip_prefix("at") {
            let port = link.trim().trim_end_matches('/').rsplit(':').next().unwrap();
            break port.parse().unwrap();
        }
    };
    // What it prints after the address is read so it never waits on a full pipe.
    std::thread::spawn(move || lines.for_each(drop));
    Running { child, port, said }
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

/// The status okfs answers a listing with, asked over the loopback address with this Host.
fn status(port: u16, host: &str) -> u16 {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        stream,
        "GET /api/list?path=docs HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    answer.split(' ').nth(1).unwrap().parse().unwrap()
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
            assert_eq!(status(port, &host), 200, "--bind {bind}, Host: {host}");
        }
        for host in [
            "evil.example",
            "rebound.attacker.test:8080",
            "files.example.test.evil.example",
        ] {
            assert_eq!(status(port, host), 403, "--bind {bind}, Host: {host}");
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
        assert_eq!(status(port, &host), 200, "Host: {host}");
    }
    assert_eq!(status(port, "my-laptop.local:8080"), 403);
}

#[test]
fn a_rescan_is_said_at_start_and_a_span_that_is_not_one_is_refused() {
    let (_tmp, okfs) = site(&["--rescan", "6h"]);
    assert!(okfs.said.contains("rescan   every 6h"), "{}", okfs.said);
    assert_eq!(status(okfs.port, "localhost"), 200);

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
