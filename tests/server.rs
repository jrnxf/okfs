//! Behavior that can break without anyone noticing: the safety rules, deleting, writing, ranges,
//! listings, bounded inputs and the theme gate. Each test drives the real router.

use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, Response, StatusCode, header};
use http_body_util::BodyExt;
use okfs::index::{Follow, Index};
use okfs::key::{Key, ONCE_LIFE, Once};
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

    /// With adding and changing files switched on.
    fn writing(&self) -> axum::Router {
        self.app(Options {
            allow_upload: true,
            allow_edit: true,
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

/// What a browser sends when it goes to an address.
const BROWSER_ACCEPT: &str = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/// A GET as a browser's navigation sends it.
async fn browse(app: &axum::Router, uri: &str) -> (Response<()>, Vec<u8>) {
    let request = Request::get(uri).header(header::ACCEPT, BROWSER_ACCEPT);
    send(app, request.body(Body::empty()).unwrap()).await
}

/// The preview of the file at `path`, as `/api/previews` sends it, with `form` after: `&lines=80`, `&raw=1`.
async fn preview(app: &axum::Router, path: &str, form: &str) -> Value {
    let all = json(app, &format!("/api/previews?p={}{form}", path.replace('/', "%2F"))).await;
    all.get(path).cloned().unwrap_or(Value::Null)
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
            format!("/api/picture?path={escape}"),
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
        // Previews by path leave out what is not there, so the answer is empty.
        let uri = format!("/api/previews?p={escape}");
        if let Ok(request) = Request::get(&uri).body(Body::empty()) {
            let (response, body) = send(&app, request).await;
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            assert_eq!(body, b"{}", "{uri}");
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

    // A link inside has its file's size and time everywhere a file is shown with them.
    let entries = listing["entries"].as_array().unwrap();
    let listed = entries.iter().find(|entry| entry["n"] == "link-in.txt").unwrap();
    assert_eq!(listed["s"], 6);
    assert!(listed["m"].as_i64().unwrap() > 0);
    for uri in [
        "/api/search?q=link-in",
        "/api/search?q=link-in&offset=0&limit=10&sort=size",
    ] {
        let found = json(&app, uri).await;
        let hit = &found["hits"][0];
        assert_eq!(hit["path"], "link-in.txt", "{uri}: {found}");
        assert_eq!((&hit["s"], &hit["m"]), (&listed["s"], &listed["m"]), "{uri}: {found}");
    }

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
        "/api/previews?p=a.txt",
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
    // A folder's own time is the one its entry in the parent shows.
    assert_eq!(sub["m"], entry("sub")["m"]);
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

    let (response, body) = get(&app, "/api/picture?path=wide.png&w=100").await;
    assert_eq!(response.status(), StatusCode::OK);
    let small = image::load_from_memory(&body).unwrap();
    assert_eq!((small.width(), small.height()), (320, 160));

    let (response, body) = get(&app, "/api/picture?path=sideways.jpg&w=640").await;
    assert_eq!(response.status(), StatusCode::OK);
    let upright = image::load_from_memory(&body).unwrap();
    assert_eq!((upright.width(), upright.height()), (30, 60));

    for uri in ["/api/picture?path=bomb.png&w=640", "/api/picture?path=huge.png&w=640"] {
        assert_eq!(get(&app, uri).await.0.status(), StatusCode::PAYLOAD_TOO_LARGE, "{uri}");
    }
    assert_eq!(
        get(&app, "/api/picture?path=a.txt&w=640").await.0.status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );

    assert!(!cache.exists());
    assert_eq!(snapshot(&site.served).len(), before);
}

#[tokio::test]
async fn a_picture_is_made_whole_for_a_format_a_browser_cannot_show() {
    let site = Site::new();
    let mut tiff = Vec::new();
    image::DynamicImage::new_rgb8(300, 200)
        .write_to(&mut std::io::Cursor::new(&mut tiff), image::ImageFormat::Tiff)
        .unwrap();
    fs::write(site.served.join("scan.tiff"), tiff).unwrap();
    let app = site.router();

    let (response, body) = get(&app, "/api/picture?path=scan.tiff").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/jpeg");
    let whole = image::load_from_memory(&body).unwrap();
    assert_eq!((whole.width(), whole.height()), (300, 200));

    assert_eq!(
        get(&app, "/api/picture?path=a.txt").await.0.status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        get(&app, "/api/picture?path=gone.tiff").await.0.status(),
        StatusCode::NOT_FOUND
    );
}

/// A little-endian TIFF container, as a CR2, NEF or DNG is: IFD0 says the camera was held sideways and
/// points at a SubIFD, which names the JPEG that follows.
fn camera_file(preview: &[u8]) -> Vec<u8> {
    let entry = |tag: u16, kind: u16, value: u32| {
        let mut e = Vec::new();
        e.extend(tag.to_le_bytes());
        e.extend(kind.to_le_bytes());
        e.extend(1u32.to_le_bytes());
        e.extend(value.to_le_bytes());
        e
    };
    let sub = 8 + 2 + 2 * 12 + 4;
    let data = sub + 2 + 2 * 12 + 4;
    let mut out = vec![b'I', b'I', 42, 0, 8, 0, 0, 0];
    out.extend(2u16.to_le_bytes());
    out.extend(entry(0x112, 3, 6));
    out.extend(entry(0x14a, 4, sub as u32));
    out.extend(0u32.to_le_bytes());
    out.extend(2u16.to_le_bytes());
    out.extend(entry(0x201, 4, data as u32));
    out.extend(entry(0x202, 4, preview.len() as u32));
    out.extend(0u32.to_le_bytes());
    out.extend(preview);
    out
}

#[tokio::test]
async fn a_camera_raw_file_is_shown_by_the_preview_inside_it() {
    let site = Site::new();
    let mut preview = Vec::new();
    image::DynamicImage::new_rgb8(300, 200)
        .write_to(&mut Cursor::new(&mut preview), image::ImageFormat::Jpeg)
        .unwrap();
    for name in ["a.cr2", "b.NEF", "c.dng"] {
        fs::write(site.served.join(name), camera_file(&preview)).unwrap();
    }
    fs::write(site.served.join("plain.jpg"), &preview).unwrap();
    // A container with no preview, and a name that is not one.
    let mut bare = camera_file(&preview);
    bare.truncate(8 + 2 + 2 * 12 + 4);
    fs::write(site.served.join("bare.arw"), bare).unwrap();
    fs::write(site.served.join("text.raf"), "not a photo").unwrap();
    let app = site.router();

    for name in ["a.cr2", "b.NEF", "c.dng"] {
        // The camera was held sideways: the picture comes upright, so 200 wide and 300 high.
        let (response, body) = get(&app, &format!("/api/picture?path={name}")).await;
        assert_eq!(response.status(), StatusCode::OK, "{name}");
        let whole = image::load_from_memory(&body).unwrap();
        assert_eq!((whole.width(), whole.height()), (200, 300), "{name}");
        let (response, body) = get(&app, &format!("/api/picture?path={name}&w=160")).await;
        assert_eq!(response.status(), StatusCode::OK, "{name}");
        assert_eq!(image::load_from_memory(&body).unwrap().width(), 160, "{name}");
    }
    for name in ["bare.arw", "text.raf"] {
        assert_eq!(
            get(&app, &format!("/api/picture?path={name}")).await.0.status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "{name}"
        );
    }

    // A RAW picture answers in the order of a JPEG one, not of a decode of the sensor data.
    let time = |path: &'static str| {
        let app = app.clone();
        async move {
            let start = std::time::Instant::now();
            for _ in 0..20 {
                assert_eq!(get(&app, path).await.0.status(), StatusCode::OK);
            }
            start.elapsed()
        }
    };
    let (jpeg, raw) = (time("/api/picture?path=plain.jpg&w=160").await, time("/api/picture?path=a.cr2&w=160").await);
    assert!(raw < jpeg * 10 + std::time::Duration::from_millis(500), "raw {raw:?} against jpeg {jpeg:?}");
}

#[tokio::test]
async fn a_camera_raw_file_over_the_size_bound_is_shown_when_its_preview_is_small() {
    let site = Site::new();
    let mut preview = Vec::new();
    image::DynamicImage::new_rgb8(300, 200)
        .write_to(&mut Cursor::new(&mut preview), image::ImageFormat::Jpeg)
        .unwrap();
    // Mostly sensor data, as a large RAW file is: the preview is at the front and the rest is a hole.
    let path = site.served.join("big.arw");
    fs::write(&path, camera_file(&preview)).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(okfs::thumb::MAX_FILE + 1)
        .unwrap();
    // A picture that is itself over the bound is still refused.
    fs::write(site.served.join("bigger.png"), b"x").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(site.served.join("bigger.png"))
        .unwrap()
        .set_len(okfs::thumb::MAX_FILE + 1)
        .unwrap();
    let app = site.router();

    for uri in ["/api/picture?path=big.arw", "/api/picture?path=big.arw&w=160"] {
        assert_eq!(get(&app, uri).await.0.status(), StatusCode::OK, "{uri}");
    }
    assert_eq!(
        get(&app, "/api/picture?path=bigger.png").await.0.status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
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
    let (_, first) = get(&app, "/api/picture?path=wide.png&w=160").await;
    assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
    let (_, second) = get(&app, "/api/picture?path=wide.png&w=160").await;
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

    let (response, first) = get(&app, "/api/picture?path=doc.pdf&w=600").await;
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
    assert_eq!(get(&kept, "/api/picture?path=doc.pdf&w=600").await.1, first);
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
        let (response, body) = get(&app, &format!("/api/picture?path={name}")).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT, "{name}");
        assert!(body.is_empty(), "{name}");
    }
    // Nothing is kept for a file that was refused, and a good file is still drawn.
    assert_eq!(fs::read_dir(&cache).unwrap().count(), 0);
    assert_eq!(get(&app, "/api/picture?path=doc.pdf").await.0.status(), StatusCode::OK);
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
    // Run once and ended at once, so the first start of a new program, which macOS checks and which can
    // take longer than the limit when the tests run together, is not the one that is timed.
    let mut first = std::process::Command::new(&stuck).spawn().unwrap();
    let started = (0..1000).any(|_| {
        std::thread::sleep(std::time::Duration::from_millis(10));
        mark.exists()
    });
    assert!(started, "the stand-in program never started");
    first.kill().unwrap();
    first.wait().unwrap();
    fs::remove_file(&mark).unwrap();
    let app = site.app(Options {
        cache: Some(site.outside.join("cache")),
        drawer: Some(stuck),
        pdf_limit: std::time::Duration::from_millis(300),
        ..Options::default()
    });

    let asked = std::time::Instant::now();
    let (response, _) = get(&app, "/api/picture?path=doc.pdf").await;
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
        get(&app, "/api/picture?path=doc.pdf").await.0.status(),
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
        let (response, body) = get(&app, &format!("/api/picture?path={path}")).await;
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
        get(&app, "/api/picture?path=doc.pdf").await.0.status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
}

#[tokio::test]
async fn text_previews_are_bounded() {
    let site = Site::new();
    let max = okfs::render::MAX_TEXT as usize;
    // Lines of ten bytes, past the limit: only whole lines from the start are shown, as source.
    fs::write(site.served.join("huge.md"), "# line 01\n".repeat(max / 10 + 100)).unwrap();
    // One line with no end, a two-byte character astride the limit.
    let mut one = vec![b'a'; max - 1];
    one.extend("é and more".as_bytes());
    fs::write(site.served.join("one.txt"), one).unwrap();
    // A binary file is told as binary whatever its size.
    let mut big = vec![0u8; 16];
    big.resize(max + 1, b'x');
    fs::write(site.served.join("big.bin"), big).unwrap();
    fs::write(site.served.join("blob.bin"), [0u8, 159, 146, 150, 0, 1, 2]).unwrap();
    fs::write(site.served.join("table.csv"), "name,n\n\"a, b\",1\nc,2\n").unwrap();
    fs::write(site.served.join("data.json"), "{\"a\": [1, 2]}").unwrap();
    let app = site.router();

    let large = preview(&app, "huge.md", "").await;
    assert_eq!(
        (large["kind"].as_str(), large["cut"].as_bool()),
        (Some("code"), Some(true))
    );
    assert_eq!(large["lines"], max / 10);
    let html = large["html"].as_str().unwrap();
    assert!(html.ends_with("# line 01</span>"));
    // The start of a cut file says nothing of more, so the whole of it is not asked for again.
    let start = preview(&app, "huge.md", "&lines=80").await;
    assert_eq!(
        (start["more"].as_bool(), start["cut"].as_bool()),
        (Some(true), Some(true))
    );
    assert!(large.get("more").is_none());

    let one = preview(&app, "one.txt", "").await;
    assert_eq!(one["cut"], true);
    assert!(!one["html"].as_str().unwrap().contains('\u{fffd}'));

    for path in ["blob.bin", "big.bin"] {
        let binary = preview(&app, path, "").await;
        assert_eq!(
            (binary["kind"].as_str(), binary["reason"].as_str()),
            (Some("none"), Some("binary")),
            "{path}"
        );
    }

    let code = preview(&app, "sub/deep/c.rs", "").await;
    assert_eq!(code["kind"], "code");
    assert!(code["html"].as_str().unwrap().contains("tk-k"));
    let table = preview(&app, "table.csv", "").await;
    assert_eq!(table["head"], serde_json::json!(["name", "n"]));
    assert_eq!(table["rows"], serde_json::json!([["a, b", "1"], ["c", "2"]]));
    assert_eq!(table["numeric"], serde_json::json!([false, true]));
    assert_eq!(preview(&app, "data.json", "").await["kind"], "json");
}

#[tokio::test]
async fn the_start_of_a_source_file_can_be_asked_for_alone() {
    let site = Site::new();
    let app = site.router();
    fs::write(site.served.join("long.rs"), "fn a() {}\n".repeat(200)).unwrap();
    fs::write(site.served.join("short.rs"), "fn a() {}\nfn b() {}\n").unwrap();

    // The first lines only, colored, with the count of all of them and a note that there is more.
    let start = preview(&app, "long.rs", "&lines=80").await;
    assert_eq!(
        (start["kind"].as_str(), start["lines"].as_u64()),
        (Some("code"), Some(200))
    );
    assert_eq!(start["more"], true);
    let html = start["html"].as_str().unwrap();
    assert_eq!(html.matches("class=\"ln\"").count(), 80);
    assert!(html.contains("tk-k"));
    // Without the limit the whole file comes, and says nothing of more.
    let whole = preview(&app, "long.rs", "").await;
    assert_eq!(whole["html"].as_str().unwrap().matches("class=\"ln\"").count(), 200);
    assert!(whole.get("more").is_none());

    // A file shorter than the limit is whole already.
    let short = preview(&app, "short.rs", "&lines=80").await;
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
    assert_eq!(many["long.rs"], preview(&app, "long.rs", "&lines=80").await);
    assert_eq!(many["sub/deep/c.rs"], preview(&app, "sub/deep/c.rs", "").await);
    assert_eq!(many["data.json"]["kind"], "json");

    // With `raw=1` each is as it is written: a table is code, not rows.
    let raw = json(&app, "/api/previews?lines=80&raw=1&p=data.json").await;
    assert_eq!(raw["data.json"]["kind"], "code");

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

    let (_, gruvbox) = get(&app, "/assets/themes/gruvbox.css").await;
    assert!(String::from_utf8(gruvbox).unwrap().contains("--bg: #fbf1c7;"));
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
    let mut expected = vec![
        "a.txt",
        "file10.txt",
        "file2.txt",
        "sub/",
        "sub/b.txt",
        "sub/deep/",
        "sub/deep/c.rs",
    ];
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
async fn a_folders_zip_is_named_after_the_folder() {
    let site = Site::new();
    fs::create_dir(site.served.join("fotos día")).unwrap();
    fs::create_dir(site.served.join("it's; (1)")).unwrap();
    let app = site.router();
    let named = async |uri: &str| {
        let (response, _) = get(&app, uri).await;
        response.headers()[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .to_owned()
    };
    assert_eq!(
        named("/zip/sub").await,
        "attachment; filename=\"sub.zip\"; filename*=UTF-8''sub.zip"
    );
    // The served folder itself is named after its own folder on disk.
    assert_eq!(
        named("/zip/").await,
        "attachment; filename=\"served.zip\"; filename*=UTF-8''served.zip"
    );
    assert_eq!(
        named("/zip/fotos%20d%C3%ADa").await,
        "attachment; filename=\"fotos da.zip\"; filename*=UTF-8''fotos%20d%C3%ADa.zip"
    );
    // A `;` or `'` left as it is would end the name early.
    assert_eq!(
        named("/zip/it's%3B%20(1)").await,
        "attachment; filename=\"its 1.zip\"; filename*=UTF-8''it%27s%3B%20%281%29.zip"
    );
}

#[tokio::test]
async fn a_zip_keeps_each_files_and_folders_time() {
    let site = Site::new();
    // 2021-06-15 10:30:43 UTC, and a folder a day earlier.
    let (file_time, folder_time) = (1_623_753_043, 1_623_666_643);
    written_at(site.served.join("sub/b.txt"), file_time);
    written_at(site.served.join("sub/deep"), folder_time);
    let (_, body) = get(&site.router(), "/zip/").await;

    let mut archive = zip::ZipArchive::new(Cursor::new(body)).unwrap();
    for (name, seconds) in [("sub/b.txt", file_time), ("sub/deep/", folder_time)] {
        let entry = archive.by_name(name).unwrap();
        // To the second in UTC, in the field unzip tools read first.
        let exact = entry.extra_data_fields().find_map(|field| match field {
            zip::extra_fields::ExtraField::ExtendedTimestamp(time) => time.mod_time(),
            _ => None,
        });
        assert_eq!(exact, Some(seconds as u32), "{name}");
        // In local time, to two seconds, in the zip format's own field, for the tools that read only it.
        let local = jiff::Timestamp::from_second(seconds as i64)
            .unwrap()
            .to_zoned(jiff::tz::TimeZone::system())
            .datetime();
        let dos = entry.last_modified().unwrap();
        let fields = |t: &jiff::civil::DateTime| {
            (
                t.year() as u16,
                t.month() as u8,
                t.day() as u8,
                t.hour() as u8,
                t.minute() as u8,
                t.second() as u8 / 2 * 2,
            )
        };
        let dos = (
            dos.year(),
            dos.month(),
            dos.day(),
            dos.hour(),
            dos.minute(),
            dos.second(),
        );
        assert_eq!(dos, fields(&local), "{name}");
    }
}

#[tokio::test]
async fn a_files_page_address_answers_with_the_file_to_anything_but_a_browser() {
    let site = Site::new();
    fs::create_dir_all(site.served.join("api")).unwrap();
    fs::write(site.served.join("api/notes.md"), "# notes").unwrap();
    let app = site.router();

    // curl and wget send */*; a request may send no Accept at all.
    for accept in [Some("*/*"), None, Some("text/html;q=0, */*")] {
        for (uri, bytes) in [("/sub/b.txt", &b"inside"[..]), ("/-/api/notes.md", b"# notes")] {
            let mut request = Request::get(uri);
            if let Some(accept) = accept {
                request = request.header(header::ACCEPT, accept);
            }
            let (response, body) = send(&app, request.body(Body::empty()).unwrap()).await;
            assert_eq!(response.status(), StatusCode::OK, "{uri} {accept:?}");
            assert_eq!(body, bytes, "{uri} {accept:?}");
            assert_eq!(response.headers()[header::VARY], "accept", "{uri}");
        }
    }
    // As /raw/ does, with ranges.
    let request = Request::get("/a.txt").header(header::RANGE, "bytes=2-4");
    let (response, body) = send(&app, request.body(Body::empty()).unwrap()).await;
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(body, b"234");

    // A browser gets the page, and a folder is the page whatever is asked.
    let (response, body) = browse(&app, "/sub/b.txt").await;
    assert!(
        response.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );
    assert_eq!(response.headers()[header::VARY], "accept");
    assert!(String::from_utf8_lossy(&body).contains("okfs-config"));
    let (response, body) = get(&app, "/sub/").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(String::from_utf8_lossy(&body).contains("okfs-config"));

    // Nothing more is reached this way than through /raw/.
    for uri in ["/.hidden", "/link-out.txt", "/link-out-dir/secret.txt"] {
        let (response, body) = get(&app, uri).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
        assert!(!String::from_utf8_lossy(&body).contains(SECRET), "{uri}");
    }
}

#[tokio::test]
async fn a_yes_or_no_in_a_query_is_one_true_zero_or_false() {
    let site = Site::new();
    fs::create_dir_all(site.served.join("node_modules/pkg")).unwrap();
    let app = site.router();
    for (all, shown) in [
        ("", false),
        ("&all=0", false),
        ("&all=false", false),
        ("&all=1", true),
        ("&all=true", true),
    ] {
        let listing = json(&app, &format!("/api/list?path={all}")).await;
        assert_eq!(names(&listing).contains(&"node_modules"), shown, "{all}");
    }
    for uri in [
        "/api/list?path=&all=yes",
        "/api/search?q=a&rev=2",
        "/api/recent?all=on",
        "/api/previews?p=a.txt&raw=x",
    ] {
        assert_eq!(get(&app, uri).await.0.status(), StatusCode::BAD_REQUEST, "{uri}");
    }
    fs::write(site.served.join("table.csv"), "a,b\n1,2\n").unwrap();
    assert_eq!(preview(&app, "table.csv", "&raw=0").await["kind"], "table");
    assert_eq!(preview(&app, "table.csv", "&raw=true").await["kind"], "code");
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
    assert_eq!(
        config(&body)["themes"].as_array().unwrap().len(),
        okfs::theme::BUILT_IN.len()
    );

    let (_, body) = browse(&app, "/sub/b.txt").await;
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
    let index = Index::spawn(root.clone(), Follow::Watch);
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
    let index = Index::spawn(root.clone(), Follow::Watch);
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
async fn search_hands_back_any_page_of_the_matches_in_the_order_asked_with_their_times_and_sizes() {
    let site = Site::new();
    let root = Root::new(&site.served, false).unwrap();
    let index = Index::spawn(root.clone(), Follow::Watch);
    let app = router(App::new(root, Arc::clone(&index), Options::default()).unwrap());
    for _ in 0..200 {
        if json(&app, "/api/search?q=txt").await["ready"] == true {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let paths = |found: &Value| -> Vec<String> {
        let hits = found["hits"].as_array().unwrap();
        hits.iter()
            .map(|hit| hit["path"].as_str().unwrap().to_owned())
            .collect()
    };

    // Largest first; a link has no size of its own, and comes last.
    let by_size = json(&app, "/api/search?q=.txt&sort=size").await;
    let all = paths(&by_size);
    assert_eq!(all[..2], ["a.txt", "sub/b.txt"]);
    assert_eq!(by_size["hits"][0]["s"], 20);
    assert!(by_size["hits"][0]["m"].as_u64().unwrap() > 0);
    // The next page starts where the last one ended, and the total is the same on each.
    let second = json(&app, "/api/search?q=.txt&sort=size&offset=1&limit=2").await;
    assert_eq!(paths(&second), all[1..3]);
    assert_eq!(second["total"], by_size["total"]);
    let turned = json(&app, "/api/search?q=.txt&sort=size&rev=1").await;
    assert_eq!(paths(&turned).last().unwrap(), "a.txt");
    // A folder tells how many entries its listing shows, and has no size or time.
    let sub = json(&app, "/api/search?q=sub").await;
    assert_eq!(sub["hits"][0]["path"], "sub");
    assert_eq!(
        (sub["hits"][0]["c"].clone(), sub["hits"][0]["s"].clone()),
        (Value::from(2), Value::from(0))
    );
    // An order the server does not know is refused.
    let (refused, _) = get(&app, "/api/search?q=txt&sort=colour").await;
    assert_eq!(refused.status(), 400);
}

#[tokio::test]
async fn a_folder_left_out_of_the_search_still_opens_and_lists_its_files() {
    let site = Site::new();
    for dir in ["dist/deep", "app/node_modules/pad"] {
        fs::create_dir_all(site.served.join(dir)).unwrap();
    }
    for file in [
        "dist/bundle.js",
        "dist/deep/chunk.js",
        "app/main.rs",
        "app/node_modules/pad/index.js",
    ] {
        fs::write(site.served.join(file), "x").unwrap();
    }
    fs::write(site.served.join(".gitignore"), "dist\n").unwrap();
    let root = Root::new(&site.served, false).unwrap();
    let index = Index::spawn(root.clone(), Follow::Watch);
    let app = router(App::new(root, Arc::clone(&index), Options::default()).unwrap());
    let wait_for = |query: &'static str, want: usize| {
        let app = app.clone();
        async move {
            for _ in 0..200 {
                let result = json(&app, &format!("/api/search?q={query}")).await;
                if result["ready"] == true && result["total"] == want {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            panic!("the index never showed {want} matches for {query}");
        }
    };
    let names = |listing: &Value| -> Vec<String> {
        let entries = listing["entries"].as_array().unwrap();
        let mut names: Vec<String> = entries
            .iter()
            .map(|entry| entry["n"].as_str().unwrap().to_owned())
            .collect();
        names.sort();
        names
    };

    wait_for("main.rs", 1).await;
    // The folders left out are hidden from the search as they are from a listing, until hidden entries are asked for.
    assert_eq!(json(&app, "/api/search?q=dist").await["total"], 0);
    assert_eq!(json(&app, "/api/search?q=dist&all=1").await["hits"][0]["path"], "dist");
    wait_for("bundle", 0).await;
    wait_for("chunk", 0).await;
    wait_for("index.js", 0).await;

    // Left out of the search, hidden from its folder's listing until hidden entries are asked for, and open as
    // ever: the same listing, counts and files as any folder.
    let top = json(&app, "/api/list?path=").await;
    assert!(!names(&top).contains(&"dist".to_owned()));
    assert_eq!(top["hidden"], 1);
    let app_folder = json(&app, "/api/list?path=app").await;
    assert_eq!(names(&app_folder), ["main.rs"]);
    let top = json(&app, "/api/list?path=&all=1").await;
    assert!(top.get("hidden").is_none());
    let dist = top["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["n"] == "dist")
        .unwrap();
    assert_eq!((dist["d"].as_bool(), dist["c"].as_u64()), (Some(true), Some(2)));
    assert_eq!(names(&json(&app, "/api/list?path=dist").await), ["bundle.js", "deep"]);
    assert_eq!(names(&json(&app, "/api/list?path=dist/deep").await), ["chunk.js"]);
    assert_eq!(
        names(&json(&app, "/api/list?path=app/node_modules/pad").await),
        ["index.js"]
    );
    assert_eq!(get(&app, "/raw/dist/deep/chunk.js").await.1, b"x");

    // What changes in them is not taken into the index. Once a file beside them is, the watcher has read
    // the change before it, so the one in the folder left out would be there by now if it were held.
    fs::write(site.served.join("dist/late.js"), "late").unwrap();
    fs::write(site.served.join("app/node_modules/pad/late.js"), "late").unwrap();
    fs::write(site.served.join("app/after.rs"), "after").unwrap();
    wait_for("after.rs", 1).await;
    wait_for("late", 0).await;
    assert_eq!(
        names(&json(&app, "/api/list?path=dist").await),
        ["bundle.js", "deep", "late.js"]
    );
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

    // With --hidden the dotfile shows once hidden entries are asked for. A file behind a link that leaves the
    // folder still does not.
    let app = site.serving(true, Options::default());
    assert_eq!(recent_paths(&json(&app, "/api/recent").await), want);
    let answer = json(&app, "/api/recent?all=1").await;
    let shown = recent_paths(&answer);
    assert_eq!(shown[0], ".hidden");
    assert!(
        shown
            .iter()
            .all(|path| !path.contains("link-out") && !path.contains("secret"))
    );
    assert!(!String::from_utf8_lossy(&get(&app, "/api/recent?all=1").await.1).contains("TOP SECRET"));
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
    let index = Index::spawn(root.clone(), Follow::Watch);
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
    let index = Index::spawn(root.clone(), Follow::Watch);
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
            let (page, _) = browse(&app, uri).await;
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

#[tokio::test]
async fn a_listing_sends_the_levels_under_its_first_entry_only_as_deep_as_allowed() {
    let site = Site::new();
    fs::create_dir_all(site.served.join("top/one/two/three/four/five")).unwrap();
    fs::write(site.served.join("top/zz.txt"), "beside the folder").unwrap();
    let app = site.router();

    let asked = json(&app, "/api/list?path=top&limit=5&depth=2").await;
    assert_eq!(names(&asked), ["one", "zz.txt"]);
    assert_eq!(asked["under"]["path"], "top/one");
    assert_eq!(asked["under"]["under"]["path"], "top/one/two");
    assert_eq!(names(&asked["under"]["under"]), ["three"]);
    assert!(asked["under"]["under"].get("under").is_none());

    // However many levels are asked for, three come.
    let greedy = json(&app, "/api/list?path=top&limit=5&depth=99").await;
    assert_eq!(greedy["under"]["under"]["under"]["path"], "top/one/two/three");
    assert!(greedy["under"]["under"]["under"].get("under").is_none());

    // No levels unless they are asked for, and none with a whole listing.
    for uri in ["/api/list?path=top&limit=5", "/api/list?path=top&depth=2"] {
        assert!(json(&app, uri).await.get("under").is_none(), "{uri}");
    }
}

#[tokio::test]
async fn a_listing_with_levels_is_bounded_in_entries_and_carries_no_file() {
    let site = Site::new();
    let wide = site.served.join("wide");
    fs::create_dir_all(wide.join("0-first")).unwrap();
    for at in 0..250 {
        fs::write(wide.join(format!("file{at}.txt")), "x").unwrap();
    }
    fs::create_dir_all(site.served.join("small")).unwrap();
    fs::write(site.served.join("small/notes.txt"), "a line\n".repeat(200)).unwrap();
    let app = site.router();

    let column = json(&app, "/api/list?path=wide&limit=1000&depth=1").await;
    assert_eq!(column["entries"].as_array().unwrap().len(), 200);
    assert_eq!(column["total"], 251);
    // A limit alone is as it was: the page asks that way for other things.
    let plain = json(&app, "/api/list?path=wide&limit=1000").await;
    assert_eq!(plain["entries"].as_array().unwrap().len(), 251);

    // The columns of a folder are its names. No file in it is read for them: a file is
    // read when its preview is asked for, and the page asks only once the preview is open.
    let small = json(&app, "/api/list?path=small&limit=5&depth=1").await;
    assert_eq!(names(&small), ["notes.txt"]);
    assert!(small.get("start").is_none() && small.get("under").is_none());
}

#[tokio::test]
async fn a_file_shown_as_something_made_from_its_text_can_be_asked_for_as_its_source() {
    let site = Site::new();
    let app = site.router();
    fs::write(site.served.join("notes.md"), "# Title\n\nSome *text*.\n").unwrap();
    fs::write(site.served.join("table.csv"), "name,n\na,1\n").unwrap();
    fs::write(site.served.join("data.json"), "{\"a\": [1, 2]}\n").unwrap();
    fs::write(site.served.join("page.html"), "<h1>Hi</h1>\n<script>1</script>\n").unwrap();
    fs::write(
        site.served.join("shape.svg"),
        "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n",
    )
    .unwrap();

    for (name, shown, written) in [
        ("notes.md", "markdown", "# Title"),
        ("table.csv", "table", "name,n"),
        ("data.json", "json", "&quot;a&quot;"),
        ("page.html", "code", "&lt;h1&gt;Hi&lt;/h1&gt;"),
        ("shape.svg", "code", "&lt;svg"),
    ] {
        assert_eq!(preview(&app, name, "").await["kind"], shown);
        let source = preview(&app, name, "&raw=1").await;
        assert_eq!(source["kind"], "code", "{name}");
        // The text as it is written: its markup is escaped, never run, and nothing is left out.
        let html = source["html"].as_str().unwrap();
        let plain: String = strip_tags(html);
        assert!(plain.contains(written), "{name}: {plain}");
        assert!(!html.contains("<h1>") && !html.contains("<script>"), "{name}: {html}");
    }
    // The start alone, as for any source file.
    fs::write(site.served.join("long.md"), "a line\n".repeat(200)).unwrap();
    let start = preview(&app, "long.md", "&raw=1&lines=80").await;
    assert_eq!(
        (start["lines"].as_u64(), start["more"].as_bool()),
        (Some(200), Some(true))
    );
    // What is not text has no source either.
    fs::write(site.served.join("blob.bin"), [0_u8; 64]).unwrap();
    assert_eq!(preview(&app, "blob.bin", "&raw=1").await["kind"], "none");
}

/// Markup with its tags taken out: the text a reader sees.
fn strip_tags(html: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for c in html.chars() {
        match c {
            '<' => inside = true,
            '>' => inside = false,
            c if !inside => out.push(c),
            _ => {}
        }
    }
    out
}

#[tokio::test]
async fn a_listing_with_levels_follows_the_entries_named_and_falls_back_to_the_first() {
    let site = Site::new();
    for dir in ["p/node_modules/@babel", "p/src/components", "p/zeta"] {
        fs::create_dir_all(site.served.join(dir)).unwrap();
    }
    fs::write(site.served.join("p/src/components/Button.tsx"), "x").unwrap();
    fs::write(site.served.join("p/src/index.tsx"), "x").unwrap();
    let app = site.router();
    let path = |listing: &Value| listing["path"].as_str().unwrap().to_owned();

    // node_modules is hidden, so the first entry is src.
    let first = json(&app, "/api/list?path=p&limit=40&depth=2").await;
    assert_eq!(names(&first), ["src", "zeta"]);
    assert_eq!(
        (path(&first["under"]), path(&first["under"]["under"])),
        ("p/src".into(), "p/src/components".into())
    );
    // Named levels are followed in place of the first entry, and a level past them goes into its first.
    let zeta = json(&app, "/api/list?path=p&limit=40&depth=2&follow=zeta").await;
    assert_eq!(path(&zeta["under"]), "p/zeta");
    assert!(zeta["under"].get("under").is_none());
    // A file named, or a name that is not there, has no level of its own; the second goes into the first.
    let file = json(&app, "/api/list?path=p&limit=40&depth=2&follow=src/index.tsx").await;
    assert_eq!(path(&file["under"]), "p/src");
    assert!(file["under"].get("under").is_none());
    let missing = json(&app, "/api/list?path=p&limit=40&depth=2&follow=nothing").await;
    assert_eq!(path(&missing["under"]), "p/src");
    // A hidden folder is followed only when hidden entries are asked for, and is then the first entry.
    let hidden = json(&app, "/api/list?path=p&limit=40&depth=2&follow=node_modules").await;
    assert_eq!(path(&hidden["under"]), "p/src");
    let all = json(&app, "/api/list?path=p&limit=40&depth=2&all=1").await;
    assert_eq!(names(&all), ["node_modules", "src", "zeta"]);
    assert_eq!(path(&all["under"]["under"]), "p/node_modules/@babel");
}

#[tokio::test]
async fn hidden_entries_are_left_out_of_listings_and_counts_until_asked_for() {
    let site = Site::new();
    for dir in ["app/node_modules/pad", "app/dist", "app/.git", "app/src"] {
        fs::create_dir_all(site.served.join(dir)).unwrap();
    }
    for file in ["app/src/main.rs", "app/.env", "app/README.md"] {
        fs::write(site.served.join(file), "x").unwrap();
    }
    fs::write(
        site.served.join("app/.gitignore"),
        "dist
",
    )
    .unwrap();
    let count = |listing: &Value, name: &str| -> Option<u64> {
        let entries = listing["entries"].as_array().unwrap();
        entries
            .iter()
            .find(|entry| entry["n"] == name)
            .and_then(|entry| entry["c"].as_u64())
    };

    // Without --hidden, dotfiles are never sent. The folders left out are, when asked for.
    let app = site.router();
    let app_folder = json(&app, "/api/list?path=app").await;
    assert_eq!(names(&app_folder), ["README.md", "src"]);
    assert_eq!(
        (app_folder["total"].as_u64(), app_folder["hidden"].as_u64()),
        (Some(2), Some(2))
    );
    let top = json(&app, "/api/list?path=").await;
    assert_eq!(count(&top, "app"), Some(2));
    let app_entry = top["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["n"] == "app")
        .unwrap();
    assert_eq!(app_entry["h"], 2);
    let all = json(&app, "/api/list?path=app&all=1").await;
    assert_eq!(names(&all), ["dist", "node_modules", "README.md", "src"]);
    assert_eq!(count(&json(&app, "/api/list?path=&all=1").await, "app"), Some(4));
    assert!(!String::from_utf8_lossy(&get(&app, "/api/list?path=app&all=1").await.1).contains(".env"));

    // With --hidden, dotfiles are hidden the same way, and sent once asked for.
    let app = site.serving(true, Options::default());
    let app_folder = json(&app, "/api/list?path=app").await;
    assert_eq!(names(&app_folder), ["README.md", "src"]);
    assert_eq!(app_folder["hidden"], 5);
    let all = json(&app, "/api/list?path=app&all=1").await;
    assert_eq!(
        names(&all),
        [".env", ".git", ".gitignore", "dist", "node_modules", "README.md", "src"]
    );
    assert_eq!(count(&json(&app, "/api/list?path=").await, "app"), Some(2));
    assert_eq!(count(&json(&app, "/api/list?path=&all=1").await, "app"), Some(7));
    // A folder inside one that is hidden still lists what it holds, by its address.
    assert_eq!(names(&json(&app, "/api/list?path=app/node_modules").await), ["pad"]);
}

#[cfg(unix)]
#[tokio::test]
async fn a_listing_with_levels_reads_nothing_outside_the_served_folder() {
    use std::os::unix::fs::symlink;
    let site = Site::new();
    let lead = site.served.join("lead");
    fs::create_dir_all(&lead).unwrap();
    symlink(&site.outside, lead.join("a-out")).unwrap();
    symlink(site.outside.join("secret.txt"), lead.join("b-out.txt")).unwrap();
    fs::create_dir_all(lead.join(".hidden-dir")).unwrap();
    fs::write(lead.join(".hidden-dir/secret.txt"), SECRET).unwrap();
    let app = site.router();

    for path in [
        "../outside",
        "..",
        "link-out-dir",
        "lead/a-out",
        "lead/.hidden-dir",
        "/etc",
    ] {
        let uri = format!("/api/list?path={path}&limit=5&depth=3");
        assert_eq!(get(&app, &uri).await.0.status(), StatusCode::NOT_FOUND, "{uri}");
    }
    // The links out and the hidden folder are not entries, so no level is under them.
    for path in ["", "lead"] {
        let (response, body) = get(&app, &format!("/api/list?path={path}&limit=50&depth=3")).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = String::from_utf8(body).unwrap();
        assert!(!body.contains(SECRET) && !body.contains("secret"), "{body}");
    }
    let lead = json(&app, "/api/list?path=lead&limit=50&depth=3").await;
    assert!(names(&lead).is_empty());
    assert!(lead.get("under").is_none());
}

/// The key the tests below run okfs with.
const KEY: &str = "Zm9vYmFyYmF6cXV4cXV1eA";

/// Asking for the key, as okfs does at an address beyond loopback.
fn keyed(site: &Site, options: Options) -> axum::Router {
    site.app(Options {
        key: Some(Key::of(KEY)),
        check_host: true,
        ..options
    })
}

/// A request on the address the page is opened at, with these headers.
fn on_home(method: &str, uri: &str, headers: Headers) -> Request<Body> {
    let mut request = Request::builder().method(method).uri(uri).header(header::HOST, HOME);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    request.body(Body::empty()).unwrap()
}

/// What a browser sends when it goes to an address.
const NAVIGATE: Headers = &[("accept", BROWSER_ACCEPT), ("sec-fetch-mode", "navigate")];

/// The cookie a browser holds after its first visit at `HOME`.
const COOKIE: (&str, &str) = ("cookie", "okfs-key-8080=Zm9vYmFyYmF6cXV4cXV1eA");

#[tokio::test]
async fn with_a_key_every_route_is_refused_without_it_and_says_nothing_of_the_folder() {
    let site = Site::new();
    let app = keyed(
        &site,
        Options {
            allow_delete: true,
            ..Options::default()
        },
    );
    let before = snapshot(&site.served);
    let routes = [
        ("GET", "/"),
        ("GET", "/-/"),
        ("GET", "/sub/"),
        ("GET", "/a.txt"),
        ("HEAD", "/a.txt"),
        ("GET", "/raw/a.txt"),
        ("GET", "/raw/"),
        ("GET", "/zip/"),
        ("GET", "/zip/sub"),
        ("GET", "/api/list?path="),
        ("GET", "/api/previews?p=a.txt"),
        ("GET", "/api/search?q=a"),
        ("GET", "/api/recent"),
        ("GET", "/api/archive?path=a.txt"),
        ("GET", "/api/picture?path=a.txt"),
        ("GET", "/api/events"),
        ("GET", "/api/frame/a.txt"),
        ("GET", "/theme.css"),
        ("GET", "/assets/app.css"),
        ("GET", "/assets/main.js"),
        ("DELETE", "/api/entry?path=a.txt"),
        ("POST", "/a.txt"),
    ];
    let cookie = |value: &'static str| ("cookie", value);
    for (method, uri) in routes {
        let joined = if uri.contains('?') { '&' } else { '?' };
        let wrong = format!("{uri}{joined}key=Zm9vYmFyYmF6cXV4cXV1ey");
        let delete: Headers = &[("x-okfs", "delete"), ("origin", "http://localhost:8080")];
        let asks = [
            on_home(method, uri, delete),
            on_home(method, &wrong, delete),
            on_home(method, &wrong, NAVIGATE),
            on_home(
                method,
                uri,
                &[cookie("okfs-key-8080=Zm9vYmFyYmF6cXV4cXV1ey"), delete[0], delete[1]],
            ),
            // The cookie of another port is not this one's.
            on_home(
                method,
                uri,
                &[cookie("okfs-key-9000=Zm9vYmFyYmF6cXV4cXV1eA"), delete[0], delete[1]],
            ),
            on_home(method, uri, NAVIGATE),
        ];
        for request in asks {
            let shown = format!("{method} {}", request.uri());
            let (response, body) = send(&app, request).await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{shown}");
            assert_eq!(response.headers()[header::WWW_AUTHENTICATE], "okfs-key", "{shown}");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store", "{shown}");
            assert!(!response.headers().contains_key(header::SET_COOKIE), "{shown}");
            let body = String::from_utf8_lossy(&body);
            for told in ["a.txt", "sub", "served", "okfs-config", KEY] {
                assert!(!body.contains(told), "{shown} tells {told}: {body}");
            }
            assert!(method == "HEAD" || body.contains("needs its key"), "{shown}: {body}");
        }
    }
    assert_eq!(snapshot(&site.served), before);

    // A browser is shown a page, anything else a line.
    let (response, _) = send(&app, on_home("GET", "/", NAVIGATE)).await;
    assert!(
        response.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );
    let (response, _) = send(&app, on_home("GET", "/raw/a.txt", &[])).await;
    assert!(
        response.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/plain")
    );
    // A host okfs does not answer to is refused before the key is looked at.
    let request = Request::get(format!("/raw/a.txt?key={KEY}"))
        .header(header::HOST, "evil.example")
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(&app, request).await.0.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn with_a_key_a_page_in_the_preview_reads_its_own_folder_with_a_pass_and_nothing_else() {
    let site = Site::new();
    fs::create_dir_all(site.served.join("reports/img")).unwrap();
    let page = "<img src=img/shot.png><script>fetch('/api/list?path=')</script>";
    fs::write(site.served.join("reports/x.html"), page).unwrap();
    fs::write(site.served.join("reports/img/shot.png"), "png").unwrap();
    fs::write(site.served.join("reports/y.html"), "next page").unwrap();
    fs::write(site.served.join("reports/.notes"), SECRET).unwrap();
    let app = keyed(
        &site,
        Options {
            allow_upload: true,
            allow_edit: true,
            allow_delete: true,
            ..Options::default()
        },
    );
    let before = snapshot(&site.served);

    // The page frames the file with its cookie, and is sent on to the address with its folder's pass.
    let (frame, _) = send(&app, on_home("GET", "/api/frame/reports/x.html", &[COOKIE])).await;
    assert_eq!(frame.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(frame.headers()[header::CACHE_CONTROL], "no-store");
    let to = frame.headers()[header::LOCATION].to_str().unwrap().to_owned();
    assert!(!to.contains(KEY), "{to}");
    let folder = to.strip_suffix("x.html").unwrap();
    let top = folder.strip_suffix("reports/").unwrap();
    assert!(
        top.starts_with("/api/view/") && top.len() == "/api/view/".len() + 23,
        "{to}"
    );

    // A sandboxed page sends no cookie. It loads with the pass, sandboxed in an origin of its own, and so
    // does what is beside it and below it.
    for (uri, bytes) in [
        (to.clone(), page),
        (format!("{folder}img/shot.png"), "png"),
        (format!("{folder}y.html"), "next page"),
    ] {
        let (response, body) = send(&app, on_home("GET", &uri, &[])).await;
        assert_eq!(response.status(), StatusCode::OK, "{uri}");
        assert_eq!(body, bytes.as_bytes(), "{uri}");
        assert!(!response.headers().contains_key(header::SET_COOKIE), "{uri}");
        assert!(
            !response.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            "{uri}"
        );
        if uri.ends_with(".html") {
            let policy = response.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
            assert!(
                policy.starts_with("sandbox") && !policy.contains("allow-same-origin"),
                "{policy}"
            );
        }
    }

    // The pass reads nothing above its folder or beside it, no dotfile, and no link that leaves.
    let outside = [
        format!("{top}a.txt"),
        format!("{top}sub/b.txt"),
        format!("{top}link-out.txt"),
        format!("{top}.hidden"),
        format!("{folder}.notes"),
        format!("{folder}../a.txt"),
        format!("{folder}%2E%2E/a.txt"),
        format!("{top}reports"),
        format!("{top}reports/"),
        "/api/view/AAAAAAAAAAAAAAAAAAAAAA/reports/x.html".to_owned(),
        format!("/api/view/{KEY}/reports/x.html"),
    ];
    for uri in &outside {
        let (response, body) = send(&app, on_home("GET", uri, &[])).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
        assert!(!String::from_utf8_lossy(&body).contains(SECRET), "{uri}");
    }

    // It is no key: the API, the page, the files under /raw/ and the frame route still ask for the key.
    let pass = &top["/api/view/".len()..top.len() - 1];
    for uri in [
        "/api/list?path=".to_owned(),
        format!("/api/list?path=&key={pass}"),
        "/raw/reports/img/shot.png".to_owned(),
        "/reports/x.html".to_owned(),
        "/api/frame/reports/x.html".to_owned(),
    ] {
        let (response, _) = send(&app, on_home("GET", &uri, &[])).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{uri}");
    }
    // And it writes nothing.
    let write: Headers = &[("x-okfs", "write"), ("origin", "http://localhost:8080")];
    for method in ["PUT", "POST", "DELETE"] {
        let (response, _) = send(&app, on_home(method, &format!("{folder}y.html"), write)).await;
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED, "{method}");
    }
    assert_eq!(snapshot(&site.served), before);
}

#[tokio::test]
async fn without_a_key_a_page_in_the_preview_is_framed_from_raw() {
    let site = Site::new();
    fs::write(site.served.join("sub/page.html"), "<p>hi</p>").unwrap();
    let app = site.router();
    let (frame, _) = get(&app, "/api/frame/sub/page.html").await;
    assert_eq!(frame.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(frame.headers()[header::LOCATION], "/raw/sub/page.html");
    for uri in [
        "/api/frame/sub/",
        "/api/frame/nope.html",
        "/api/frame/link-out.txt",
        "/api/frame/.hidden",
    ] {
        assert_eq!(get(&app, uri).await.0.status(), StatusCode::NOT_FOUND, "{uri}");
    }
}

#[tokio::test]
async fn a_browser_trades_the_key_in_its_address_for_a_cookie() {
    let site = Site::new();
    let app = keyed(&site, Options::default());
    let (response, body) = send(
        &app,
        on_home("GET", &format!("/sub/?find=b&key={KEY}&theme=gruvbox"), NAVIGATE),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let set = response.headers()[header::SET_COOKIE].to_str().unwrap();
    assert_eq!(set, format!("okfs-key-8080={KEY}; Path=/; HttpOnly; SameSite=Strict"));
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
    // The page goes on to the same address without the key, by a step of its own, which the
    // SameSite=Strict cookie goes with even after a link from another site.
    let body = String::from_utf8_lossy(&body);
    assert!(
        body.contains(r#"<meta http-equiv="refresh" content="0; url=/sub/?find=b&amp;theme=gruvbox">"#),
        "{body}"
    );
    assert!(!body.contains(KEY), "{body}");

    // With the cookie, everything answers, and the page knows the key for the links it hands out.
    let (response, body) = send(
        &app,
        on_home("GET", "/sub/?find=b&theme=gruvbox", &[NAVIGATE[0], COOKIE]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(String::from_utf8_lossy(&body).contains(&format!("\"key\":\"{KEY}\"")));
    for uri in [
        "/raw/sub/b.txt",
        "/api/list?path=sub",
        "/api/events",
        "/assets/app.css",
        "/theme.css",
    ] {
        let response = app.clone().oneshot(on_home("GET", uri, &[COOKIE])).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{uri}");
    }

    // Behind a proxy that ends TLS and says so, the cookie never travels over plain http.
    let (response, _) = send(
        &app,
        on_home(
            "GET",
            &format!("/?key={KEY}"),
            &[NAVIGATE[0], NAVIGATE[1], ("x-forwarded-proto", "https")],
        ),
    )
    .await;
    assert!(
        response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .ends_with("; SameSite=Strict; Secure")
    );

    // A browser too old to say it navigates still asks for a page.
    let (response, _) = send(&app, on_home("GET", &format!("/a.txt?key={KEY}"), &[NAVIGATE[0]])).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().contains_key(header::SET_COOKIE));

    // An old link, with a key from an earlier start, still opens for a browser that holds this one.
    let old = "/sub/?key=b2xkb2xkb2xkb2xkb2xkb2xkbw";
    let (response, body) = send(&app, on_home("GET", old, &[NAVIGATE[0], NAVIGATE[1], COOKIE])).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    assert!(String::from_utf8_lossy(&body).contains("url=/sub/\""));
}

/// Asking for the key, with a one-time code for the browser okfs opens itself.
fn keyed_once(site: &Site, once: &Arc<Once>) -> axum::Router {
    keyed(
        site,
        Options {
            once: Some(Arc::clone(once)),
            ..Options::default()
        },
    )
}

#[tokio::test]
async fn a_one_time_code_is_traded_for_the_cookie_once_and_never_again() {
    let site = Site::new();
    let once = Arc::new(Once::new(ONCE_LIFE).unwrap());
    let app = keyed_once(&site, &once);
    let code = once.as_str().to_owned();

    // A wrong code spends nothing and lets nothing in.
    let (response, _) = send(&app, on_home("GET", "/?once=Zm9vYmFyYmF6cXV4cXV1ey", NAVIGATE)).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let (response, body) = send(
        &app,
        on_home("GET", &format!("/sub/?once={code}&theme=gruvbox"), NAVIGATE),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let set = response.headers()[header::SET_COOKIE].to_str().unwrap();
    assert_eq!(set, format!("okfs-key-8080={KEY}; Path=/; HttpOnly; SameSite=Strict"));
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
    let body = String::from_utf8_lossy(&body);
    assert!(
        body.contains(r#"<meta http-equiv="refresh" content="0; url=/sub/?theme=gruvbox">"#),
        "{body}"
    );
    assert!(!body.contains(KEY) && !body.contains(&code), "{body}");

    // Spent: the same code, by a browser or anything else, is refused like no key at all.
    for headers in [NAVIGATE, &[]] {
        for uri in [format!("/?once={code}"), format!("/raw/a.txt?once={code}")] {
            let (response, body) = send(&app, on_home("GET", &uri, headers)).await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{uri}");
            assert!(!response.headers().contains_key(header::SET_COOKIE), "{uri}");
            assert!(!String::from_utf8_lossy(&body).contains(KEY), "{uri}");
        }
    }
    // The key and the cookie it handed over still work.
    let response = app
        .clone()
        .oneshot(on_home("GET", "/raw/sub/b.txt", &[COOKIE]))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let (response, _) = send(&app, on_home("GET", &format!("/raw/sub/b.txt?key={KEY}"), &[])).await;
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn a_one_time_code_lets_in_only_the_request_that_spends_it() {
    let site = Site::new();
    let once = Arc::new(Once::new(ONCE_LIFE).unwrap());
    let app = keyed_once(&site, &once);
    // Not a browser: it gets the cookie and the step on, never the file it asked for.
    let (response, body) = send(
        &app,
        on_home("GET", &format!("/raw/sub/b.txt?once={}", once.as_str()), &[]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().contains_key(header::SET_COOKIE));
    let body = String::from_utf8_lossy(&body);
    assert!(body.contains("url=/raw/sub/b.txt\""), "{body}");
    assert!(!body.contains(&fs::read_to_string(site.served.join("sub/b.txt")).unwrap()));
    let (response, _) = send(&app, on_home("GET", &format!("/?once={}", once.as_str()), NAVIGATE)).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_one_time_code_dies_unspent_after_its_life() {
    let site = Site::new();
    let once = Arc::new(Once::new(std::time::Duration::from_millis(50)).unwrap());
    let app = keyed_once(&site, &once);
    std::thread::sleep(std::time::Duration::from_millis(60));
    let (response, body) = send(&app, on_home("GET", &format!("/?once={}", once.as_str()), NAVIGATE)).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    assert!(String::from_utf8_lossy(&body).contains("needs its key"));
}

#[tokio::test]
async fn without_a_key_a_code_means_nothing() {
    let site = Site::new();
    let once = Arc::new(Once::new(ONCE_LIFE).unwrap());
    // Only okfs with a key makes a code, but one given without a key opens nothing more.
    let app = site.app(Options {
        once: Some(Arc::clone(&once)),
        check_host: true,
        ..Options::default()
    });
    let (response, _) = send(&app, on_home("GET", "/raw/sub/b.txt", &[])).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key(header::SET_COOKIE));
}

#[tokio::test]
async fn the_step_that_takes_the_key_out_never_leads_to_another_host() {
    let site = Site::new();
    let app = keyed(&site, Options::default());
    for (asked, to) in [
        (format!("//evil.example/?key={KEY}"), "url=/evil.example/\""),
        (format!("/%2F%2Fevil.example?key={KEY}"), "url=/%2F%2Fevil.example\""),
        (format!("/?key={KEY}&next=%22%3E"), "url=/?next=%22%3E\""),
    ] {
        let (response, body) = send(&app, on_home("GET", &asked, NAVIGATE)).await;
        assert_eq!(response.status(), StatusCode::OK, "{asked}");
        let body = String::from_utf8_lossy(&body);
        assert!(body.contains(to), "{asked}: {body}");
    }
}

#[tokio::test]
async fn curl_brings_the_key_in_the_address_and_gets_the_answer_itself() {
    let site = Site::new();
    let app = keyed(&site, Options::default());
    for (uri, want) in [
        (format!("/a.txt?key={KEY}"), "0123456789abcdefghij"),
        (format!("/raw/a.txt?key={KEY}"), "0123456789abcdefghij"),
        (format!("/-/sub/b.txt?key={KEY}"), "inside"),
    ] {
        let (response, body) = send(&app, on_home("GET", &uri, &[("accept", "*/*")])).await;
        assert_eq!(response.status(), StatusCode::OK, "{uri}");
        assert!(!response.headers().contains_key(header::SET_COOKIE), "{uri}");
        assert_eq!(String::from_utf8_lossy(&body), want, "{uri}");
    }
    let (response, body) = send(
        &app,
        on_home("GET", &format!("/raw/a.txt?key={KEY}"), &[("range", "bytes=2-4")]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(body, b"234");

    let curl = |uri: String| send(&app, on_home("GET", &uri, &[("accept", "*/*")]));
    let (_, body) = curl(format!("/api/list?path=sub&key={KEY}")).await;
    let listing: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(names(&listing), ["b.txt", "deep"]);
    let (_, body) = curl(format!("/api/previews?p=a.txt&key={KEY}")).await;
    let previews: Value = serde_json::from_slice(&body).unwrap();
    assert!(previews.get("a.txt").is_some(), "{previews}");
    let (response, body) = curl(format!("/zip/sub?key={KEY}")).await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut zip = zip::ZipArchive::new(Cursor::new(body)).unwrap();
    assert!(zip.by_name("b.txt").is_ok());

    // A folder's address without its slash keeps the key on the way to the one with it.
    let (response, _) = curl(format!("/sub?key={KEY}")).await;
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(response.headers()[header::LOCATION], format!("/sub/?key={KEY}"));

    let response = app
        .clone()
        .oneshot(on_home("GET", &format!("/api/events?key={KEY}"), &[]))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn a_page_with_the_cookie_still_deletes_and_one_without_never_does() {
    let site = Site::new();
    let app = keyed(
        &site,
        Options {
            allow_delete: true,
            ..Options::default()
        },
    );
    let page: Headers = &[("x-okfs", "delete"), ("origin", "http://localhost:8080")];
    let (response, _) = send(&app, on_home("DELETE", "/api/entry?path=a.txt", page)).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(site.served.join("a.txt").exists());
    let (response, _) = send(
        &app,
        on_home("DELETE", "/api/entry?path=a.txt", &[page[0], page[1], COOKIE]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(!site.served.join("a.txt").exists());
}

#[tokio::test]
async fn without_a_key_nothing_asks_for_one() {
    let site = Site::new();
    let app = site.app(Options {
        check_host: true,
        ..Options::default()
    });
    let (response, body) = send(&app, on_home("GET", "/", NAVIGATE)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!String::from_utf8_lossy(&body).contains("\"key\""));
    // A key in the address means nothing, and is not taken out.
    let (response, body) = send(&app, on_home("GET", "/raw/a.txt?key=anything", &[])).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    assert_eq!(body, b"0123456789abcdefghij");
    let (response, _) = send(&app, on_home("GET", "/?key=anything", NAVIGATE)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key(header::SET_COOKIE));
}

/// A write of a file as the page sends it: its own origin, the header a form cannot add, and
/// what the write is for, `("if-none-match", "*")` or `("if-match", tag)`.
fn page_write(path: &str, wanted: (&str, &str), body: impl Into<Body>) -> Request<Body> {
    Request::put(format!("/api/file?path={path}"))
        .header(header::HOST, HOME)
        .header(header::ORIGIN, format!("http://{HOME}"))
        .header("x-okfs", "write")
        .header(wanted.0, wanted.1)
        .body(body.into())
        .unwrap()
}

/// A new folder as the page asks for it.
fn page_folder(path: &str) -> Request<Body> {
    Request::post(format!("/api/folder?path={path}"))
        .header(header::HOST, HOME)
        .header(header::ORIGIN, format!("http://{HOME}"))
        .header("x-okfs", "write")
        .body(Body::empty())
        .unwrap()
}

const NEW: (&str, &str) = ("if-none-match", "*");

/// The status and the JSON a write is answered with.
async fn wrote(app: &axum::Router, request: Request<Body>) -> (StatusCode, Value) {
    let (response, body) = send(app, request).await;
    (response.status(), serde_json::from_slice(&body).unwrap_or(Value::Null))
}

/// The tag a file is sent with, as the page reads it.
async fn tag_of(app: &axum::Router, path: &str) -> String {
    let (response, _) = get(app, &format!("/raw/{path}")).await;
    response.headers()[header::ETAG].to_str().unwrap().to_owned()
}

/// The names in a folder on disk that a write is still putting together, or left behind.
fn parts_in(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".okfs-"))
        .collect()
}

#[tokio::test]
async fn writing_is_off_unless_asked_for_and_each_flag_allows_only_its_own() {
    let site = Site::new();
    let before = snapshot(&site.served);
    let tag = tag_of(&site.router(), "a.txt").await;
    let cases = [
        (Options::default(), "--allow-upload", "--allow-edit"),
        // Changing files does not add any, and adding does not change any.
        (
            Options {
                allow_edit: true,
                ..Options::default()
            },
            "--allow-upload",
            "",
        ),
        (
            Options {
                allow_upload: true,
                ..Options::default()
            },
            "",
            "--allow-edit",
        ),
        (
            Options {
                allow_delete: true,
                ..Options::default()
            },
            "--allow-upload",
            "--allow-edit",
        ),
    ];
    for (options, no_new, no_change) in cases {
        let app = site.app(options);
        for (request, flag) in [
            (page_write("fresh.txt", NEW, "new"), no_new),
            (page_folder("fresh"), no_new),
            (page_write("a.txt", ("if-match", &tag), "changed"), no_change),
        ] {
            if flag.is_empty() {
                continue;
            }
            let (response, body) = send(&app, request).await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{flag}");
            assert!(String::from_utf8_lossy(&body).contains(flag), "{flag}");
        }
    }
    assert_eq!(snapshot(&site.served), before);
    assert!(!site.served.join("fresh").exists());

    // The page shows its controls only for what the server allows.
    for (options, upload, edit) in [
        (Options::default(), false, false),
        (
            Options {
                allow_upload: true,
                ..Options::default()
            },
            true,
            false,
        ),
        (
            Options {
                allow_edit: true,
                max_upload: Some(1024),
                ..Options::default()
            },
            false,
            true,
        ),
    ] {
        let (_, body) = get(&site.app(options), "/").await;
        let html = String::from_utf8_lossy(&body).into_owned();
        assert!(html.contains(&format!("\"upload\":{upload}")), "{html}");
        assert!(html.contains(&format!("\"edit\":{edit}")), "{html}");
        assert_eq!(html.contains("\"max_upload\":1024"), edit);
    }
}

#[tokio::test]
async fn a_new_file_is_added_whole_and_never_lands_on_a_name_that_is_taken() {
    let site = Site::new();
    let app = site.app(Options {
        allow_upload: true,
        ..Options::default()
    });
    let (status, answer) = wrote(&app, page_write("sub/fresh.txt", NEW, "fresh")).await;
    assert_eq!(status, StatusCode::CREATED, "{answer}");
    assert_eq!(answer["path"], "sub/fresh.txt");
    assert_eq!(answer["s"], 5);
    assert_eq!(answer["etag"], tag_of(&app, "sub/fresh.txt").await);
    assert_eq!(fs::read_to_string(site.served.join("sub/fresh.txt")).unwrap(), "fresh");
    // It is listed and searched at once.
    assert!(names(&json(&app, "/api/list?path=sub").await).contains(&"fresh.txt"));
    assert_eq!(json(&app, "/api/search?q=fresh").await["total"], 1);

    // A name that is taken is refused, with what is there for the page to set beside it.
    let (status, answer) = wrote(&app, page_write("a.txt", NEW, "over")).await;
    assert_eq!(status, StatusCode::PRECONDITION_FAILED, "{answer}");
    assert_eq!(answer["s"], 20);
    assert_eq!(answer["etag"], tag_of(&app, "a.txt").await);
    assert!(answer["m"].as_i64().unwrap() > 0);
    assert_eq!(
        fs::read_to_string(site.served.join("a.txt")).unwrap(),
        "0123456789abcdefghij"
    );
    let (status, answer) = wrote(&app, page_write("sub", NEW, "over")).await;
    assert_eq!(
        (status, &answer["d"]),
        (StatusCode::PRECONDITION_FAILED, &Value::Bool(true))
    );
    // So is a link, even one that leads nowhere, and nothing is told of where it leads.
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(site.served.join("gone.txt"), site.served.join("dangling.txt")).unwrap();
        for name in ["dangling.txt", "link-out.txt", "link-in.txt"] {
            let (status, answer) = wrote(&app, page_write(name, NEW, "over")).await;
            assert_eq!(status, StatusCode::PRECONDITION_FAILED, "{name}");
            assert!(!answer.to_string().contains("secret"), "{name}: {answer}");
        }
        assert!(
            fs::symlink_metadata(site.served.join("dangling.txt"))
                .unwrap()
                .is_symlink()
        );
        assert_eq!(fs::read_to_string(site.outside.join("secret.txt")).unwrap(), SECRET);
    }

    // Keeping both puts the new file beside the old under the next free name.
    for expected in ["a (1).txt", "a (2).txt"] {
        let (status, answer) = wrote(&app, page_write("a.txt&keep=1", NEW, expected)).await;
        assert_eq!((status, answer["path"].as_str()), (StatusCode::CREATED, Some(expected)));
        assert_eq!(fs::read_to_string(site.served.join(expected)).unwrap(), expected);
    }
    assert_eq!(
        fs::read_to_string(site.served.join("a.txt")).unwrap(),
        "0123456789abcdefghij"
    );

    // An empty file is a file: a new one made from the palette.
    let (status, _) = wrote(&app, page_write("empty.md", NEW, "")).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(fs::read(site.served.join("empty.md")).unwrap(), b"");

    for dir in [&site.served, &site.served.join("sub")] {
        assert!(parts_in(dir).is_empty(), "{dir:?}");
    }
}

#[tokio::test]
async fn a_file_is_changed_only_while_it_is_still_the_version_read() {
    let site = Site::new();
    let app = site.writing();
    let read = tag_of(&app, "a.txt").await;
    let (status, answer) = wrote(&app, page_write("a.txt", ("if-match", &read), "saved once")).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["path"], "a.txt");
    assert_eq!(fs::read_to_string(site.served.join("a.txt")).unwrap(), "saved once");
    let now = tag_of(&app, "a.txt").await;
    assert_eq!(answer["etag"], now);
    assert_ne!(now, read);

    // A save from what was read before that is refused, and told what the file is now.
    let (status, answer) = wrote(&app, page_write("a.txt", ("if-match", &read), "stale")).await;
    assert_eq!(status, StatusCode::PRECONDITION_FAILED);
    assert_eq!(
        (answer["etag"].as_str(), &answer["s"]),
        (Some(now.as_str()), &Value::from(10))
    );
    assert_eq!(fs::read_to_string(site.served.join("a.txt")).unwrap(), "saved once");
    // A weak tag names the same version.
    let (status, _) = wrote(
        &app,
        page_write("a.txt", ("if-match", &format!("W/{now}")), "saved twice"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // A write that says neither what it adds nor what it replaces is refused, as is one that says both.
    let mut bare = page_write("a.txt", NEW, "bare");
    bare.headers_mut().remove("if-none-match");
    assert_eq!(send(&app, bare).await.0.status(), StatusCode::PRECONDITION_REQUIRED);
    let mut both = page_write("a.txt", NEW, "both");
    both.headers_mut().insert("if-match", now.parse().unwrap());
    assert_eq!(send(&app, both).await.0.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        send(&app, page_write("a.txt", ("if-match", "*"), "any"))
            .await
            .0
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(fs::read_to_string(site.served.join("a.txt")).unwrap(), "saved twice");

    // A file that went away since it was read says so.
    let tag = tag_of(&app, "file2.txt").await;
    fs::remove_file(site.served.join("file2.txt")).unwrap();
    let (status, answer) = wrote(&app, page_write("file2.txt", ("if-match", &tag), "back")).await;
    assert_eq!(
        (status, &answer["gone"]),
        (StatusCode::PRECONDITION_FAILED, &Value::Bool(true))
    );
    assert!(!site.served.join("file2.txt").exists());
    // A folder is not a file.
    let (status, _) = wrote(&app, page_write("sub", ("if-match", "\"1-0\""), "x")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(parts_in(&site.served).is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_change_through_a_link_writes_the_real_file_and_the_link_stays() {
    use std::os::unix::fs::PermissionsExt;
    let site = Site::new();
    let app = site.writing();
    let real = site.served.join("sub/b.txt");
    fs::set_permissions(&real, fs::Permissions::from_mode(0o640)).unwrap();
    let tag = tag_of(&app, "link-in.txt").await;
    let (status, answer) = wrote(&app, page_write("link-in.txt", ("if-match", &tag), "through")).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["path"], "link-in.txt");
    assert!(
        fs::symlink_metadata(site.served.join("link-in.txt"))
            .unwrap()
            .is_symlink()
    );
    assert_eq!(fs::read_to_string(&real).unwrap(), "through");
    assert_eq!(fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o640);
    assert!(parts_in(&site.served.join("sub")).is_empty() && parts_in(&site.served).is_empty());
}

#[tokio::test]
async fn no_write_leaves_the_served_folder_or_reaches_a_dotfile() {
    let site = Site::new();
    let app = site.writing();
    let served_before = snapshot(&site.served);
    let outside_before = snapshot(&site.outside);
    let escapes = [
        "",
        "/",
        "../outside/new.txt",
        "sub/../../outside/new.txt",
        "%2E%2E/outside/new.txt",
        "link-out-dir/new.txt",
        "link-out-dir/secret.txt",
        "nope/new.txt",
        ".hidden",
        ".new",
        "sub/.new",
        ".okfs-0011223344556677.part",
        "line%0Abreak.txt",
        "tab%09.txt",
        "nul%00.txt",
    ];
    for path in escapes {
        for wanted in [NEW, ("if-match", "\"0-0\"")] {
            let (status, answer) = wrote(&app, page_write(path, wanted, SECRET)).await;
            assert!(status.is_client_error(), "{path} {wanted:?}: {status} {answer}");
        }
        let (response, _) = send(&app, page_folder(path)).await;
        assert!(response.status().is_client_error(), "{path}: {}", response.status());
    }
    // A link that leads out is never written through, even with its tag in hand.
    #[cfg(unix)]
    {
        let meta = fs::metadata(site.outside.join("secret.txt")).unwrap();
        let stamp = meta.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap();
        let tag = format!("\"{:x}-{:x}\"", stamp.as_nanos(), meta.len());
        let (status, _) = wrote(&app, page_write("link-out.txt", ("if-match", &tag), "over")).await;
        assert!(status.is_client_error(), "{status}");
    }
    assert_eq!(snapshot(&site.served), served_before);
    assert_eq!(snapshot(&site.outside), outside_before);
    assert!(parts_in(&site.served).is_empty() && parts_in(&site.outside).is_empty());
}

#[tokio::test]
async fn a_write_is_never_shown_until_it_is_whole_and_a_cut_off_one_leaves_nothing() {
    let site = Site::new();
    let app = site.serving(
        true,
        Options {
            allow_upload: true,
            ..Options::default()
        },
    );
    // A part left behind is never listed, searched or served, even with --hidden.
    fs::write(site.served.join(".okfs-00112233.part"), SECRET).unwrap();
    let listing = json(&app, "/api/list?path=&all=1").await;
    assert!(names(&listing).contains(&".hidden"));
    assert!(!listing.to_string().contains(".okfs-"), "{listing}");
    assert_eq!(
        get(&app, "/raw/.okfs-00112233.part").await.0.status(),
        StatusCode::NOT_FOUND
    );
    fs::remove_file(site.served.join(".okfs-00112233.part")).unwrap();

    // A body that breaks off part way writes nothing.
    let pieces = futures_util::stream::iter([
        Ok(bytes::Bytes::from_static(b"the first half")),
        Err(std::io::Error::other("the connection dropped")),
    ]);
    let (status, _) = wrote(&app, page_write("cut.txt", NEW, Body::from_stream(pieces))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(!site.served.join("cut.txt").exists());
    assert!(parts_in(&site.served).is_empty());
}

#[tokio::test]
async fn a_large_file_streams_to_disk_and_max_upload_bounds_it() {
    let site = Site::new();
    // Past the 2 MB a request body is held to by default: an upload is never held in memory.
    let big = vec![b'x'; 3 * 1024 * 1024 + 7];
    let app = site.writing();
    let (status, answer) = wrote(&app, page_write("big.bin", NEW, big.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{answer}");
    assert_eq!(fs::read(site.served.join("big.bin")).unwrap(), big);

    let app = site.app(Options {
        allow_upload: true,
        allow_edit: true,
        max_upload: Some(1024),
        ..Options::default()
    });
    // Refused by the length it says, before any of it is read.
    let (status, answer) = wrote(&app, page_write("small.bin", NEW, vec![b'x'; 1025])).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(answer["error"].as_str().unwrap().contains("--max-upload"));
    // And by what comes, when it says no length.
    let pieces =
        futures_util::stream::iter((0..4).map(|_| Ok::<_, std::io::Error>(bytes::Bytes::from(vec![b'x'; 300]))));
    let (status, _) = wrote(&app, page_write("small.bin", NEW, Body::from_stream(pieces))).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(!site.served.join("small.bin").exists());
    // A save is bound the same way.
    let tag = tag_of(&app, "a.txt").await;
    let (status, _) = wrote(&app, page_write("a.txt", ("if-match", &tag), vec![b'x'; 2048])).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        fs::read_to_string(site.served.join("a.txt")).unwrap(),
        "0123456789abcdefghij"
    );
    let (status, _) = wrote(&app, page_write("small.bin", NEW, vec![b'x'; 1024])).await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(parts_in(&site.served).is_empty());
}

#[tokio::test]
async fn a_folder_is_made_one_level_at_a_time_and_never_over_an_entry() {
    let site = Site::new();
    let app = site.app(Options {
        allow_upload: true,
        ..Options::default()
    });
    let (status, answer) = wrote(&app, page_folder("sub/photos")).await;
    assert_eq!(
        (status, &answer["path"]),
        (StatusCode::CREATED, &Value::from("sub/photos"))
    );
    assert!(site.served.join("sub/photos").is_dir());
    assert!(names(&json(&app, "/api/list?path=sub").await).contains(&"photos"));
    let (status, answer) = wrote(&app, page_folder("sub/photos")).await;
    assert_eq!(
        (status, &answer["d"]),
        (StatusCode::PRECONDITION_FAILED, &Value::Bool(true))
    );
    let (status, answer) = wrote(&app, page_folder("a.txt")).await;
    assert_eq!(
        (status, &answer["s"]),
        (StatusCode::PRECONDITION_FAILED, &Value::from(20))
    );
    // A folder under one that is not there yet is not made: each level is asked for.
    let (status, _) = wrote(&app, page_folder("sub/new/deeper")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!site.served.join("sub/new").exists());
    // A file goes into the new folder.
    let (status, _) = wrote(&app, page_write("sub/photos/tide.jpg", NEW, "jpg")).await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn a_write_is_told_to_every_open_page() {
    let site = Site::new();
    let app = site.writing();
    let mut other_tab = listen(&app).await;
    let (status, _) = wrote(&app, page_write("sub/fresh.txt", NEW, "fresh")).await;
    assert_eq!(status, StatusCode::CREATED);
    let (event, data) = next_change(&mut other_tab).await.unwrap();
    assert_eq!(
        (event.as_str(), data),
        ("change", serde_json::json!({ "dir": "sub", "files": ["fresh.txt"] }))
    );
    let tag = tag_of(&app, "a.txt").await;
    let (status, _) = wrote(&app, page_write("a.txt", ("if-match", &tag), "saved")).await;
    assert_eq!(status, StatusCode::OK);
    let (event, data) = next_change(&mut other_tab).await.unwrap();
    assert_eq!(
        (event.as_str(), data),
        ("change", serde_json::json!({ "dir": "", "files": ["a.txt"] }))
    );
    // The search knows its new size at once.
    let found = json(&app, "/api/search?q=a.txt").await;
    let hit = found["hits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|hit| hit["path"] == "a.txt");
    assert!(hit.is_some_and(|hit| hit["s"] == 5), "{found}");
    // A write that is refused changes nothing, and tells nothing.
    let (status, _) = wrote(&app, page_write("a.txt", NEW, "again")).await;
    assert_eq!(status, StatusCode::PRECONDITION_FAILED);
    assert_eq!(next_change(&mut other_tab).await, None);
}

#[tokio::test]
async fn another_site_cannot_make_a_browser_write() {
    let site = Site::new();
    let app = site.app(Options {
        allow_upload: true,
        allow_edit: true,
        check_host: true,
        ..Options::default()
    });
    let before = snapshot(&site.served);
    let headers: [Headers; 8] = [
        &[],
        &[("x-okfs", "write")],
        // The header of a delete is not the header of a write.
        &[("x-okfs", "delete"), ("origin", "http://localhost:8080")],
        &[("origin", "http://localhost:8080")],
        &[("x-okfs", "write"), ("origin", "https://evil.example")],
        &[("x-okfs", "write"), ("origin", "http://localhost:3000")],
        &[("x-okfs", "write"), ("origin", "null")],
        &[
            ("x-okfs", "write"),
            ("origin", "http://localhost:8080"),
            ("origin", "https://evil.example"),
        ],
    ];
    for headers in headers {
        for (method, uri) in [("PUT", "/api/file?path=fresh.txt"), ("POST", "/api/folder?path=fresh")] {
            let mut request = Request::builder().method(method).uri(uri).header(header::HOST, HOME);
            for (name, value) in headers {
                request = request.header(*name, *value);
            }
            let request = request.header("if-none-match", "*").body(Body::from(SECRET)).unwrap();
            let (status, answer) = wrote(&app, request).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {headers:?}: {answer}");
        }
    }
    assert_eq!(snapshot(&site.served), before);
    assert!(!site.served.join("fresh").exists());
    // The page's own write passes.
    let (status, _) = wrote(&app, page_write("fresh.txt", NEW, "ok")).await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn only_okfs_may_frame_the_page_while_any_write_is_on_and_only_the_editor_gets_a_nonce() {
    let site = Site::new();
    let flags = [
        (Options::default(), false, false),
        (
            Options {
                allow_upload: true,
                ..Options::default()
            },
            true,
            false,
        ),
        (
            Options {
                allow_edit: true,
                ..Options::default()
            },
            true,
            true,
        ),
    ];
    for (options, framed, nonce) in flags {
        let app = site.app(options);
        let mut seen = Vec::new();
        for _ in 0..2 {
            let (page, body) = browse(&app, "/sub/").await;
            let policy = page_policy(&page);
            assert_eq!(
                policy.contains(&"frame-ancestors 'self'".to_owned()),
                framed,
                "{policy:?}"
            );
            let style = policy
                .iter()
                .find(|directive| directive.starts_with("style-src"))
                .unwrap();
            let html = String::from_utf8_lossy(&body).into_owned();
            if nonce {
                // The style rule carries this page's nonce, which the page is told, and no other.
                let given = style
                    .strip_prefix("style-src 'self' 'nonce-")
                    .unwrap()
                    .trim_end_matches('\'');
                assert_eq!(given.len(), 22, "{style}");
                assert!(html.contains(&format!("\"nonce\":\"{given}\"")));
                seen.push(given.to_owned());
            } else {
                assert_eq!(style, "style-src 'self'");
                assert!(!html.contains("\"nonce\""));
            }
        }
        // A fresh one for each page.
        if nonce {
            assert_ne!(seen[0], seen[1]);
        }
    }
}

#[tokio::test]
async fn a_page_with_the_cookie_writes_and_one_without_never_does() {
    let site = Site::new();
    let app = keyed(
        &site,
        Options {
            allow_upload: true,
            ..Options::default()
        },
    );
    let page: Headers = &[
        ("x-okfs", "write"),
        ("origin", "http://localhost:8080"),
        ("if-none-match", "*"),
    ];
    for uri in ["/api/file?path=fresh.txt", "/api/folder?path=fresh"] {
        let method = if uri.contains("file") { "PUT" } else { "POST" };
        let (response, _) = send(&app, on_home(method, uri, page)).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{uri}");
        let (response, _) = send(&app, on_home(method, uri, &[page[0], page[1], page[2], COOKIE])).await;
        assert_eq!(response.status(), StatusCode::CREATED, "{uri}");
    }
    assert!(site.served.join("fresh.txt").is_file() && site.served.join("fresh").is_dir());
}

// The Trash, moving and copying.

impl Site {
    /// With deleting on and the Trash keeping what is deleted for 30 days, as okfs runs by default.
    fn trashing(&self) -> axum::Router {
        self.app(Options {
            allow_delete: true,
            trash: Some(30),
            ..Options::default()
        })
    }

    /// With every write on and the Trash too, `hidden` as for `--hidden`.
    fn all_writes(&self, hidden: bool) -> axum::Router {
        self.serving(
            hidden,
            Options {
                allow_delete: true,
                trash: Some(30),
                allow_upload: true,
                allow_edit: true,
                ..Options::default()
            },
        )
    }

    fn trash_dir(&self) -> PathBuf {
        self.served.join(".okfs-trash")
    }
}

/// A change as the page asks for it: `method` on `uri`, with the header naming the kind of change.
fn page_change(method: &str, uri: &str, change: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::HOST, HOME)
        .header(header::ORIGIN, format!("http://{HOME}"))
        .header("x-okfs", change)
        .body(Body::empty())
        .unwrap()
}

fn page_move(from: &str, to: &str) -> Request<Body> {
    page_change("POST", &format!("/api/move?from={from}&to={to}"), "move")
}

fn page_copy(from: &str, to: &str) -> Request<Body> {
    page_change("POST", &format!("/api/copy?from={from}&to={to}"), "write")
}

async fn trash_ids(app: &axum::Router) -> Vec<String> {
    json(app, "/api/trash").await["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn a_delete_goes_to_the_trash_and_can_be_put_back() {
    let site = Site::new();
    let app = site.trashing();
    let (status, answer) = wrote(&app, page_delete("sub").unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    let item = &answer["trash"];
    assert_eq!(item["path"], "sub");
    assert_eq!(item["dir"], true);
    assert_eq!(item["count"], 2, "b.txt and deep");
    assert!(!site.served.join("sub").exists());
    assert!(!names(&json(&app, "/api/list?path=").await).contains(&"sub"));

    let listed = json(&app, "/api/trash").await;
    assert_eq!(listed["days"], 30);
    let items = listed["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], item["id"]);
    let id = item["id"].as_str().unwrap();
    let deleted = items[0]["deleted"].as_i64().unwrap();
    assert_eq!(items[0]["gone"].as_i64().unwrap() - deleted, 30 * 24 * 60 * 60);

    let (status, back) = wrote(
        &app,
        page_change("POST", &format!("/api/trash/restore?id={id}"), "delete"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(back["path"], "sub");
    assert_eq!(
        fs::read_to_string(site.served.join("sub/deep/c.rs")).unwrap(),
        "fn main() {}\n"
    );
    assert!(trash_ids(&app).await.is_empty());
    assert!(names(&json(&app, "/api/list?path=").await).contains(&"sub"));
}

#[tokio::test]
async fn a_restore_onto_a_name_taken_since_keeps_both() {
    let site = Site::new();
    let app = site.trashing();
    let (_, answer) = wrote(&app, page_delete("file2.txt").unwrap()).await;
    let id = answer["trash"]["id"].as_str().unwrap().to_owned();
    fs::write(site.served.join("file2.txt"), "newer").unwrap();
    let (status, back) = wrote(
        &app,
        page_change("POST", &format!("/api/trash/restore?id={id}"), "delete"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(back["path"], "file2 (1).txt");
    assert_eq!(fs::read_to_string(site.served.join("file2.txt")).unwrap(), "newer");
    assert_eq!(fs::read_to_string(site.served.join("file2 (1).txt")).unwrap(), "two");
}

#[tokio::test]
async fn deleting_forever_and_emptying_the_trash_remove_for_good() {
    let site = Site::new();
    let app = site.trashing();
    for path in ["a.txt", "file2.txt", "file10.txt"] {
        assert_eq!(delete(&app, path).await, StatusCode::OK);
    }
    let ids = trash_ids(&app).await;
    assert_eq!(ids.len(), 3);
    let (status, gone) = wrote(
        &app,
        page_change("DELETE", &format!("/api/trash?id={}", ids[0]), "delete"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(gone["gone"], 1);
    assert_eq!(trash_ids(&app).await.len(), 2);
    let (status, _) = wrote(
        &app,
        page_change("DELETE", &format!("/api/trash?id={}", ids[0]), "delete"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "already gone");
    let (status, _) = wrote(&app, page_change("DELETE", "/api/trash", "delete")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "emptying is asked for by name");
    let (status, gone) = wrote(&app, page_change("DELETE", "/api/trash?all=1", "delete")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(gone["gone"], 2);
    assert!(trash_ids(&app).await.is_empty());
    assert_eq!(fs::read_dir(site.trash_dir()).unwrap().count(), 0);
    assert!(!site.served.join("a.txt").exists());
}

#[tokio::test]
async fn the_trash_sweeps_what_is_older_than_its_days_before_it_lists() {
    let site = Site::new();
    let app = site.trashing();
    assert_eq!(delete(&app, "a.txt").await, StatusCode::OK);
    assert_eq!(delete(&app, "file2.txt").await, StatusCode::OK);
    let ids = trash_ids(&app).await;
    // The first one was deleted 31 days ago, as far as the Trash knows.
    let info_path = site.trash_dir().join(&ids[0]).join("info.json");
    let mut info: Value = serde_json::from_slice(&fs::read(&info_path).unwrap()).unwrap();
    info["deleted"] = (info["deleted"].as_i64().unwrap() - 31 * 24 * 60 * 60).into();
    fs::write(&info_path, info.to_string()).unwrap();

    assert_eq!(trash_ids(&app).await, [ids[1].clone()]);
    assert!(!site.trash_dir().join(&ids[0]).exists());
}

#[tokio::test]
async fn trash_days_set_how_long_the_trash_keeps() {
    let site = Site::new();
    let app = site.app(Options {
        allow_delete: true,
        trash: Some(7),
        ..Options::default()
    });
    let (_, answer) = wrote(&app, page_delete("a.txt").unwrap()).await;
    let item = &answer["trash"];
    assert_eq!(
        item["gone"].as_i64().unwrap() - item["deleted"].as_i64().unwrap(),
        7 * 24 * 60 * 60
    );
    assert_eq!(json(&app, "/api/trash").await["days"], 7);
    let (_, page) = browse(&app, "/").await;
    assert!(String::from_utf8_lossy(&page).contains("\"trash\":7"));
}

#[tokio::test]
async fn with_no_trash_a_delete_is_for_good_and_there_is_no_trash_to_ask_for() {
    let site = Site::new();
    let app = site.deleting();
    assert_eq!(delete(&app, "a.txt").await, StatusCode::NO_CONTENT);
    assert!(!site.served.join("a.txt").exists());
    assert!(!site.trash_dir().exists());
    let (response, _) = get(&app, "/api/trash").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let (_, page) = browse(&app, "/").await;
    assert!(!String::from_utf8_lossy(&page).contains("\"trash\""));
}

#[tokio::test]
async fn forever_skips_the_trash() {
    let site = Site::new();
    let app = site.trashing();
    let request = page_change("DELETE", "/api/entry?path=a.txt&forever=1", "delete");
    assert_eq!(send(&app, request).await.0.status(), StatusCode::NO_CONTENT);
    assert!(!site.served.join("a.txt").exists());
    assert!(trash_ids(&app).await.is_empty());
}

#[tokio::test]
async fn the_trash_is_off_without_deleting_and_takes_changes_only_from_the_page() {
    let site = Site::new();
    let off = site.app(Options {
        trash: Some(30),
        ..Options::default()
    });
    assert_eq!(get(&off, "/api/trash").await.0.status(), StatusCode::NOT_FOUND);
    let refused = page_change("DELETE", "/api/trash?all=1", "delete");
    assert_eq!(send(&off, refused).await.0.status(), StatusCode::FORBIDDEN);

    let app = site.trashing();
    assert_eq!(delete(&app, "a.txt").await, StatusCode::OK);
    let id = trash_ids(&app).await.remove(0);
    let not_the_page = [
        Request::delete("/api/trash?all=1")
            .header(header::HOST, HOME)
            .body(Body::empty())
            .unwrap(),
        page_change("DELETE", "/api/trash?all=1", "write"),
        Request::post(format!("/api/trash/restore?id={id}"))
            .header(header::HOST, HOME)
            .header(header::ORIGIN, "https://evil.example")
            .header("x-okfs", "delete")
            .body(Body::empty())
            .unwrap(),
    ];
    for request in not_the_page {
        assert_eq!(send(&app, request).await.0.status(), StatusCode::FORBIDDEN);
    }
    assert_eq!(trash_ids(&app).await, [id]);
}

#[tokio::test]
async fn the_trash_is_never_listed_served_searched_or_written_even_with_hidden() {
    let site = Site::new();
    let app = site.all_writes(true);
    assert_eq!(delete(&app, "sub/b.txt").await, StatusCode::OK);
    let id = trash_ids(&app).await.remove(0);
    assert!(site.trash_dir().join(&id).join("item").exists());

    assert_eq!(
        get(&app, "/raw/.hidden").await.0.status(),
        StatusCode::OK,
        "--hidden is on"
    );
    let listed = get(&app, "/api/list?path=").await.1;
    assert!(!String::from_utf8_lossy(&listed).contains(".okfs-trash"));
    for uri in [
        "/api/list?path=.okfs-trash".to_owned(),
        format!("/raw/.okfs-trash/{id}/item"),
        format!("/raw/.okfs-trash/{id}/info.json"),
        "/zip/.okfs-trash".to_owned(),
    ] {
        assert_eq!(get(&app, &uri).await.0.status(), StatusCode::NOT_FOUND, "{uri}");
    }
    for query in ["item", "info", "okfs-trash"] {
        let found = json(&app, &format!("/api/search?q={query}&all=1")).await;
        assert!(!found.to_string().contains(".okfs-trash"), "{query}: {found}");
    }
    let zipped = get(&app, "/zip/").await.1;
    assert!(!String::from_utf8_lossy(&zipped).contains(".okfs-trash"));

    let writes = [
        page_write(".okfs-trash/x.txt", NEW, "x"),
        page_folder(".okfs-trash/x"),
        page_move("a.txt", ".okfs-trash"),
        page_move("a.txt", &format!(".okfs-trash/{id}/item")),
        page_copy("a.txt", ".okfs-trash/x.txt"),
        page_delete(".okfs-trash").unwrap(),
    ];
    for request in writes {
        let uri = request.uri().to_string();
        let status = send(&app, request).await.0.status();
        assert!(
            status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND,
            "{uri}: {status}"
        );
    }
    assert_eq!(trash_ids(&app).await, [id]);
}

#[tokio::test]
async fn a_folder_holding_a_dotfile_does_not_go_to_the_trash() {
    let site = Site::new();
    fs::write(site.served.join("sub/.env"), "x").unwrap();
    let app = site.trashing();
    let (status, why) = refusal(&app, page_delete("sub").unwrap()).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(why.contains("dotfile"), "{why}");
    assert!(site.served.join("sub/b.txt").exists());
    assert!(trash_ids(&app).await.is_empty());
}

#[tokio::test]
async fn a_rename_and_a_move_happen_in_one_step_and_never_replace() {
    let site = Site::new();
    let app = site.all_writes(false);
    let (status, moved) = wrote(&app, page_move("a.txt", "renamed.txt")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(moved["path"], "renamed.txt");
    assert_eq!(
        fs::read_to_string(site.served.join("renamed.txt")).unwrap(),
        "0123456789abcdefghij"
    );
    assert!(!site.served.join("a.txt").exists());

    // Into a folder, and a folder with all it holds.
    let (status, moved) = wrote(&app, page_move("renamed.txt", "sub/deep/renamed.txt")).await;
    assert_eq!(
        (status, moved["path"].as_str()),
        (StatusCode::OK, Some("sub/deep/renamed.txt"))
    );
    let (status, moved) = wrote(&app, page_move("sub", "moved")).await;
    assert_eq!((status, moved["path"].as_str()), (StatusCode::OK, Some("moved")));
    assert!(site.served.join("moved/deep/renamed.txt").exists());
    let found = json(&app, "/api/search?q=renamed").await;
    assert!(found.to_string().contains("moved/deep"), "the index follows: {found}");

    // A name that is taken is refused and nothing changes, unless both are kept.
    let (status, _) = wrote(&app, page_move("file2.txt", "file10.txt")).await;
    assert_eq!(status, StatusCode::PRECONDITION_FAILED);
    assert_eq!(fs::read_to_string(site.served.join("file10.txt")).unwrap(), "ten");
    assert_eq!(fs::read_to_string(site.served.join("file2.txt")).unwrap(), "two");
    let (status, moved) = wrote(
        &app,
        page_change("POST", "/api/move?from=file2.txt&to=file10.txt&keep=1", "move"),
    )
    .await;
    assert_eq!(
        (status, moved["path"].as_str()),
        (StatusCode::OK, Some("file10 (1).txt"))
    );
    assert_eq!(fs::read_to_string(site.served.join("file10 (1).txt")).unwrap(), "two");
}

#[tokio::test]
async fn a_move_is_refused_into_itself_out_of_the_folder_onto_hidden_names_and_without_its_flag() {
    let site = Site::new();
    let app = site.all_writes(false);
    let (status, why) = refusal(&app, page_move("sub", "sub/deep/sub")).await;
    assert_eq!(status, StatusCode::CONFLICT, "{why}");
    let refused = [
        page_move("sub", "../outside/sub"),
        page_move("a.txt", ".a.txt"),
        page_move(".hidden", "seen.txt"),
        page_move("", "x"),
        page_move("a.txt", "link-out-dir/a.txt"),
    ];
    for request in refused {
        let uri = request.uri().to_string();
        let status = send(&app, request).await.0.status();
        assert!(status.is_client_error(), "{uri}: {status}");
    }
    assert!(site.served.join("sub/deep/c.rs").exists());
    assert!(site.served.join("a.txt").exists());
    assert!(
        fs::read_dir(&site.outside)
            .unwrap()
            .all(|entry| entry.unwrap().file_name() != "sub")
    );

    let upload_only = site.app(Options {
        allow_upload: true,
        allow_delete: true,
        ..Options::default()
    });
    assert_eq!(
        send(&upload_only, page_move("a.txt", "b.txt")).await.0.status(),
        StatusCode::FORBIDDEN
    );
    let not_the_page = page_change("POST", "/api/move?from=a.txt&to=b.txt", "write");
    assert_eq!(send(&app, not_the_page).await.0.status(), StatusCode::FORBIDDEN);
    assert!(site.served.join("a.txt").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn a_moved_link_stays_a_link() {
    let site = Site::new();
    let app = site.all_writes(false);
    assert_eq!(
        send(&app, page_move("link-in.txt", "sub/deep/link.txt"))
            .await
            .0
            .status(),
        StatusCode::OK
    );
    assert!(
        fs::symlink_metadata(site.served.join("sub/deep/link.txt"))
            .unwrap()
            .is_symlink()
    );
    assert_eq!(fs::read_to_string(site.served.join("sub/b.txt")).unwrap(), "inside");
}

#[tokio::test]
async fn a_copy_lands_whole_beside_or_in_another_folder() {
    let site = Site::new();
    let app = site.all_writes(false);
    let (status, copied) = wrote(&app, page_copy("a.txt", "sub/a.txt")).await;
    assert_eq!(
        (status, copied["path"].as_str()),
        (StatusCode::CREATED, Some("sub/a.txt"))
    );
    assert_eq!(
        fs::read_to_string(site.served.join("sub/a.txt")).unwrap(),
        "0123456789abcdefghij"
    );
    assert!(site.served.join("a.txt").exists());

    // Duplicate: the same folder, keeping both.
    let (status, copied) = wrote(
        &app,
        page_change("POST", "/api/copy?from=a.txt&to=a.txt&keep=1", "write"),
    )
    .await;
    assert_eq!(
        (status, copied["path"].as_str()),
        (StatusCode::CREATED, Some("a (1).txt"))
    );
    let (status, _) = wrote(&app, page_copy("a.txt", "file2.txt")).await;
    assert_eq!(status, StatusCode::PRECONDITION_FAILED);
    assert_eq!(fs::read_to_string(site.served.join("file2.txt")).unwrap(), "two");

    // A folder, with all it shows and nothing it does not.
    fs::write(site.served.join("sub/.env"), "secret").unwrap();
    let (status, copied) = wrote(&app, page_copy("sub", "sub%20copy")).await;
    assert_eq!(
        (status, copied["path"].as_str()),
        (StatusCode::CREATED, Some("sub copy"))
    );
    assert_eq!(
        fs::read_to_string(site.served.join("sub copy/deep/c.rs")).unwrap(),
        "fn main() {}\n"
    );
    assert!(!site.served.join("sub copy/.env").exists());
    assert!(parts_in(&site.served).iter().all(|name| name == ".okfs-trash"));
    assert!(names(&json(&app, "/api/list?path=").await).contains(&"sub copy"));
}

#[tokio::test]
async fn a_copy_is_refused_into_itself_past_max_upload_and_without_its_flag() {
    let site = Site::new();
    let app = site.all_writes(false);
    let (status, _) = wrote(&app, page_copy("sub", "sub/deep/sub")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let small = site.app(Options {
        allow_upload: true,
        max_upload: Some(5),
        ..Options::default()
    });
    assert_eq!(
        send(&small, page_copy("a.txt", "big.txt")).await.0.status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let edit_only = site.app(Options {
        allow_edit: true,
        ..Options::default()
    });
    assert_eq!(
        send(&edit_only, page_copy("a.txt", "c.txt")).await.0.status(),
        StatusCode::FORBIDDEN
    );
    assert!(!site.served.join("big.txt").exists() && !site.served.join("c.txt").exists());
    assert!(!site.served.join("sub/deep/sub").exists());
}

fn zip_names(body: Vec<u8>) -> Vec<String> {
    let archive = zip::ZipArchive::new(Cursor::new(body)).unwrap();
    let mut names: Vec<String> = archive.file_names().map(|name| name.unwrap().into_owned()).collect();
    names.sort();
    names
}

#[tokio::test]
async fn a_zip_leaves_out_what_the_listing_leaves_out_unless_all_is_asked_for() {
    let site = Site::new();
    let proj = site.served.join("proj");
    fs::create_dir_all(proj.join("src")).unwrap();
    fs::create_dir_all(proj.join("dist")).unwrap();
    fs::create_dir_all(proj.join("node_modules/left-pad")).unwrap();
    fs::write(proj.join("src/main.rs"), "fn main() {}\n").unwrap();
    fs::write(proj.join("dist/out.js"), "1").unwrap();
    fs::write(proj.join("node_modules/left-pad/big.bin"), "0").unwrap();
    fs::write(proj.join(".gitignore"), "dist\n").unwrap();
    let app = site.router();

    let listed = json(&app, "/api/list?path=proj").await;
    assert_eq!(listed["hidden"], 2);

    let (_, body) = get(&app, "/zip/proj").await;
    assert_eq!(zip_names(body), ["src/", "src/main.rs"]);

    let (_, body) = get(&app, "/zip/proj?all=1").await;
    assert_eq!(
        zip_names(body),
        [
            "dist/",
            "dist/out.js",
            "node_modules/",
            "node_modules/left-pad/",
            "node_modules/left-pad/big.bin",
            "src/",
            "src/main.rs"
        ]
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_name_that_is_not_text_is_counted_in_its_folders_listing_and_not_shown() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let site = Site::new();
    let photos = site.served.join("photos");
    fs::create_dir_all(&photos).unwrap();
    fs::write(photos.join("ok.txt"), "ok").unwrap();
    fs::write(photos.join(OsStr::from_bytes(b"caf\xe9.txt")), "latin").unwrap();
    let app = site.router();

    for uri in ["/api/list?path=photos", "/api/list?path=photos&all=1"] {
        let listed = json(&app, uri).await;
        assert_eq!(names(&listed), ["ok.txt"]);
        assert_eq!(listed["unreadable"], 1);
    }
    // A folder with none says nothing.
    assert!(json(&app, "/api/list?path=sub").await.get("unreadable").is_none());
    let (_, body) = get(&app, "/zip/photos").await;
    assert_eq!(zip_names(body), ["ok.txt"]);
}

#[tokio::test]
async fn a_zip_applies_the_rules_of_each_folder_it_walks_into() {
    let site = Site::new();
    let proj = site.served.join("proj");
    fs::create_dir_all(proj.join("sub/out")).unwrap();
    fs::create_dir_all(proj.join("sub/keep")).unwrap();
    fs::write(proj.join("sub/out/x.txt"), "x").unwrap();
    fs::write(proj.join("sub/keep/y.txt"), "y").unwrap();
    // Anchored to the folder the file is in.
    fs::write(proj.join("sub/.gitignore"), "/out\n").unwrap();
    let app = site.router();

    let listed = json(&app, "/api/list?path=proj/sub").await;
    assert_eq!(names(&listed), ["keep"]);
    let (_, body) = get(&app, "/zip/proj").await;
    assert_eq!(zip_names(body), ["sub/", "sub/keep/", "sub/keep/y.txt"]);
    let (_, body) = get(&app, "/zip/proj?all=1").await;
    assert_eq!(
        zip_names(body),
        ["sub/", "sub/keep/", "sub/keep/y.txt", "sub/out/", "sub/out/x.txt"]
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_zip_through_a_link_to_a_folder_leaves_out_what_the_listing_of_it_does() {
    let site = Site::new();
    let real = site.served.join("real");
    fs::create_dir_all(real.join("sub/out")).unwrap();
    fs::create_dir_all(real.join("sub/keep")).unwrap();
    fs::write(real.join("sub/out/x.txt"), "x").unwrap();
    fs::write(real.join("sub/keep/y.txt"), "y").unwrap();
    fs::write(real.join("sub/.gitignore"), "/out\n").unwrap();
    std::os::unix::fs::symlink(&real, site.served.join("alias")).unwrap();
    let app = site.router();

    let listed = json(&app, "/api/list?path=alias/sub").await;
    assert_eq!(names(&listed), ["keep"]);
    for folder in ["real", "alias"] {
        let (_, body) = get(&app, &format!("/zip/{folder}")).await;
        assert_eq!(zip_names(body), ["sub/", "sub/keep/", "sub/keep/y.txt"], "{folder}");
    }
}

#[tokio::test]
async fn the_zip_of_the_served_folder_follows_its_okfsignore_and_top_level_rules() {
    let site = Site::new();
    fs::create_dir_all(site.served.join("scratch")).unwrap();
    fs::create_dir_all(site.served.join("sub/scratch")).unwrap();
    fs::write(site.served.join("scratch/s.txt"), "s").unwrap();
    fs::write(site.served.join("sub/scratch/t.txt"), "t").unwrap();
    // Anchored to the served folder: only the top `scratch` is left out.
    fs::write(site.served.join(".okfsignore"), "/scratch\n").unwrap();
    let app = site.router();

    let (_, body) = get(&app, "/zip/").await;
    let names = zip_names(body);
    assert!(!names.iter().any(|name| name.starts_with("scratch/")), "{names:?}");
    assert!(names.contains(&"sub/scratch/t.txt".to_owned()), "{names:?}");
    let (_, body) = get(&app, "/zip/?all=1").await;
    assert!(zip_names(body).contains(&"scratch/s.txt".to_owned()));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_dotfile_with_a_name_that_is_not_text_is_hidden_and_not_counted_unless_dotfiles_are_served() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let site = Site::new();
    let folder = site.served.join("photos");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("ok.txt"), "ok").unwrap();
    fs::write(folder.join(OsStr::from_bytes(b".caf\xe9")), "latin").unwrap();

    let listed = json(&site.router(), "/api/list?path=photos").await;
    assert!(listed.get("unreadable").is_none());
    assert!(listed.get("hidden").is_none());
    // With dotfiles served, it is a name okfs cannot show like any other.
    let listed = json(&site.serving(true, Options::default()), "/api/list?path=photos").await;
    assert_eq!(listed["unreadable"], 1);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_folder_holding_a_name_that_is_not_text_is_not_deleted_and_says_why() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let site = Site::new();
    let folder = site.served.join("photos");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join(OsStr::from_bytes(b"caf\xe9.txt")), "latin").unwrap();
    let (status, why) = refusal(&site.deleting(), page_delete("photos").unwrap()).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(why.contains("a name that is not text"), "{why}");
    assert!(folder.join(OsStr::from_bytes(b"caf\xe9.txt")).exists());
}
