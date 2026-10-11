//! okfs: a web file browser. One binary serves a folder and the page compiled into
//! it shows every file inside. Read only, unless deleting is switched on.

pub mod archive;
pub mod assets;
pub mod cli;
pub mod index;
pub mod paths;
pub mod preview;
pub mod raw;
pub mod render;
pub mod server;
pub mod theme;
pub mod thumb;
