// See Cargo.toml: musl's own allocator is slow under threads.
#[cfg(target_env = "musl")]
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() -> std::process::ExitCode {
    okfs::cli::run()
}
