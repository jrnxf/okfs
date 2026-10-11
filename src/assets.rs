//! The page, built by `build.rs` and compiled into the binary.

use std::borrow::Cow;

include!(concat!(env!("OUT_DIR"), "/assets.rs"));

pub struct Asset {
    pub bytes: Cow<'static, [u8]>,
    pub etag: &'static str,
}

/// One file of the page by its path, such as `app.js` or `fonts/geist.woff2`.
pub fn get(name: &str) -> Option<Asset> {
    // In a debug build, OKFS_UI_DIR serves the page from disk so it can be rebuilt without
    // recompiling the binary.
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("OKFS_UI_DIR") {
        let inside = !name.split('/').any(|part| part.is_empty() || part.starts_with('.'));
        let bytes = inside.then(|| std::fs::read(std::path::Path::new(&dir).join(name)).ok())??;
        return Some(Asset {
            bytes: Cow::Owned(bytes),
            etag: "",
        });
    }
    let (_, etag, bytes) = FILES.iter().find(|(path, _, _)| *path == name)?;
    Some(Asset {
        bytes: Cow::Borrowed(bytes),
        etag,
    })
}
