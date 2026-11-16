//! okfs: a web file browser. One binary serves a folder and the page compiled into
//! it shows every file inside. Read only, unless writes or deleting are switched on.
//!
//! okfs has no stable library API. These modules are public for the binary and the tests of this
//! crate, and any of them may change or go in any release. What okfs keeps stable is listed in
//! `docs/usage.md`, under "What you can rely on".

pub mod archive;
pub mod assets;
pub mod camera;
pub mod cli;
pub mod every;
pub mod index;
pub mod key;
pub mod lan;
pub mod live;
pub mod paths;
pub mod pdf;
pub mod preview;
pub mod raw;
pub mod render;
pub mod server;
pub mod skip;
pub mod theme;
pub mod thumb;
pub mod tls;
pub mod trash;
pub mod write;
