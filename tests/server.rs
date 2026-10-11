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
    // A folder that may be read and not written to: no name can be taken out of it.
    let lock = |mode: u32| fs::set_permissions(&locked, fs::Permissions::from_mode(mode)).unwrap();
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
    let found = json(&app, "/api/search?q=loose").await;
    assert_eq!(found["total"], 0, "{found}");
    assert_eq!(found["indexed"], indexed - 3);
    assert_eq!(json(&app, "/api/search?q=kept.txt").await["total"], 1);
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
