//! okfs: a web file browser. One binary serves a folder and the page compiled into
//! it shows every file inside. Read only, unless writes or deleting are switched on.

pub mod archive;
pub mod assets;
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
pub mod write;
