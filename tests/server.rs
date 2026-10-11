//! Behavior that can break without anyone noticing: the safety rules, ranges,
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
        let root = Root::new(&self.served, false).unwrap();
        let index = Index::new(root.clone());
        index.build();
        router(App::new(root, index, options).unwrap())
    }

    fn router(&self) -> axum::Router {
        self.app(Options::default())
    }
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
