//! Behavior that can break without anyone noticing: the safety rules, deleting, ranges,
//! listings, bounded inputs and the theme gate. Each test drives the real router.

use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, Response, StatusCode, header};
use http_body_util::BodyExt;
use okfs::index::Index;
use okfs::paths::Root;
use okfs::server::{App, Options, ThemeChoice, router};
use serde_json::Value;
use tempfile::TempDir;
use tower::ServiceExt;

const SECRET: &str = "TOP SECRET";

/// A served folder with a neighbour it must never reach.
struct Site {
    _tmp: TempDir,
    served: PathBuf,
    outside: PathBuf,
}

impl Site {
    fn new() -> Self {
        let tmp = TempDir::new().unwrap();
        let top = tmp.path().canonicalize().unwrap();
        let (served, outside) = (top.join("served"), top.join("outside"));
        fs::create_dir_all(served.join("sub/deep")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(served.join("a.txt"), "0123456789abcdefghij").unwrap();
        fs::write(served.join("file10.txt"), "ten").unwrap();
        fs::write(served.join("file2.txt"), "two").unwrap();
        fs::write(served.join("sub/b.txt"), "inside").unwrap();
        fs::write(served.join("sub/deep/c.rs"), "fn main() {}\n").unwrap();
        fs::write(served.join(".hidden"), SECRET).unwrap();
        fs::write(outside.join("secret.txt"), SECRET).unwrap();
        fs::write(outside.join("page.html"), SECRET).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(outside.join("secret.txt"), served.join("link-out.txt")).unwrap();
            symlink(&outside, served.join("link-out-dir")).unwrap();
            symlink(served.join("sub/b.txt"), served.join("link-in.txt")).unwrap();
        }
        Self {
            _tmp: tmp,
            served,
            outside,
        }
    }

    fn app(&self, options: Options) -> axum::Router {
        self.serving(false, options)
    }

    /// `hidden` is the `--hidden` flag: dotfiles are shown and served.
    fn serving(&self, hidden: bool, options: Options) -> axum::Router {
        let root = Root::new(&self.served, hidden).unwrap();
        let index = Index::new(root.clone());
        index.build();
        router(App::new(root, index, options).unwrap())
    }

    fn router(&self) -> axum::Router {
        self.app(Options::default())
    }

    /// With deleting switched on.
    fn deleting(&self) -> axum::Router {
        self.app(Options {
            allow_delete: true,
            ..Options::default()
        })
    }
}

/// Header names and values to put on a request.
type Headers<'a> = &'a [(&'a str, &'a str)];

/// The address the page is opened at in these tests.
const HOME: &str = "localhost:8080";

/// A delete as the page sends it: its own origin, and the header a form cannot add.
/// `None` when the path cannot be written as an address at all.
fn page_delete(path: &str) -> Option<Request<Body>> {
    Request::delete(format!("/api/entry?path={path}"))
        .header(header::HOST, HOME)
        .header(header::ORIGIN, format!("http://{HOME}"))
        .header("x-okfs", "delete")
        .body(Body::empty())
        .ok()
}

async fn delete(app: &axum::Router, path: &str) -> StatusCode {
    send(app, page_delete(path).unwrap()).await.0.status()
}

/// The reason a refused delete gives, as the page shows it.
async fn refusal(app: &axum::Router, request: Request<Body>) -> (StatusCode, String) {
    let (response, body) = send(app, request).await;
    let body: Value = serde_json::from_slice(&body).unwrap();
    (response.status(), body["error"].as_str().unwrap().to_owned())
}

/// The directives of the policy a page was sent with.
fn page_policy(response: &Response<()>) -> Vec<String> {
    let policy = response.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
    policy.split(';').map(|directive| directive.trim().to_owned()).collect()
}

async fn send(app: &axum::Router, request: Request<Body>) -> (Response<()>, Vec<u8>) {
    let response = app.clone().oneshot(request).await.unwrap();
    let (parts, body) = response.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes().to_vec();
    (Response::from_parts(parts, ()), bytes)
}

async fn get(app: &axum::Router, uri: &str) -> (Response<()>, Vec<u8>) {
    send(app, Request::get(uri).body(Body::empty()).unwrap()).await
}

async fn json(app: &axum::Router, uri: &str) -> Value {
    let (response, body) = get(app, uri).await;
    assert_eq!(response.status(), StatusCode::OK, "{uri}");
    serde_json::from_slice(&body).unwrap()
}

fn names(listing: &Value) -> Vec<&str> {
    listing["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["n"].as_str().unwrap())
        .collect()
}

/// Every file under a folder with its contents, to prove nothing changed.
fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    let mut todo = vec![dir.to_owned()];
    while let Some(dir) = todo.pop() {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                todo.push(path);
            } else {
                let bytes = fs::read(&path).unwrap_or_default();
                out.push((path, bytes));
            }
        }
    }
    out.sort();
    out
}

#[tokio::test]
async fn no_path_leaves_the_served_folder() {
    let site = Site::new();
    let app = site.router();
    let escapes = [
        "../outside/secret.txt",
        "%2e%2e/outside/secret.txt",
        "%2E%2E%2Foutside%2Fsecret.txt",
        "..%2foutside%2fsecret.txt",
        "sub/../../outside/secret.txt",
        "sub/..%2f..%2foutside/secret.txt",
        "sub/%2e%2e/%2e%2e/outside/secret.txt",
        "./../outside/secret.txt",
        "..%5coutside%5csecret.txt",
        "%252e%252e/outside/secret.txt",
        "..%00/outside/secret.txt",
        "link-out.txt",
        "link-out-dir/secret.txt",
        "link-out-dir/page.html",
        ".hidden",
    ];
    let absolute = site.outside.join("secret.txt");
    let absolute = absolute.to_str().unwrap();
    let encoded_absolute = absolute.replace('/', "%2F");
    let escapes = escapes.into_iter().chain([absolute, encoded_absolute.as_str()]);

    for escape in escapes {
        let folder = escape.rsplit_once('/').map_or("..", |(dir, _)| dir);
        let tries = [
            format!("/raw/{escape}"),
            format!("/api/preview?path={escape}"),
            format!("/api/thumb?path={escape}"),
            format!("/api/archive?path={escape}"),
            format!("/api/list?path={escape}"),
            format!("/api/list?path={folder}"),
            format!("/zip/{folder}"),
            format!("/{escape}"),
            format!("/-/{escape}"),
        ];
        for uri in tries {
            let Ok(request) = Request::get(&uri).body(Body::empty()) else {
                continue;
            };
            let (response, body) = send(&app, request).await;
            let text = String::from_utf8_lossy(&body);
            assert!(!text.contains(SECRET), "{uri} leaked the file outside");
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn links_that_stay_inside_work_and_links_that_leave_are_not_listed() {
    let site = Site::new();
    let app = site.router();
    let (response, body) = get(&app, "/raw/link-in.txt").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body, b"inside");

    let listing = json(&app, "/api/list?path=").await;
    let names = names(&listing);
    assert!(names.contains(&"link-in.txt"));
    assert!(!names.contains(&"link-out.txt"));
    assert!(!names.contains(&"link-out-dir"));
    assert!(!names.contains(&".hidden"));

    let found = json(&app, "/api/search?q=secret").await;
    assert_eq!(found["total"], 0, "the index reached outside: {found}");
    let found = json(&app, "/api/search?q=hidden").await;
    assert_eq!(found["total"], 0, "the index holds a dotfile: {found}");
}

#[tokio::test]
async fn nothing_can_be_written() {
    let site = Site::new();
    let app = site.router();
    let before = snapshot(&site.served);
    let targets = [
        "/",
        "/a.txt",
        "/new.txt",
        "/sub/",
        "/raw/a.txt",
        "/raw/new.txt",
        "/api/list?path=",
        "/api/upload",
        "/api/preview?path=a.txt",
        "/zip/",
        "/theme.css",
        "/assets/main.js",
        "/-/a.txt",
    ];
    for method in ["POST", "PUT", "DELETE", "PATCH", "MKCOL", "MOVE", "COPY", "PROPPATCH"] {
        for target in targets {
            let request = Request::builder()
                .method(method)
                .uri(target)
                .body(Body::from("overwritten"))
                .unwrap();
            let (response, _) = send(&app, request).await;
            assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED, "{method} {target}");
        }
    }
    assert_eq!(snapshot(&site.served), before);
}

#[tokio::test]
async fn ranges_are_honoured() {
    let site = Site::new();
    let app = site.router();
    let ranged = |range: &'static str| {
        Request::get("/raw/a.txt")
            .header(header::RANGE, range)
            .body(Body::empty())
            .unwrap()
    };

    let (whole, body) = get(&app, "/raw/a.txt").await;
    assert_eq!(whole.status(), StatusCode::OK);
    assert_eq!(body, b"0123456789abcdefghij");
    assert_eq!(whole.headers()[header::ACCEPT_RANGES], "bytes");
    assert_eq!(whole.headers()[header::CONTENT_LENGTH], "20");
    let etag = whole.headers()[header::ETAG].clone();
    let modified = whole.headers()[header::LAST_MODIFIED].clone();

    for (range, status, content_range, expected) in [
        ("bytes=0-4", StatusCode::PARTIAL_CONTENT, "bytes 0-4/20", "01234"),
        ("bytes=10-", StatusCode::PARTIAL_CONTENT, "bytes 10-19/20", "abcdefghij"),
        ("bytes=-3", StatusCode::PARTIAL_CONTENT, "bytes 17-19/20", "hij"),
        ("bytes=18-999", StatusCode::PARTIAL_CONTENT, "bytes 18-19/20", "ij"),
        ("bytes=20-", StatusCode::RANGE_NOT_SATISFIABLE, "bytes */20", ""),
    ] {
        let (response, body) = send(&app, ranged(range)).await;
        assert_eq!(response.status(), status, "{range}");
        assert_eq!(response.headers()[header::CONTENT_RANGE], content_range, "{range}");
        assert_eq!(String::from_utf8(body).unwrap(), expected, "{range}");
    }

    // A range for a file that changed since the reader got its part is answered in full.
    let stale = Request::get("/raw/a.txt")
        .header(header::RANGE, "bytes=0-4")
        .header(header::IF_RANGE, "\"stale\"")
        .body(Body::empty())
        .unwrap();
    let (response, body) = send(&app, stale).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body.len(), 20);
    let current = Request::get("/raw/a.txt")
        .header(header::RANGE, "bytes=0-4")
        .header(header::IF_RANGE, &etag)
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(&app, current).await.0.status(), StatusCode::PARTIAL_CONTENT);

    for (name, value) in [(header::IF_NONE_MATCH, &etag), (header::IF_MODIFIED_SINCE, &modified)] {
        let request = Request::get("/raw/a.txt")
            .header(name, value)
            .body(Body::empty())
            .unwrap();
        let (response, body) = send(&app, request).await;
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert!(body.is_empty());
    }
}

#[tokio::test]
async fn a_folder_is_listed_in_reading_order_with_what_the_page_needs() {
    let site = Site::new();
    fs::write(
        site.served.join("sub/README.md"),
        "# Notes\n\n<script>alert(1)</script>\n\n![x](deep/x.png)",
    )
    .unwrap();
    let app = site.router();

    let listing = json(&app, "/api/list?path=").await;
    let names = names(&listing);
    let order: Vec<&str> = names
        .iter()
        .copied()
        .filter(|name| name.starts_with("file") || *name == "a.txt")
        .collect();
    assert_eq!(order, ["a.txt", "file2.txt", "file10.txt"]);
    let entry = |name: &str| {
        listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["n"] == name)
            .unwrap()
            .clone()
    };
    assert_eq!(entry("a.txt")["s"], 20);
    assert!(entry("a.txt")["m"].as_i64().unwrap() > 1_600_000_000);
    assert!(entry("a.txt").get("d").is_none());
    assert_eq!(entry("sub")["d"], true);
    assert_eq!(entry("sub")["c"], 3);
    assert!(listing["readme"].is_null());

    let sub = json(&app, "/api/list?path=sub").await;
    assert_eq!(sub["path"], "sub");
    let readme = sub["readme"]["html"].as_str().unwrap();
    assert!(readme.contains("<h1>Notes</h1>"));
    assert!(!readme.contains("<script"));
    assert!(readme.contains("src=\"/raw/sub/deep/x.png\""));

    let first = json(&app, "/api/list?path=&limit=1").await;
    assert_eq!(first["entries"].as_array().unwrap().len(), 1);
    assert_eq!(first["entries"][0]["n"], "sub");
    assert_eq!(first["total"], listing["total"]);

    assert_eq!(
        get(&app, "/api/list?path=a.txt").await.0.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(get(&app, "/api/list?path=nope").await.0.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn served_pages_are_sandboxed_and_nothing_is_sniffed() {
    let site = Site::new();
    fs::write(site.served.join("page.html"), "<script>parent.document</script>").unwrap();
    fs::write(
        site.served.join("drawing.svg"),
        "<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>",
    )
    .unwrap();
    let app = site.router();
    for uri in ["/raw/page.html", "/raw/drawing.svg"] {
        let (response, _) = get(&app, uri).await;
        let policy = response.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(policy.starts_with("sandbox"), "{uri}: {policy}");
        assert!(!policy.contains("allow-same-origin"), "{uri}: {policy}");
        assert!(!policy.contains("allow-top-navigation"), "{uri}: {policy}");
    }
    for uri in ["/raw/a.txt", "/raw/page.html", "/api/list?path=", "/"] {
        let (response, _) = get(&app, uri).await;
        assert_eq!(response.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff", "{uri}");
        assert!(
            !response.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            "{uri}"
        );
    }
    let (page, _) = get(&app, "/").await;
    let policy = page.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
    assert!(
        policy.contains("script-src 'self'") && !policy.contains("unsafe"),
        "{policy}"
    );
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let image = image::RgbImage::from_pixel(width, height, image::Rgb([200, 80, 30]));
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
        .unwrap();
    bytes
}

/// The checksum PNG puts after each chunk.
fn crc32(bytes: &[u8]) -> u32 {
    !bytes.iter().fold(!0u32, |crc, byte| {
        (0..8).fold(crc ^ u32::from(*byte), |crc, _| {
            (crc >> 1) ^ (0xedb8_8320 & (!(crc & 1)).wrapping_add(1))
        })
    })
}

/// A JPEG whose EXIF block says it must be turned a quarter to be upright.
fn sideways_jpeg(width: u32, height: u32) -> Vec<u8> {
    let image = image::RgbImage::from_pixel(width, height, image::Rgb([30, 80, 200]));
    let mut jpeg = Vec::new();
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
        .unwrap();
    let mut exif = b"Exif\0\0II*\0".to_vec();
    exif.extend(8u32.to_le_bytes()); // where the first directory starts
    exif.extend(1u16.to_le_bytes()); // one entry
    exif.extend(0x0112u16.to_le_bytes()); // orientation
    exif.extend(3u16.to_le_bytes()); // a short
    exif.extend(1u32.to_le_bytes());
    exif.extend(6u32.to_le_bytes()); // rotate a quarter clockwise
    exif.extend(0u32.to_le_bytes()); // no further directory
    let mut out = jpeg[..2].to_vec();
    out.extend([0xff, 0xe1]);
    out.extend(((exif.len() + 2) as u16).to_be_bytes());
    out.extend(exif);
    out.extend(&jpeg[2..]);
    out
}

#[tokio::test]
async fn thumbnails_shrink_turn_upright_and_refuse_oversized_input() {
    let site = Site::new();
    fs::write(site.served.join("wide.png"), png(800, 400)).unwrap();
    fs::write(site.served.join("sideways.jpg"), sideways_jpeg(60, 30)).unwrap();
    // A header that claims a picture far past the limit, with almost no data behind it.
    let mut bomb = png(1, 1);
    bomb[16..20].copy_from_slice(&60_000u32.to_be_bytes());
    bomb[20..24].copy_from_slice(&60_000u32.to_be_bytes());
    let checksum = crc32(&bomb[12..29]);
    bomb[29..33].copy_from_slice(&checksum.to_be_bytes());
    fs::write(site.served.join("bomb.png"), bomb).unwrap();
    // A sparse file: huge on paper, nothing on disk.
    fs::File::create(site.served.join("huge.png"))
        .unwrap()
        .set_len(okfs::thumb::MAX_FILE + 1)
        .unwrap();

    // A cache folder inside the served folder must be ignored: nothing is written there.
    let cache = site.served.join("cache/thumbs");
    let app = site.app(Options {
        cache: Some(cache.clone()),
        ..Options::default()
    });
    let before = snapshot(&site.served).len();

    let (response, body) = get(&app, "/api/thumb?path=wide.png&w=100").await;
    assert_eq!(response.status(), StatusCode::OK);
    let small = image::load_from_memory(&body).unwrap();
    assert_eq!((small.width(), small.height()), (320, 160));

    let (response, body) = get(&app, "/api/thumb?path=sideways.jpg&w=640").await;
    assert_eq!(response.status(), StatusCode::OK);
    let upright = image::load_from_memory(&body).unwrap();
    assert_eq!((upright.width(), upright.height()), (30, 60));

    for uri in ["/api/thumb?path=bomb.png", "/api/thumb?path=huge.png"] {
        assert_eq!(get(&app, uri).await.0.status(), StatusCode::PAYLOAD_TOO_LARGE, "{uri}");
    }
    assert_eq!(
        get(&app, "/api/thumb?path=a.txt").await.0.status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );

    assert!(!cache.exists());
    assert_eq!(snapshot(&site.served).len(), before);
}

#[tokio::test]
async fn thumbnails_are_cached_outside_the_served_folder() {
    let site = Site::new();
    fs::write(site.served.join("wide.png"), png(800, 400)).unwrap();
    let cache = site.outside.join("cache");
    let app = site.app(Options {
        cache: Some(cache.clone()),
        ..Options::default()
    });
    let (_, first) = get(&app, "/api/thumb?path=wide.png&w=160").await;
    assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
    let (_, second) = get(&app, "/api/thumb?path=wide.png&w=160").await;
    assert_eq!(first, second);
}

/// A one-page PDF, 200 by 300 points, with a black square on it.
fn pdf() -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R >>".to_owned(),
        "<< /Length 22 >>\nstream\n50 50 100 100 re\nf\nendstream".to_owned(),
    ];
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut starts = Vec::new();
    for (at, object) in objects.iter().enumerate() {
        starts.push(out.len());
        out.extend(format!("{} 0 obj\n{object}\nendobj\n", at + 1).bytes());
    }
    let table = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", starts.len() + 1).bytes());
    for start in starts {
        out.extend(format!("{start:010} 00000 n \n").bytes());
    }
    out.extend(format!("trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{table}\n%%EOF\n").bytes());
    out
}

/// PDFs are drawn by okfs started again as a process of its own.
fn drawing(cache: &Path) -> Options {
    Options {
        cache: Some(cache.to_owned()),
        drawer: Some(PathBuf::from(env!("CARGO_BIN_EXE_okfs"))),
        ..Options::default()
    }
}

#[cfg(feature = "pdf")]
#[tokio::test]
async fn the_first_page_of_a_pdf_is_drawn_once_and_kept_outside_the_served_folder() {
    let site = Site::new();
    fs::write(site.served.join("doc.pdf"), pdf()).unwrap();
    let cache = site.outside.join("cache");
    let app = site.app(drawing(&cache));
    let before = snapshot(&site.served).len();

    let (response, first) = get(&app, "/api/thumb?path=doc.pdf&w=600").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/jpeg");
    let page = image::load_from_memory(&first).unwrap().into_rgb8();
    assert_eq!((page.width(), page.height()), (640, 960));
    // The square is drawn, on white: the page is not a blank sheet.
    assert!(page.get_pixel(320, 480).0.iter().all(|part| *part < 40));
    assert!(page.get_pixel(40, 40).0.iter().all(|part| *part > 215));

    assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
    assert_eq!(snapshot(&site.served).len(), before);
    // The second answer is the kept one: the same bytes, with no program left to draw them.
    let kept = site.app(Options {
        drawer: Some(site.outside.join("no-such-program")),
        ..drawing(&cache)
    });
    assert_eq!(get(&kept, "/api/thumb?path=doc.pdf&w=600").await.1, first);
}

#[cfg(feature = "pdf")]
#[tokio::test]
async fn a_pdf_that_cannot_be_drawn_is_refused_and_the_server_goes_on() {
    let site = Site::new();
    fs::write(site.served.join("doc.pdf"), pdf()).unwrap();
    fs::write(site.served.join("junk.pdf"), b"%PDF-1.7\n\xff\xfe not a pdf at all").unwrap();
    let mut cut = pdf();
    cut.truncate(120);
    fs::write(site.served.join("cut.pdf"), cut).unwrap();
    fs::write(site.served.join("empty.pdf"), b"").unwrap();
    // A sparse file: huge on paper, nothing on disk.
    fs::File::create(site.served.join("huge.pdf"))
        .unwrap()
        .set_len(okfs::pdf::MAX_FILE + 1)
        .unwrap();
    let cache = site.outside.join("cache");
    let app = site.app(drawing(&cache));

    // No picture is an answer, not a fault: the page then shows the PDF as it did before.
    for name in ["junk.pdf", "cut.pdf", "empty.pdf", "huge.pdf"] {
        let (response, body) = get(&app, &format!("/api/thumb?path={name}")).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT, "{name}");
        assert!(body.is_empty(), "{name}");
    }
    // Nothing is kept for a file that was refused, and a good file is still drawn.
    assert_eq!(fs::read_dir(&cache).unwrap().count(), 0);
    assert_eq!(get(&app, "/api/thumb?path=doc.pdf").await.0.status(), StatusCode::OK);
    assert_eq!(get(&app, "/raw/junk.pdf").await.0.status(), StatusCode::OK);
}

#[cfg(all(unix, feature = "pdf"))]
#[tokio::test]
async fn drawing_a_pdf_is_given_up_when_it_takes_too_long() {
    use std::os::unix::fs::PermissionsExt;
    let site = Site::new();
    fs::write(site.served.join("doc.pdf"), pdf()).unwrap();
    // A program that never answers stands in for a PDF that never finishes drawing.
    let stuck = site.outside.join("stuck");
    let mark = site.outside.join("started");
    fs::write(
        &stuck,
        format!("#!/bin/sh\necho $$ > '{}'\nexec sleep 600\n", mark.display()),
    )
    .unwrap();
    fs::set_permissions(&stuck, fs::Permissions::from_mode(0o755)).unwrap();
    let app = site.app(Options {
        cache: Some(site.outside.join("cache")),
        drawer: Some(stuck),
        pdf_limit: std::time::Duration::from_millis(300),
        ..Options::default()
    });

    let asked = std::time::Instant::now();
    let (response, _) = get(&app, "/api/thumb?path=doc.pdf").await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(asked.elapsed() < std::time::Duration::from_secs(10));
    // The process was ended, not left running.
    let process = fs::read_to_string(&mark).unwrap();
    let gone = (0..100).any(|_| {
        std::thread::sleep(std::time::Duration::from_millis(20));
        let state = fs::read_to_string(format!("/proc/{}/stat", process.trim())).unwrap_or_default();
        // Gone, or ended and waiting to be collected.
        !Path::new("/proc/self").exists() || state.is_empty() || state.contains(") Z ")
    });
    assert!(gone, "the drawing process outlived its time limit");
    // It is not started a second time for the same file.
    fs::remove_file(&mark).unwrap();
    assert_eq!(
        get(&app, "/api/thumb?path=doc.pdf").await.0.status(),
        StatusCode::NO_CONTENT
    );
    assert!(!mark.exists());
}

#[tokio::test]
async fn a_pdf_outside_the_served_folder_is_never_drawn() {
    let site = Site::new();
    fs::write(site.outside.join("secret.pdf"), pdf()).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(site.outside.join("secret.pdf"), site.served.join("link-out.pdf")).unwrap();
    let cache = site.outside.join("cache");
    let app = site.app(drawing(&cache));
    for path in [
        "../outside/secret.pdf",
        "%2e%2e/outside/secret.pdf",
        "link-out.pdf",
        "link-out-dir/secret.pdf",
        "sub/../../outside/secret.pdf",
    ] {
        let (response, body) = get(&app, &format!("/api/thumb?path={path}")).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        assert!(image::load_from_memory(&body).is_err(), "{path}");
    }
    assert_eq!(fs::read_dir(&cache).map_or(0, Iterator::count), 0);
}

#[tokio::test]
async fn pdfs_get_no_picture_without_a_program_to_draw_them() {
    let site = Site::new();
    fs::write(site.served.join("doc.pdf"), pdf()).unwrap();
    let app = site.app(Options::default());
    assert_eq!(
        get(&app, "/api/thumb?path=doc.pdf").await.0.status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
}

#[tokio::test]
async fn text_previews_are_bounded() {
    let site = Site::new();
    fs::File::create(site.served.join("huge.log"))
        .unwrap()
        .set_len(okfs::render::MAX_TEXT + 1)
        .unwrap();
    fs::write(site.served.join("blob.bin"), [0u8, 159, 146, 150, 0, 1, 2]).unwrap();
    fs::write(site.served.join("table.csv"), "name,n\n\"a, b\",1\nc,2\n").unwrap();
    fs::write(site.served.join("data.json"), "{\"a\": [1, 2]}").unwrap();
    let app = site.router();

    let large = json(&app, "/api/preview?path=huge.log").await;
    assert_eq!(
        (large["kind"].as_str(), large["reason"].as_str()),
        (Some("none"), Some("large"))
    );
    let binary = json(&app, "/api/preview?path=blob.bin").await;
    assert_eq!(
        (binary["kind"].as_str(), binary["reason"].as_str()),
        (Some("none"), Some("binary"))
    );

    // A tile's cover reads the start of a file only, however large the file is.
    let head = json(&app, "/api/preview?path=huge.log&head=1").await;
    assert_eq!(head["kind"], "none");
    fs::write(site.served.join("long.txt"), "line\n".repeat(100_000)).unwrap();
    assert_eq!(json(&app, "/api/preview?path=long.txt&head=1").await["lines"], 16);

    let code = json(&app, "/api/preview?path=sub/deep/c.rs").await;
    assert_eq!(code["kind"], "code");
    assert!(code["html"].as_str().unwrap().contains("tk-k"));
    let table = json(&app, "/api/preview?path=table.csv").await;
    assert_eq!(table["head"], serde_json::json!(["name", "n"]));
    assert_eq!(table["rows"], serde_json::json!([["a, b", "1"], ["c", "2"]]));
    assert_eq!(table["numeric"], serde_json::json!([false, true]));
    assert_eq!(json(&app, "/api/preview?path=data.json").await["kind"], "json");
}

#[tokio::test]
async fn the_start_of_a_source_file_can_be_asked_for_alone() {
    let site = Site::new();
    let app = site.router();
    fs::write(site.served.join("long.rs"), "fn a() {}\n".repeat(200)).unwrap();
    fs::write(site.served.join("short.rs"), "fn a() {}\nfn b() {}\n").unwrap();

    // The first lines only, colored, with the count of all of them and a note that there is more.
    let start = json(&app, "/api/preview?path=long.rs&lines=80").await;
    assert_eq!(
        (start["kind"].as_str(), start["lines"].as_u64()),
        (Some("code"), Some(200))
    );
    assert_eq!(start["more"], true);
    let html = start["html"].as_str().unwrap();
    assert_eq!(html.matches("class=\"ln\"").count(), 80);
    assert!(html.contains("tk-k"));
    // Without the limit the whole file comes, and says nothing of more.
    let whole = json(&app, "/api/preview?path=long.rs").await;
    assert_eq!(whole["html"].as_str().unwrap().matches("class=\"ln\"").count(), 200);
    assert!(whole.get("more").is_none());

    // A file shorter than the limit is whole already.
    let short = json(&app, "/api/preview?path=short.rs&lines=80").await;
    assert_eq!(short["lines"], 2);
    assert!(short.get("more").is_none());
}

#[tokio::test]
async fn several_previews_come_in_one_answer_by_path() {
    let site = Site::new();
    let app = site.router();
    fs::write(site.served.join("long.rs"), "fn a() {}\n".repeat(200)).unwrap();
    fs::write(site.served.join("data.json"), "{\"a\": [1, 2]}").unwrap();

    let many = json(
        &app,
        "/api/previews?lines=80&p=long.rs&p=sub%2Fdeep%2Fc.rs&p=data.json&p=gone.rs&p=sub",
    )
    .await;
    let found = many.as_object().unwrap();
    // A missing file and a folder are left out; the rest are told by their paths.
    assert_eq!(
        found.keys().collect::<Vec<_>>(),
        ["data.json", "long.rs", "sub/deep/c.rs"]
    );
    assert_eq!(many["long.rs"]["more"], true);
    assert_eq!(many["long.rs"], json(&app, "/api/preview?path=long.rs&lines=80").await);
    assert_eq!(
        many["sub/deep/c.rs"],
        json(&app, "/api/preview?path=sub/deep/c.rs").await
    );
    assert_eq!(many["data.json"]["kind"], "json");

    // Nothing asked for, nothing sent; a path outside the served folder is left out like a missing one.
    assert_eq!(json(&app, "/api/previews").await, serde_json::json!({}));
    assert_eq!(
        json(&app, "/api/previews?p=..%2Foutside.txt").await,
        serde_json::json!({})
    );
}

#[tokio::test]
async fn a_theme_file_that_fails_the_checker_is_refused_with_the_reason() {
    let site = Site::new();
    let root = Root::new(&site.served, false).unwrap();
    let theme = site.outside.join("mine.css");
    let good = "/* @name Mine */\n:root { --accent: #2d6a4f; --radius: 3px; }\n:root[data-scheme=\"dark\"] {}\n";

    fs::write(&theme, good.replace("--radius: 3px", "--radius: 300px; display: none")).unwrap();
    let options = Options {
        theme: ThemeChoice::File(theme.clone()),
        ..Options::default()
    };
    let refused = App::new(root.clone(), Index::new(root.clone()), options.clone())
        .err()
        .unwrap();
    assert!(refused.contains("is refused"), "{refused}");
    assert!(refused.contains("--radius: 300px is out of bounds"), "{refused}");
    assert!(refused.contains("display is not a token"), "{refused}");

    fs::write(&theme, good).unwrap();
    let app = router(App::new(root.clone(), Index::new(root), options).unwrap());
    let (response, body) = get(&app, "/theme.css").await;
    assert_eq!(response.status(), StatusCode::OK);
    let css = String::from_utf8(body).unwrap();
    assert!(
        css.contains("--accent: #2d6a4f;") && css.contains("--radius: 3px;"),
        "{css}"
    );

    let (_, paper) = get(&app, "/assets/themes/paper.css").await;
    assert!(String::from_utf8(paper).unwrap().contains("--bg: #f5f0e6;"));
    assert_eq!(
        get(&app, "/assets/themes/nope.css").await.0.status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn a_folder_downloads_as_a_zip_of_what_is_shown() {
    let site = Site::new();
    let app = site.router();
    let (response, body) = get(&app, "/zip/").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/zip");
    let mut archive = zip::ZipArchive::new(Cursor::new(body.clone())).unwrap();
    let mut names: Vec<String> = archive.file_names().map(|name| name.unwrap().into_owned()).collect();
    names.sort();
    let mut expected = vec!["a.txt", "file10.txt", "file2.txt", "sub/b.txt", "sub/deep/c.rs"];
    if cfg!(unix) {
        expected.push("link-in.txt");
        expected.sort();
    }
    assert_eq!(names, expected);
    let mut text = String::new();
    archive.by_name("sub/b.txt").unwrap().read_to_string(&mut text).unwrap();
    assert_eq!(text, "inside");
    assert!(!String::from_utf8_lossy(&body).contains(SECRET));

    fs::write(site.served.join("packed.zip"), &body).unwrap();
    let listed = json(&app, "/api/archive?path=packed.zip").await;
    assert_eq!(listed["total"], expected.len());
    assert!(
        listed["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["name"] == "sub/b.txt" && e["size"] == 6)
    );
    assert_eq!(
        get(&app, "/api/archive?path=a.txt").await.0.status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
}

#[tokio::test]
async fn the_page_knows_what_its_address_points_at() {
    let site = Site::new();
    fs::create_dir_all(site.served.join("api")).unwrap();
    let app = site.router();
    let config = |html: &[u8]| -> Value {
        let html = String::from_utf8_lossy(html).into_owned();
        let start = html.find("id=\"okfs-config\">").unwrap() + "id=\"okfs-config\">".len();
        let end = start + html[start..].find("</script>").unwrap();
        serde_json::from_str(&html[start..end]).unwrap()
    };

    let (response, body) = get(&app, "/").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        config(&body)["target"],
        serde_json::json!({ "path": "", "kind": "dir" })
    );
    assert_eq!(config(&body)["themes"].as_array().unwrap().len(), 5);

    let (_, body) = get(&app, "/sub/b.txt").await;
    assert_eq!(
        config(&body)["target"],
        serde_json::json!({ "path": "sub/b.txt", "kind": "file" })
    );

    let (response, _) = get(&app, "/sub").await;
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(response.headers()[header::LOCATION], "/sub/");

    // A top-level folder named like one of the server's own routes is reached behind /-/.
    let (response, body) = get(&app, "/-/api/").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        config(&body)["target"],
        serde_json::json!({ "path": "api", "kind": "dir" })
    );

    let (response, body) = get(&app, "/nope/%3C%2Fscript%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(config(&body)["target"]["kind"], "missing");
    assert!(!String::from_utf8_lossy(&body).contains("<script>alert(1)"));
}

#[tokio::test]
async fn other_host_names_are_refused_on_a_loopback_address() {
    let site = Site::new();
    let app = site.app(Options {
        check_host: true,
        allow_hosts: vec!["files.example.test".to_owned()],
        ..Options::default()
    });
    let with_host = |host: &'static str| {
        Request::get("/api/list?path=")
            .header(header::HOST, host)
            .body(Body::empty())
            .unwrap()
    };
    for host in [
        "localhost:8080",
        "127.0.0.1:8080",
        "[::1]:8080",
        "files.example.test",
        "FILES.example.test:443",
    ] {
        assert_eq!(send(&app, with_host(host)).await.0.status(), StatusCode::OK, "{host}");
    }
    for host in ["evil.example", "localhost.evil.example:8080", "127.0.0.1.evil.example"] {
        let (response, body) = send(&app, with_host(host)).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{host}");
        assert!(String::from_utf8_lossy(&body).contains("--allow-host"));
    }
}

/// The next thing a stream of changes says, as its event name and its data. `None`
/// when it says nothing for a while.
async fn next_change(stream: &mut Body) -> Option<(String, Value)> {
    let wait = std::time::Duration::from_secs(2);
    loop {
        let frame = tokio::time::timeout(wait, stream.frame()).await.ok()??.unwrap();
        let text = String::from_utf8(frame.into_data().unwrap().to_vec()).unwrap();
        let field = |name: &str| text.lines().find_map(|line| line.strip_prefix(name));
        // A line that starts with a colon is a comment: it only keeps the stream open.
        if let (Some(event), Some(data)) = (field("event: "), field("data: ")) {
            return Some((event.to_owned(), serde_json::from_str(data).unwrap()));
        }
    }
}

async fn listen(app: &axum::Router) -> Body {
    let request = Request::get("/api/events").body(Body::empty()).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response.into_body()
}

#[tokio::test]
async fn the_stream_of_changes_is_guarded_and_sent_as_it_is() {
    let site = Site::new();
    let app = site.app(Options {
        check_host: true,
        ..Options::default()
    });
    let from = |host: &'static str| {
        Request::get("/api/events")
            .header(header::HOST, host)
            .header(header::ACCEPT_ENCODING, "gzip, br")
            .body(Body::empty())
            .unwrap()
    };
    let (response, body) = send(&app, from("evil.example")).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(String::from_utf8_lossy(&body).contains("--allow-host"));

    let response = app.clone().oneshot(from(HOME)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "text/event-stream");
    assert_eq!(response.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    // Packed, a change would wait in the packer for more to pack it with.
    assert!(!response.headers().contains_key(header::CONTENT_ENCODING));
    // The first line is there at once, so nothing on the way holds the answer back.
    let first = response.into_body().frame().await.unwrap().unwrap();
    assert!(first.into_data().unwrap().starts_with(b":"));

    // It only tells: no other method reaches it.
    for method in ["POST", "PUT", "DELETE"] {
        let request = Request::builder()
            .method(method)
            .uri("/api/events")
            .header(header::HOST, HOME)
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            send(&app, request).await.0.status(),
            StatusCode::METHOD_NOT_ALLOWED,
            "{method}"
        );
    }
}

#[tokio::test]
async fn an_open_page_is_told_of_what_changes_on_disk() {
    let site = Site::new();
    let root = Root::new(&site.served, false).unwrap();
    let index = Index::spawn(root.clone());
    let app = router(App::new(root, Arc::clone(&index), Options::default()).unwrap());
    for _ in 0..200 {
        if index.ready() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let mut stream = listen(&app).await;

    // What a listing does not show is written first, and is never told of.
    fs::write(site.served.join(".hidden"), "still secret").unwrap();
    fs::write(site.outside.join("secret.txt"), "still secret").unwrap();
    // A watcher may take a moment to start, so each change is made until it is heard.
    let mut heard = Vec::new();
    let mut until = async |make: &dyn Fn(usize), dir: &str, file: Option<&str>| {
        for turn in 0..20 {
            make(turn);
            while let Some((event, data)) = next_change(&mut stream).await {
                heard.push(data.to_string());
                assert!(event == "change" || event == "sync", "{event}: {data}");
                let named = |name| data["files"].as_array().unwrap().contains(&Value::from(name));
                if data["dir"] == dir && file.is_none_or(named) {
                    return;
                }
            }
        }
        panic!("the stream never told of {file:?} in {dir:?}");
    };

    let fresh = site.served.join("sub/fresh.txt");
    until(
        &|turn| fs::write(&fresh, format!("new {turn}")).unwrap(),
        "sub",
        Some("fresh.txt"),
    )
    .await;
    until(
        &|turn| fs::write(site.served.join("a.txt"), format!("rewritten {turn}")).unwrap(),
        "",
        Some("a.txt"),
    )
    .await;
    let moved = site.served.join("sub/moved.txt");
    until(&|_| drop(fs::rename(&fresh, &moved)), "sub", Some("moved.txt")).await;
    until(&|_| drop(fs::remove_file(&moved)), "sub", None).await;

    let all = heard.join("\n");
    assert!(
        !all.contains("hidden") && !all.contains("secret") && !all.contains("link-out"),
        "{all}"
    );
}

#[tokio::test]
async fn a_delete_is_told_to_every_open_page() {
    let site = Site::new();
    let app = site.deleting();
    let mut other_tab = listen(&app).await;
    assert_eq!(delete(&app, "sub/b.txt").await, StatusCode::NO_CONTENT);
    let (event, data) = next_change(&mut other_tab).await.unwrap();
    assert_eq!(
        (event.as_str(), data),
        ("change", serde_json::json!({ "dir": "sub", "files": [] }))
    );
    // A delete that is refused changes nothing, and tells nothing.
    assert_eq!(delete(&app, ".hidden").await, StatusCode::FORBIDDEN);
    assert_eq!(next_change(&mut other_tab).await, None);
}

#[cfg(unix)]
#[tokio::test]
async fn a_folder_reached_through_a_link_says_where_it_really_is() {
    use std::os::unix::fs::symlink;
    let site = Site::new();
    symlink(site.served.join("sub"), site.served.join("latest")).unwrap();
    let app = site.router();
    // Changes are told by the real place, so the page has to know it.
    assert_eq!(json(&app, "/api/list?path=latest/deep").await["real"], "sub/deep");
    assert_eq!(json(&app, "/api/list?path=sub/deep").await["real"], Value::Null);
}

#[tokio::test]
async fn search_finds_names_across_the_tree_and_follows_changes() {
    let site = Site::new();
    let root = Root::new(&site.served, false).unwrap();
    let index = Index::spawn(root.clone());
    let app = router(App::new(root, Arc::clone(&index), Options::default()).unwrap());
    let found = |query: &'static str| {
        let app = app.clone();
        async move { json(&app, &format!("/api/search?q={query}")).await }
    };
    let wait_for = |query: &'static str, want: usize| async move {
        for _ in 0..200 {
            let result = found(query).await;
            if result["ready"] == true && result["total"] == want {
                return result;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("the index never showed {want} matches for {query}");
    };

    let result = wait_for("c.rs", 1).await;
    assert_eq!(result["hits"][0]["path"], "sub/deep/c.rs");
    assert_eq!(result["hits"][0]["name"], true);
    assert_eq!(result["indexed"], if cfg!(unix) { 8 } else { 7 });

    fs::create_dir_all(site.served.join("fresh/inner")).unwrap();
    fs::write(site.served.join("fresh/inner/zebra.txt"), "new").unwrap();
    let result = wait_for("zebra", 1).await;
    assert_eq!(result["hits"][0]["path"], "fresh/inner/zebra.txt");

    fs::remove_dir_all(site.served.join("fresh")).unwrap();
    wait_for("zebra", 0).await;
}

/// Sets when a file or folder was last written, in seconds since the epoch.
fn written_at(path: impl AsRef<Path>, seconds: u64) {
    let time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds);
    let file = fs::File::open(path.as_ref()).unwrap();
    file.set_modified(time).unwrap();
}

/// The paths in an answer of `/api/recent`, newest first.
fn recent_paths(answer: &Value) -> Vec<&str> {
    answer["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn recent_lists_the_newest_files_across_folders_and_only_files_that_are_shown() {
    let site = Site::new();
    for (path, seconds) in [
        ("a.txt", 1000),
        ("file10.txt", 2000),
        ("file2.txt", 3000),
        ("sub/b.txt", 4000),
        ("sub/deep/c.rs", 5000),
        // Never shown without --hidden, and the target of a link that leaves the folder.
        (".hidden", 9000),
    ] {
        written_at(site.served.join(path), seconds);
    }
    written_at(site.outside.join("secret.txt"), 9500);
    // Folders are never listed however new they are.
    written_at(site.served.join("sub"), 99_000);
    written_at(site.served.join("sub/deep"), 99_000);
    let app = site.router();

    let answer = json(&app, "/api/recent").await;
    // The link to `sub/b.txt` is not listed: the file it leads to is, under its own name.
    let want = ["sub/deep/c.rs", "sub/b.txt", "file2.txt", "file10.txt", "a.txt"];
    assert_eq!(recent_paths(&answer), want);
    assert_eq!(answer["files"][0]["m"], 5000);
    assert_eq!(answer["files"].as_array().unwrap().last().unwrap()["m"], 1000);

    // The same order every time.
    for _ in 0..3 {
        assert_eq!(recent_paths(&json(&app, "/api/recent").await), want);
    }

    // With --hidden the dotfile shows. A file behind a link that leaves the folder still does not.
    let app = site.serving(true, Options::default());
    let answer = json(&app, "/api/recent").await;
    let shown = recent_paths(&answer);
    assert_eq!(shown[0], ".hidden");
    assert!(
        shown
            .iter()
            .all(|path| !path.contains("link-out") && !path.contains("secret"))
    );
    assert!(!String::from_utf8_lossy(&get(&app, "/api/recent").await.1).contains("TOP SECRET"));
}

#[tokio::test]
async fn recent_stops_at_the_eight_newest_files() {
    let site = Site::new();
    for path in ["a.txt", "file10.txt", "file2.txt", "sub/b.txt", "sub/deep/c.rs"] {
        written_at(site.served.join(path), 10);
    }
    let place = |n: u64| format!("{}/n{n:02}.txt", if n.is_multiple_of(2) { "sub" } else { "sub/deep" });
    for n in 0..12 {
        fs::write(site.served.join(place(n)), "new").unwrap();
        written_at(site.served.join(place(n)), 1000 + n);
    }
    let answer = json(&site.router(), "/api/recent").await;
    let want: Vec<String> = (4..12).rev().map(place).collect();
    assert_eq!(recent_paths(&answer), want);
}

#[tokio::test]
async fn files_with_one_time_come_in_path_order() {
    let site = Site::new();
    fs::create_dir_all(site.served.join("m/n")).unwrap();
    for path in ["zeta.txt", "m/n/x.txt", "m/y.txt", "alpha.txt"] {
        fs::write(site.served.join(path), "same").unwrap();
    }
    for path in ["a.txt", "file10.txt", "file2.txt", "sub/b.txt", "sub/deep/c.rs"] {
        written_at(site.served.join(path), 10);
    }
    for path in ["zeta.txt", "m/n/x.txt", "m/y.txt", "alpha.txt"] {
        written_at(site.served.join(path), 500);
    }
    let first = recent_paths(&json(&site.router(), "/api/recent").await).join(",");
    for _ in 0..3 {
        // A fresh index each time, so the order does not come from how the walk ran.
        let again = recent_paths(&json(&site.router(), "/api/recent").await).join(",");
        assert_eq!(again, first);
    }
    assert!(first.starts_with("alpha.txt,zeta.txt,m/y.txt,m/n/x.txt,"), "{first}");
}

#[tokio::test]
async fn a_rewritten_file_moves_to_the_top_and_a_removed_file_leaves() {
    let site = Site::new();
    for (path, seconds) in [
        ("a.txt", 1000),
        ("file10.txt", 2000),
        ("file2.txt", 3000),
        ("sub/b.txt", 4000),
        ("sub/deep/c.rs", 5000),
    ] {
        written_at(site.served.join(path), seconds);
    }
    let root = Root::new(&site.served, false).unwrap();
    let index = Index::spawn(root.clone());
    let app = router(App::new(root, Arc::clone(&index), Options::default()).unwrap());
    let wait_for_first = |want: &'static str| {
        let app = app.clone();
        async move {
            for _ in 0..200 {
                let answer = json(&app, "/api/recent").await;
                if recent_paths(&answer).first() == Some(&want) {
                    return answer;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            panic!("{want} never came first");
        }
    };
    wait_for_first("sub/deep/c.rs").await;

    // The same name and the same size: only its content and time change.
    fs::write(site.served.join("a.txt"), "9876543210zyxwvutsrq").unwrap();
    let answer = wait_for_first("a.txt").await;
    assert!(answer["files"][0]["m"].as_u64().unwrap() > 5000);

    // Times are in whole seconds, so what follows is dated ahead to come before the rewrite above.
    let ahead = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    // A file written by making a new one and renaming it over the old, as editors do.
    fs::write(site.served.join("tmp.swp"), "new").unwrap();
    written_at(site.served.join("tmp.swp"), ahead + 1000);
    fs::rename(site.served.join("tmp.swp"), site.served.join("sub/b.txt")).unwrap();
    let answer = wait_for_first("sub/b.txt").await;
    // The link to it stays out of the list, as it does after a fresh walk.
    assert!(!recent_paths(&answer).contains(&"link-in.txt"));

    // A new file, in a new folder.
    fs::create_dir_all(site.served.join("fresh/inner")).unwrap();
    fs::write(site.served.join("fresh/inner/zebra.txt"), "new").unwrap();
    written_at(site.served.join("fresh/inner/zebra.txt"), ahead + 2000);
    wait_for_first("fresh/inner/zebra.txt").await;

    fs::remove_file(site.served.join("fresh/inner/zebra.txt")).unwrap();
    fs::remove_file(site.served.join("sub/b.txt")).unwrap();
    for _ in 0..200 {
        let answer = json(&app, "/api/recent").await;
        let paths = recent_paths(&answer);
        if !paths.contains(&"fresh/inner/zebra.txt") && !paths.contains(&"sub/b.txt") {
            assert_eq!(paths.first(), Some(&"a.txt"));
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("removed files stayed in the list");
}

#[cfg(unix)]
#[tokio::test]
async fn a_change_behind_a_link_to_a_folder_is_seen_once_under_the_real_folder() {
    let site = Site::new();
    std::os::unix::fs::symlink(site.served.join("sub"), site.served.join("current")).unwrap();
    let root = Root::new(&site.served, false).unwrap();
    let index = Index::spawn(root.clone());
    let app = router(App::new(root, Arc::clone(&index), Options::default()).unwrap());
    let wait_for = |uri: &'static str, done: fn(&Value) -> bool| {
        let app = app.clone();
        async move {
            for _ in 0..200 {
                if done(&json(&app, uri).await) {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            panic!("{uri} never gave the answer waited for");
        }
    };
    wait_for("/api/search?q=current", |found| {
        found["ready"] == true && found["total"] == 1
    })
    .await;

    // Written through the link: the file is in the folder the link leads to.
    fs::write(site.served.join("current/new.html"), "new").unwrap();
    wait_for("/api/recent", |recent| recent_paths(recent).contains(&"sub/new.html")).await;
    let recent = json(&app, "/api/recent").await;
    let listed = recent_paths(&recent);
    assert_eq!(listed.iter().filter(|path| path.ends_with("new.html")).count(), 1);
    let found = json(&app, "/api/search?q=new.html").await;
    assert_eq!(found["total"], 1);
    assert_eq!(found["hits"][0]["path"], "sub/new.html");

    // The link goes, and the folder it led to is watched as before.
    fs::remove_file(site.served.join("current")).unwrap();
    wait_for("/api/search?q=current", |found| found["total"] == 0).await;
    fs::write(site.served.join("sub/newer.html"), "newer").unwrap();
    wait_for("/api/recent", |recent| recent_paths(recent).contains(&"sub/newer.html")).await;
}

#[tokio::test]
async fn recent_is_refused_for_a_wrong_host_like_every_route() {
    let site = Site::new();
    let app = site.app(Options {
        check_host: true,
        ..Options::default()
    });
    let ask = |host: &'static str| {
        Request::get("/api/recent")
            .header(header::HOST, host)
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(send(&app, ask("localhost:8080")).await.0.status(), StatusCode::OK);
    let (response, body) = send(&app, ask("evil.example")).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(!String::from_utf8_lossy(&body).contains("a.txt"));
}

#[tokio::test]
async fn deleting_is_off_unless_asked_for() {
    let site = Site::new();
    let app = site.router();
    let before = snapshot(&site.served);
    for path in ["a.txt", "sub", "sub/b.txt", "link-in.txt", ""] {
        let (response, body) = send(&app, page_delete(path).unwrap()).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
        assert!(String::from_utf8_lossy(&body).contains("--allow-delete"), "{path}");
    }
    assert_eq!(snapshot(&site.served), before);

    // The page shows its delete control only when the server says deleting is on.
    for (app, on) in [(app, false), (site.deleting(), true)] {
        let (_, body) = get(&app, "/").await;
        let html = String::from_utf8_lossy(&body).into_owned();
        assert_eq!(html.contains("\"delete\":true"), on);
        assert_eq!(html.contains("\"delete\":false"), !on);
    }
}

#[tokio::test]
async fn a_file_or_a_folder_with_its_contents_is_deleted() {
    let site = Site::new();
    let app = site.deleting();
    assert_eq!(json(&app, "/api/search?q=c.rs").await["total"], 1);

    assert_eq!(delete(&app, "a.txt").await, StatusCode::NO_CONTENT);
    assert!(!site.served.join("a.txt").exists());
    assert!(site.served.join("file2.txt").exists());
    assert_eq!(delete(&app, "a.txt").await, StatusCode::NOT_FOUND);
    assert_eq!(delete(&app, "sub/nope.txt").await, StatusCode::NOT_FOUND);
    assert_eq!(delete(&app, "nope/b.txt").await, StatusCode::NOT_FOUND);

    assert_eq!(delete(&app, "/sub/deep/").await, StatusCode::NO_CONTENT);
    assert!(!site.served.join("sub/deep").exists());
    assert!(site.served.join("sub/b.txt").exists());
    assert_eq!(delete(&app, "sub").await, StatusCode::NO_CONTENT);
    assert!(!site.served.join("sub").exists());

    // Nothing the server remembers still shows them.
    let listing = json(&app, "/api/list?path=").await;
    assert!(!names(&listing).contains(&"a.txt") && !names(&listing).contains(&"sub"));
    assert_eq!(json(&app, "/api/search?q=c.rs").await["total"], 0);
    assert_eq!(json(&app, "/api/search?q=b.txt").await["total"], 0);
    assert_eq!(json(&app, "/api/search?q=a.txt").await["total"], 0);
    assert_eq!(json(&app, "/api/search?q=file2").await["total"], 1);
}

#[tokio::test]
async fn a_delete_finds_an_entry_only_by_the_name_its_folder_lists() {
    let site = Site::new();
    fs::write(site.served.join("A long name.TEXT"), "kept").unwrap();
    fs::create_dir_all(site.served.join(".dotfolder")).unwrap();
    fs::write(site.served.join(".dotfolder/kept.txt"), "kept").unwrap();
    let app = site.deleting();
    let before = snapshot(&site.served);
    // Other spellings that some file systems answer to: another case, a short name, a dot at the end.
    for alias in [
        "a long name.text",
        "A LONG NAME.TEXT",
        "ALONGN~1.TEX",
        "A long name.TEXT.",
        "DOTFOL~1",
    ] {
        let request = page_delete(&alias.replace(' ', "%20")).unwrap();
        assert_eq!(send(&app, request).await.0.status(), StatusCode::NOT_FOUND, "{alias}");
        assert_eq!(snapshot(&site.served), before, "{alias}");
    }
    assert_eq!(delete(&app, "A%20long%20name.TEXT").await, StatusCode::NO_CONTENT);
    assert!(!site.served.join("A long name.TEXT").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn a_folder_delete_that_stops_part_way_says_so_and_shows_what_is_left() {
    use std::os::unix::fs::PermissionsExt;
    let site = Site::new();
    let locked = site.served.join("locked");
    fs::create_dir_all(locked.join("proj/free")).unwrap();
    fs::write(locked.join("kept.txt"), "kept").unwrap();
    fs::write(locked.join("proj/note.txt"), "note").unwrap();
    fs::write(locked.join("proj/free/loose.txt"), "loose").unwrap();
    // One folder in another in another, with the middle one locked.
    let middle = site.served.join("chain/locked");
    fs::create_dir_all(middle.join("inner")).unwrap();
    fs::write(middle.join("inner/quartz.dat"), "deep").unwrap();
    // A folder that may be read and not written to: no name can be taken out of it.
    let lock = |mode: u32| {
        for dir in [&locked, &middle] {
            fs::set_permissions(dir, fs::Permissions::from_mode(mode)).unwrap();
        }
    };
    lock(0o555);
    if fs::write(locked.join("probe"), "").is_ok() {
        // Whoever runs this is let past the permission, as root is: nothing can be made to fail.
        return lock(0o755);
    }
    let app = site.deleting();
    let indexed = json(&app, "/api/search?q=loose").await["indexed"].as_u64().unwrap();
    let answer = |path: &'static str| {
        let app = app.clone();
        async move {
            let (response, body) = send(&app, page_delete(path).unwrap()).await;
            (response.status(), serde_json::from_slice::<Value>(&body).unwrap())
        }
    };

    // A file in it fails before anything is removed. A folder in it is emptied, and then cannot go itself.
    let file = answer("locked/kept.txt").await;
    let folder = answer("locked/proj").await;
    let found = json(&app, "/api/search?q=loose").await;
    // A folder that loses only what is deepest in it: every folder on the way down stays, with the same names.
    let chain = answer("chain").await;
    lock(0o755);

    assert_eq!(
        file,
        (
            StatusCode::FORBIDDEN,
            serde_json::json!({ "error": "permission denied" })
        )
    );
    assert_eq!(fs::read_to_string(locked.join("kept.txt")).unwrap(), "kept");
    assert_eq!(folder.0, StatusCode::FORBIDDEN);
    assert_eq!(folder.1["partial"], true);
    let why = folder.1["error"].as_str().unwrap();
    assert!(
        why.contains("permission denied") && why.contains("part of the folder may already be gone"),
        "{why}"
    );
    assert_eq!(fs::read_dir(locked.join("proj")).unwrap().count(), 0);

    // What the page then asks for is what is left: the folder, with nothing in it.
    let listing = json(&app, "/api/list?path=locked").await;
    let proj = listing["entries"].as_array().unwrap().iter().find(|e| e["n"] == "proj");
    assert_eq!(proj.unwrap()["c"], 0);
    assert_eq!(found["total"], 0, "{found}");
    assert_eq!(found["indexed"], indexed - 3);
    assert_eq!(json(&app, "/api/search?q=kept.txt").await["total"], 1);

    // The same holds at any depth of a folder that is still there.
    assert_eq!(
        (chain.0, &chain.1["partial"]),
        (StatusCode::FORBIDDEN, &Value::Bool(true))
    );
    assert_eq!(fs::read_dir(middle.join("inner")).unwrap().count(), 0);
    let listing = json(&app, "/api/list?path=chain/locked").await;
    let inner = listing["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["n"] == "inner");
    assert_eq!(inner.unwrap()["c"], 0);
    let found = json(&app, "/api/search?q=quartz").await;
    assert_eq!(found["total"], 0, "{found}");
    assert_eq!(found["indexed"], indexed - 4);
}

#[tokio::test]
async fn the_served_folder_itself_is_never_deleted() {
    let site = Site::new();
    let app = site.deleting();
    let before = snapshot(&site.served);
    for path in ["", "/", "//", "%2F"] {
        assert_eq!(delete(&app, path).await, StatusCode::FORBIDDEN, "{path:?}");
    }
    let (response, _) = send(
        &app,
        Request::delete("/api/entry")
            .header(header::HOST, HOME)
            .header(header::ORIGIN, format!("http://{HOME}"))
            .header("x-okfs", "delete")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(snapshot(&site.served), before);
}

#[tokio::test]
async fn no_delete_leaves_the_served_folder_or_reaches_a_dotfile() {
    let site = Site::new();
    fs::create_dir_all(site.served.join(".git")).unwrap();
    fs::write(site.served.join(".git/config"), SECRET).unwrap();
    let app = site.deleting();
    let before = (snapshot(&site.served), snapshot(&site.outside));
    let escapes = [
        "..",
        "../outside",
        "../outside/secret.txt",
        "%2e%2e/outside/secret.txt",
        "%2E%2E%2Foutside%2Fsecret.txt",
        "..%2foutside%2fsecret.txt",
        "sub/../../outside/secret.txt",
        "sub/..%2f..%2foutside/secret.txt",
        "sub/%2e%2e/%2e%2e/outside/secret.txt",
        "./../outside/secret.txt",
        "sub/..",
        "sub/.",
        "sub/../a.txt",
        "..%5coutside%5csecret.txt",
        "%252e%252e/outside/secret.txt",
        "..%00/outside/secret.txt",
        "a.txt%00",
        "link-out.txt",
        "link-out-dir",
        "link-out-dir/secret.txt",
        "link-out-dir/page.html",
        ".hidden",
        ".git",
        ".git/config",
    ];
    let absolute = site.outside.join("secret.txt");
    let absolute = absolute.to_str().unwrap();
    let encoded_absolute = absolute.replace('/', "%2F");
    let folder = site.outside.to_str().unwrap();
    for escape in escapes.into_iter().chain([absolute, encoded_absolute.as_str(), folder]) {
        let Some(request) = page_delete(escape) else { continue };
        let status = send(&app, request).await.0.status();
        assert!(
            status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND,
            "{escape}: {status}"
        );
    }
    assert_eq!(snapshot(&site.served), before.0);
    assert_eq!(snapshot(&site.outside), before.1);
    assert!(site.outside.is_dir());
}

#[tokio::test]
async fn a_folder_that_holds_a_dotfile_is_refused_whole() {
    let site = Site::new();
    fs::write(site.served.join("sub/deep/.dotfile"), "not shown, still inside").unwrap();
    // Nothing in it is shown: the page counts no items in it.
    fs::create_dir_all(site.served.join("scratch/.git")).unwrap();
    fs::write(site.served.join("scratch/.git/config"), SECRET).unwrap();
    fs::write(site.served.join("scratch/.env"), SECRET).unwrap();
    let app = site.deleting();
    let before = snapshot(&site.served);
    let listing = json(&app, "/api/list?path=").await;
    let scratch = listing["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["n"] == "scratch");
    assert_eq!(scratch.unwrap()["c"], 0);

    // The folder that holds it, a folder above that one, and a folder of nothing else.
    for path in ["sub/deep", "sub", "scratch"] {
        let (status, why) = refusal(&app, page_delete(path).unwrap()).await;
        assert_eq!(status, StatusCode::CONFLICT, "{path}");
        assert!(why.contains("dotfile") && why.contains("--hidden"), "{path}: {why}");
        // The reason names no hidden entry.
        assert!(
            !why.contains(".dotfile") && !why.contains(".git") && !why.contains(".env"),
            "{why}"
        );
    }
    assert_eq!(snapshot(&site.served), before);
    assert!(site.served.join("scratch/.git").is_dir());
    assert_eq!(json(&app, "/api/search?q=c.rs").await["total"], 1);

    // What is beside the dotfile still goes by itself.
    assert_eq!(delete(&app, "sub/deep/c.rs").await, StatusCode::NO_CONTENT);
    assert!(site.served.join("sub/deep/.dotfile").exists());

    // With --hidden the dotfiles are shown, and the same folders go with them.
    let app = site.serving(
        true,
        Options {
            allow_delete: true,
            ..Options::default()
        },
    );
    for path in ["scratch", "sub"] {
        assert_eq!(delete(&app, path).await, StatusCode::NO_CONTENT, "{path}");
        assert!(!site.served.join(path).exists(), "{path}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_folder_that_holds_a_link_okfs_does_not_show_is_refused_whole() {
    use std::os::unix::fs::symlink;
    let site = Site::new();
    fs::create_dir_all(site.served.join("out/in")).unwrap();
    fs::create_dir_all(site.served.join("dangling")).unwrap();
    fs::write(site.served.join("out/kept.txt"), "kept").unwrap();
    // A link to a folder outside, at some depth, and a link to nothing.
    symlink(&site.outside, site.served.join("out/in/exit")).unwrap();
    symlink(site.served.join("nowhere"), site.served.join("dangling/lost")).unwrap();
    let app = site.deleting();
    let before = (snapshot(&site.served), snapshot(&site.outside));

    for path in ["out", "out/in", "dangling"] {
        let (status, why) = refusal(&app, page_delete(path).unwrap()).await;
        assert_eq!(status, StatusCode::CONFLICT, "{path}");
        assert!(
            why.contains("link") && why.contains("remove it yourself"),
            "{path}: {why}"
        );
    }
    assert_eq!(snapshot(&site.served), before.0);
    assert_eq!(snapshot(&site.outside), before.1);
    assert!(fs::symlink_metadata(site.served.join("out/in/exit")).is_ok());

    // Once the links are out of the way, the folders go.
    fs::remove_file(site.served.join("out/in/exit")).unwrap();
    fs::remove_file(site.served.join("dangling/lost")).unwrap();
    for path in ["out", "dangling"] {
        assert_eq!(delete(&app, path).await, StatusCode::NO_CONTENT, "{path}");
        assert!(!site.served.join(path).exists(), "{path}");
    }
    assert_eq!(snapshot(&site.outside), before.1);
}

#[cfg(unix)]
#[tokio::test]
async fn a_link_is_deleted_as_a_link_and_never_followed() {
    use std::os::unix::fs::symlink;
    let site = Site::new();
    symlink(site.served.join("sub"), site.served.join("link-in-dir")).unwrap();
    // A folder that holds links to a file and to a folder elsewhere in the served folder.
    fs::create_dir_all(site.served.join("album")).unwrap();
    symlink(site.served.join("a.txt"), site.served.join("album/home.txt")).unwrap();
    symlink(site.served.join("sub"), site.served.join("album/sub")).unwrap();
    let app = site.deleting();
    let before = (snapshot(&site.served.join("sub")), snapshot(&site.outside));
    let gone = |name: &str| fs::symlink_metadata(site.served.join(name)).is_err();

    // The page is told which entries are links, and when the folder it shows is one.
    let listing = json(&app, "/api/list?path=").await;
    let entry = |name: &str| listing["entries"].as_array().unwrap().iter().find(|e| e["n"] == name);
    assert_eq!(entry("link-in-dir").unwrap()["l"], true);
    assert_eq!(entry("link-in-dir").unwrap()["d"], true);
    assert_eq!(entry("link-in.txt").unwrap()["l"], true);
    assert!(entry("sub").unwrap().get("l").is_none());
    assert!(entry("a.txt").unwrap().get("l").is_none());
    assert_eq!(json(&app, "/api/list?path=link-in-dir").await["link"], true);
    assert!(json(&app, "/api/list?path=sub").await.get("link").is_none());
    assert!(
        json(&app, "/api/list?path=link-in-dir/deep")
            .await
            .get("link")
            .is_none()
    );
    assert!(listing.get("link").is_none());

    // A link to a file and a link to a folder: the link goes, what it points at stays.
    for link in ["link-in.txt", "link-in-dir"] {
        assert_eq!(delete(&app, link).await, StatusCode::NO_CONTENT, "{link}");
        assert!(gone(link), "{link}");
    }
    assert_eq!(snapshot(&site.served.join("sub")), before.0);

    // A folder goes with the links in it, and they are not walked through.
    assert_eq!(delete(&app, "album").await, StatusCode::NO_CONTENT);
    assert!(gone("album"));
    assert_eq!(snapshot(&site.served.join("sub")), before.0);
    assert!(site.served.join("a.txt").exists());

    // A link that leaves the served folder is not shown, so there is nothing to delete.
    for link in ["link-out.txt", "link-out-dir"] {
        assert_eq!(delete(&app, link).await, StatusCode::NOT_FOUND, "{link}");
        assert!(!gone(link), "{link}");
    }
    assert_eq!(snapshot(&site.outside), before.1);
}

#[tokio::test]
async fn only_okfs_may_frame_the_page_while_deleting_is_on() {
    let site = Site::new();
    for (app, on) in [(site.router(), false), (site.deleting(), true)] {
        // A folder, a file, a path behind /-/ and one that is missing: each is the page.
        for uri in ["/", "/sub/", "/sub/b.txt", "/-/sub/", "/nope"] {
            let (page, _) = get(&app, uri).await;
            let policy = page_policy(&page);
            let (framing, rest): (Vec<&str>, Vec<&str>) = policy
                .iter()
                .map(String::as_str)
                .partition(|directive| directive.starts_with("frame-ancestors"));
            if on {
                assert_eq!(framing, ["frame-ancestors 'self'"], "{uri}");
            } else {
                assert!(framing.is_empty(), "{uri}: {framing:?}");
            }
            // The rest of the policy is the same either way.
            assert!(
                rest.contains(&"script-src 'self'") && rest.contains(&"frame-src 'self'"),
                "{uri}: {rest:?}"
            );
        }
    }
}

#[tokio::test]
async fn another_site_cannot_make_a_browser_delete() {
    let site = Site::new();
    let app = site.app(Options {
        allow_delete: true,
        check_host: true,
        allow_hosts: vec!["files.example.test".to_owned()],
        ..Options::default()
    });
    let before = snapshot(&site.served);
    let request = |method: &str, host: &str, headers: Headers| {
        let mut request = Request::builder()
            .method(method)
            .uri("/api/entry?path=a.txt")
            .header(header::HOST, host);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        request.body(Body::from("path=a.txt")).unwrap()
    };
    let own = ("x-okfs", "delete");
    let form = ("content-type", "application/x-www-form-urlencoded");

    let refused: [(&str, &str, Headers); 22] = [
        // No Origin at all, with and without the header.
        ("DELETE", HOME, &[]),
        ("DELETE", HOME, &[own]),
        // Another site, however it spells itself.
        ("DELETE", HOME, &[own, ("origin", "https://evil.example")]),
        ("DELETE", HOME, &[own, ("origin", "http://evil.example:8080")]),
        ("DELETE", HOME, &[own, ("origin", "http://localhost.evil.example:8080")]),
        ("DELETE", HOME, &[own, ("origin", "http://localhost:8080.evil.example")]),
        ("DELETE", HOME, &[own, ("origin", "http://evil.example/localhost:8080")]),
        ("DELETE", HOME, &[own, ("origin", "http://localhost:8080@evil.example")]),
        ("DELETE", HOME, &[own, ("origin", "file://localhost:8080")]),
        ("DELETE", HOME, &[own, ("origin", "localhost:8080")]),
        ("DELETE", HOME, &[own, ("origin", "")]),
        // Another page on this machine, or at a plain address: not the one asked.
        ("DELETE", HOME, &[own, ("origin", "http://localhost:3000")]),
        ("DELETE", HOME, &[own, ("origin", "http://localhost")]),
        ("DELETE", HOME, &[own, ("origin", "http://127.0.0.1:8080")]),
        ("DELETE", HOME, &[own, ("origin", "http://203.0.113.9:8080")]),
        // A served HTML or SVG file: okfs sends those sandboxed, so their origin is null.
        ("DELETE", HOME, &[own, ("origin", "null")]),
        // Two origins: one of them is a lie.
        (
            "DELETE",
            HOME,
            &[
                own,
                ("origin", "http://localhost:8080"),
                ("origin", "https://evil.example"),
            ],
        ),
        // The right origin without the header, or with the wrong value in it.
        ("DELETE", HOME, &[("origin", "http://localhost:8080")]),
        ("DELETE", HOME, &[("x-okfs", "1"), ("origin", "http://localhost:8080")]),
        // A plain form post, from the page's own address or from elsewhere.
        ("POST", HOME, &[form, ("origin", "http://localhost:8080")]),
        ("POST", HOME, &[form, own, ("origin", "http://localhost:8080")]),
        ("GET", HOME, &[own, ("origin", "http://localhost:8080")]),
    ];
    for (method, host, headers) in refused {
        let status = send(&app, request(method, host, headers)).await.0.status();
        let expected = if method == "DELETE" {
            StatusCode::FORBIDDEN
        } else {
            StatusCode::METHOD_NOT_ALLOWED
        };
        assert_eq!(status, expected, "{method} {headers:?}");
        assert!(site.served.join("a.txt").exists(), "{method} {headers:?}");
    }
    // Asking for leave, as a browser does before a cross-site DELETE, gets none.
    let (preflight, _) = send(
        &app,
        request(
            "OPTIONS",
            HOME,
            &[
                ("origin", "https://evil.example"),
                ("access-control-request-method", "DELETE"),
                ("access-control-request-headers", "x-okfs"),
            ],
        ),
    )
    .await;
    assert_eq!(preflight.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert!(!preflight.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    assert!(!preflight.headers().contains_key(header::ACCESS_CONTROL_ALLOW_METHODS));
    assert_eq!(snapshot(&site.served), before);

    // The page's own request passes, at each address the page can be opened at.
    let allowed: [(&str, &str); 7] = [
        (HOME, "http://localhost:8080"),
        ("LOCALHOST:8080", "http://localhost:8080"),
        ("127.0.0.1:8080", "http://127.0.0.1:8080"),
        ("[::1]:8080", "http://[::1]:8080"),
        ("localhost", "http://localhost"),
        // Behind a proxy that ends TLS and is named with --allow-host: the browser
        // says https, and the proxy passes its own name on or puts okfs's address there.
        ("files.example.test", "https://files.example.test"),
        ("127.0.0.1:8080", "https://files.example.test"),
    ];
    for (host, origin) in allowed {
        fs::write(site.served.join("a.txt"), "again").unwrap();
        let status = send(&app, request("DELETE", host, &[own, ("origin", origin)]))
            .await
            .0
            .status();
        assert_eq!(status, StatusCode::NO_CONTENT, "{host} {origin}");
        assert!(!site.served.join("a.txt").exists(), "{host} {origin}");
    }
}

#[tokio::test]
async fn a_name_pointed_at_this_machine_cannot_delete_even_beyond_loopback() {
    let site = Site::new();
    // Listening on every address: any Host is answered, so a hostile name gets the page.
    let app = site.deleting();
    let request = Request::delete("/api/entry?path=a.txt")
        .header(header::HOST, "rebound.evil.example:8080")
        .header(header::ORIGIN, "http://rebound.evil.example:8080")
        .header("x-okfs", "delete")
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(&app, request).await.0.status(), StatusCode::FORBIDDEN);
    assert!(site.served.join("a.txt").exists());
}

#[tokio::test]
async fn a_delete_from_a_name_okfs_does_not_know_says_how_to_allow_it() {
    let site = Site::new();
    let from = |host: &str, origin: &str| {
        Request::delete("/api/entry?path=a.txt")
            .header(header::HOST, host)
            .header(header::ORIGIN, origin)
            .header("x-okfs", "delete")
            .body(Body::empty())
            .unwrap()
    };
    // The page opened by a name of the machine, and behind a proxy that passes its own address on.
    let cases = [
        ("mybox:8080", "http://mybox:8080", "mybox"),
        ("127.0.0.1:8080", "https://files.example.test", "files.example.test"),
    ];
    for (host, origin, name) in cases {
        let app = site.deleting();
        let (status, why) = refusal(&app, from(host, origin)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{origin}");
        assert!(why.contains(&format!("--allow-host {name}")), "{origin}: {why}");
        assert!(site.served.join("a.txt").exists(), "{origin}");

        // Doing what it says lets the same request through.
        let app = site.app(Options {
            allow_delete: true,
            allow_hosts: vec![name.to_owned()],
            ..Options::default()
        });
        assert_eq!(
            send(&app, from(host, origin)).await.0.status(),
            StatusCode::NO_CONTENT,
            "{origin}"
        );
        fs::write(site.served.join("a.txt"), "again").unwrap();
    }

    // A request that names no page gets no such advice: there is no name to allow.
    let app = site.deleting();
    for origin in ["null", "file://mybox", ""] {
        let (status, why) = refusal(&app, from(HOME, origin)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{origin:?}");
        assert!(!why.contains("--allow-host"), "{origin:?}: {why}");
    }
}

#[tokio::test]
async fn a_folder_answers_with_its_index_page_only_behind_the_flag() {
    let site = Site::new();
    fs::write(site.served.join("sub/index.html"), "<h1>site</h1>").unwrap();
    fs::write(site.served.join("sub/.home.html"), "<h1>hidden</h1>").unwrap();
    fs::create_dir_all(site.served.join("sub/deep/index.html")).unwrap();
    fs::create_dir_all(site.served.join("empty")).unwrap();
    fs::create_dir_all(site.served.join("linked")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(site.outside.join("page.html"), site.served.join("linked/index.html")).unwrap();
    let config = |html: &[u8]| -> Value {
        let html = String::from_utf8_lossy(html).into_owned();
        let start = html.find("id=\"okfs-config\">").unwrap() + "id=\"okfs-config\">".len();
        let end = start + html[start..].find("</script>").unwrap();
        serde_json::from_str(&html[start..end]).unwrap()
    };
    let with = |name: &str| {
        site.app(Options {
            index: Some(name.to_owned()),
            ..Options::default()
        })
    };
    let (app, off) = (with("index.html"), site.router());

    let (_, body) = get(&app, "/sub/").await;
    assert_eq!(config(&body)["index"], "index.html");
    assert_eq!(
        config(&body)["target"],
        serde_json::json!({ "path": "sub", "kind": "dir" })
    );

    // The folder's address under /raw/ is its index page, sent as that file is: sandboxed.
    let (folder, body) = get(&app, "/raw/sub/").await;
    assert_eq!(folder.status(), StatusCode::OK);
    assert_eq!(body, b"<h1>site</h1>");
    let policy = folder.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
    assert!(policy.starts_with("sandbox"), "{policy}");
    assert_eq!(folder.headers()[header::CONTENT_TYPE], "text/html; charset=utf-8");
    let (file, _) = get(&app, "/raw/sub/index.html").await;
    assert_eq!(folder.headers(), file.headers());

    // Without the slash it moves to the address with it, so links inside the page resolve.
    for (asked, to) in [("/raw/sub", "/raw/sub/"), ("/raw/sub?tab=2", "/raw/sub/?tab=2")] {
        let (response, _) = get(&app, asked).await;
        assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT, "{asked}");
        assert_eq!(response.headers()[header::LOCATION], to, "{asked}");
    }

    // No such file, a folder of that name, and a link that leaves the served folder:
    // the answer is the one okfs gives without the flag.
    for folder in ["empty", "sub/deep", "linked"] {
        for uri in [format!("/raw/{folder}/"), format!("/raw/{folder}")] {
            let (response, body) = get(&app, &uri).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
            assert!(
                !String::from_utf8_lossy(&body).contains(SECRET),
                "{uri} leaked the file outside"
            );
            assert_eq!(body, get(&off, &uri).await.1, "{uri}");
        }
    }

    // A dotfile is not served, so it is not an index page either.
    let hidden = with(".home.html");
    for uri in ["/raw/sub/", "/raw/sub"] {
        assert_eq!(get(&hidden, uri).await.0.status(), StatusCode::NOT_FOUND, "{uri}");
    }

    // With the flag off, the answers are the ones okfs always gave.
    let (_, body) = get(&off, "/sub/").await;
    assert!(config(&body).get("index").is_none());
    for uri in ["/raw/sub/", "/raw/sub"] {
        assert_eq!(get(&off, uri).await.0.status(), StatusCode::NOT_FOUND, "{uri}");
    }
    assert_eq!(get(&off, "/raw/sub/index.html").await.1, b"<h1>site</h1>");

    // The served folder itself: /raw/ is its index page once it holds one, and only behind the flag.
    let missing = serde_json::json!({ "path": "raw", "kind": "missing" });
    let (response, body) = get(&app, "/raw/").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(config(&body)["target"], missing);
    fs::write(site.served.join("index.html"), "<h1>top</h1>").unwrap();
    let (top, body) = get(&app, "/raw/").await;
    assert_eq!(top.status(), StatusCode::OK);
    assert_eq!(body, b"<h1>top</h1>");
    assert_eq!(top.headers(), get(&app, "/raw/index.html").await.0.headers());
    let (response, body) = get(&off, "/raw/").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(config(&body)["target"], missing);
}
