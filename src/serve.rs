//! Takes connections and hands each one to the router, in place of `axum::serve`, which sets no
//! limit on how long a connection may take to send a request or on how many are open. Without
//! those, anyone who can reach the port stops the server with a few hundred idle sockets: each
//! holds a file descriptor, and okfs runs out of them.

use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::net::IpAddr;
use std::pin::{Pin, pin};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{Request, Response};
use axum::serve::Listener;
use http_body::{Frame, SizeHint};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::{Service, service_fn};
use hyper_util::rt::TokioIo;
use hyper_util::server::graceful::{GracefulShutdown, Watcher};
use hyper_util::service::TowerToHyperService;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpListener;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;
use tokio_rustls::TlsAcceptor;
use tokio_util::sync::CancellationToken;

/// What bounds the connections that are open at once.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// How long a connection may wait with no request under way and nothing moving: from its
    /// start to the end of the first request's head, and from the last byte of an answer to the
    /// end of the next head. A TLS handshake has this long too. A connection that takes longer
    /// is closed. It bounds no body and no answer, so an upload, a download and the stream of
    /// changes take as long as they take, as does a reader that is slow but still reads.
    pub wait: Duration,
    /// How long an answer may stand still because the other side takes none of it. A download
    /// that is read, however slowly, never stands still this long.
    pub stalled: Duration,
    /// How many connections are open at once, a TLS handshake under way included. One more
    /// waits its turn.
    pub open: usize,
    /// How many of those one address beyond this machine may hold. One more from it is closed
    /// at once, so that one machine cannot take every place.
    pub each: usize,
}

/// File descriptors kept back for what is not a connection or the file it is sent: the listener,
/// the watcher of the folder, the terminal, and the pipes to the process that draws a PDF.
const KEPT_BACK: usize = 64;

impl Limits {
    /// The limits okfs runs with. Each connection may have one file open to send, so `open` is
    /// at most half of the file descriptors this process may hold, less what is kept back.
    pub fn standard() -> Self {
        let open = (descriptors().saturating_sub(KEPT_BACK) / 2).clamp(8, 1024);
        Self {
            wait: Duration::from_secs(20),
            // As long as nginx waits between two writes to a client (`send_timeout`, 60 s).
            stalled: Duration::from_secs(60),
            open,
            each: open / 2,
        }
    }
}

/// How many file descriptors this process may hold open.
fn descriptors() -> usize {
    #[cfg(unix)]
    {
        let limit = rustix::process::getrlimit(rustix::process::Resource::Nofile);
        limit
            .current
            .and_then(|soft| usize::try_from(soft).ok())
            .unwrap_or(usize::MAX)
    }
    // Windows counts handles, and its limit is far above what the bound here allows.
    #[cfg(not(unix))]
    {
        usize::MAX
    }
}

/// Whose connections count together: one address. `None` for this machine itself: a proxy or a
/// tunnel on it speaks for everyone behind it, and has no share of its own to keep to.
fn holder(from: IpAddr) -> Option<IpAddr> {
    let from = from.to_canonical();
    (!from.is_loopback()).then_some(from)
}

/// The connections each holder has. A place is given back when it is dropped.
#[derive(Default)]
struct Held(Mutex<HashMap<IpAddr, usize>>);

struct Place {
    held: Arc<Held>,
    holder: Option<IpAddr>,
    _permit: OwnedSemaphorePermit,
}

impl Held {
    /// A place for one more connection from `from`, unless its holder has `each` already.
    fn take(self: &Arc<Self>, from: IpAddr, each: usize, permit: OwnedSemaphorePermit) -> Option<Place> {
        let holder = holder(from);
        if let Some(holder) = holder {
            let mut held = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let count = held.entry(holder).or_insert(0);
            if *count >= each {
                return None;
            }
            *count += 1;
        }
        Some(Place {
            held: Arc::clone(self),
            holder,
            _permit: permit,
        })
    }
}

impl Drop for Place {
    fn drop(&mut self) {
        let Some(holder) = self.holder else { return };
        let mut held = self.held.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(count) = held.get_mut(&holder) {
            *count -= 1;
            if *count == 0 {
                held.remove(&holder);
            }
        }
    }
}

/// Whether a connection is at work on a request, and since when it is not and nothing moved.
struct Waiting {
    at_work: AtomicUsize,
    since: Mutex<Instant>,
    changed: Notify,
    /// Since when an answer has bytes to send that the other side does not take.
    held_up: Mutex<Option<Instant>>,
}

/// One request under way. It ends when its answer has been handed over whole, or given up.
struct AtWork(Arc<Waiting>);

impl Waiting {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            at_work: AtomicUsize::new(0),
            since: Mutex::new(Instant::now()),
            changed: Notify::new(),
            held_up: Mutex::new(None),
        })
    }

    fn begin(self: &Arc<Self>) -> AtWork {
        self.at_work.fetch_add(1, Ordering::SeqCst);
        self.changed.notify_one();
        AtWork(Arc::clone(self))
    }

    /// Something moved just now: the wait starts over.
    fn moved(&self) {
        *self.since.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Instant::now();
        *self.held_up.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    /// The other side took none of what was there to send.
    fn held_up(&self) {
        self.held_up
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_or_insert_with(Instant::now);
    }

    /// Ends once an answer has stood still for `limit` because the other side takes none of it.
    async fn stalled(&self, limit: Duration) {
        loop {
            let since = *self.held_up.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            match since {
                Some(since) if since.elapsed() >= limit => return,
                Some(since) => tokio::time::sleep_until(since + limit).await,
                None => tokio::time::sleep(limit).await,
            }
        }
    }

    fn since(&self) -> Instant {
        *self.since.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Ends once the connection has waited `limit` with no request under way and nothing moved.
    async fn too_long(&self, limit: Duration) {
        loop {
            if self.at_work.load(Ordering::SeqCst) > 0 {
                self.changed.notified().await;
                continue;
            }
            let since = self.since();
            tokio::select! {
                () = tokio::time::sleep_until(since + limit) => {
                    if self.at_work.load(Ordering::SeqCst) == 0 && self.since() == since {
                        return;
                    }
                }
                () = self.changed.notified() => {}
            }
        }
    }
}

impl Drop for AtWork {
    fn drop(&mut self) {
        self.0.moved();
        self.0.at_work.fetch_sub(1, Ordering::SeqCst);
        self.0.changed.notify_one();
    }
}

/// An answer's body, which keeps its request under way until it has been handed over or dropped.
struct Answer {
    body: Body,
    _at_work: AtWork,
}

impl http_body::Body for Answer {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        Pin::new(&mut self.body).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

/// A connection that says when bytes of an answer leave. The end of an answer's body is handed
/// over before its last bytes are sent: a reader that still takes them is not waiting.
struct Watched<I> {
    io: I,
    waiting: Arc<Waiting>,
}

impl<I> Watched<I> {
    fn note(&self, sent: &Poll<io::Result<usize>>) {
        match sent {
            Poll::Ready(Ok(count)) if *count > 0 => self.waiting.moved(),
            Poll::Pending => self.waiting.held_up(),
            _ => {}
        }
    }
}

impl<I: AsyncRead + Unpin> AsyncRead for Watched<I> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl<I: AsyncWrite + Unpin> AsyncWrite for Watched<I> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let sent = Pin::new(&mut self.io).poll_write(cx, buf);
        self.note(&sent);
        sent
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let sent = Pin::new(&mut self.io).poll_write_vectored(cx, bufs);
        self.note(&sent);
        sent
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

/// Serves `router` on `listener` until `stop` ends, then lets each request under way finish.
/// With `tls`, each connection goes through a TLS handshake first, inside the same limits.
pub async fn serve(
    mut listener: TcpListener,
    tls: Option<TlsAcceptor>,
    router: Router,
    limits: Limits,
    stop: impl Future<Output = ()>,
) -> io::Result<()> {
    let router = TowerToHyperService::new(router);
    let open = Arc::new(Semaphore::new(limits.open));
    let held = Arc::new(Held::default());
    let graceful = GracefulShutdown::new();
    let stopping = CancellationToken::new();
    let mut stop = pin!(stop);
    loop {
        // A place first, then a connection: one that has no place stays in the system's queue.
        let permit = tokio::select! {
            permit = Arc::clone(&open).acquire_owned() => permit.expect("the semaphore is never closed"),
            () = &mut stop => break,
        };
        let (stream, from) = tokio::select! {
            // axum's own accept, which waits out errors such as running out of file descriptors.
            accepted = Listener::accept(&mut listener) => accepted,
            () = &mut stop => break,
        };
        // Over its share: closed at once, with no answer. Before a TLS handshake there is no
        // way to give one, and the handshake is what the share is there to bound.
        let Some(place) = held.take(from.ip(), limits.each, permit) else {
            continue;
        };
        let (router, tls, stopping) = (router.clone(), tls.clone(), stopping.clone());
        // Taken here and handed on: a connection is waited for when the server stops only once
        // it is through its handshake.
        let watcher = graceful.watcher();
        tokio::spawn(async move {
            match tls {
                // One that fails its handshake, as a browser asking for plain http does, or
                // never ends it, is dropped without an answer.
                Some(tls) => {
                    let shaken = tokio::select! {
                        shaken = tokio::time::timeout(limits.wait, tls.accept(stream)) => shaken,
                        () = stopping.cancelled() => return,
                    };
                    if let Ok(Ok(stream)) = shaken {
                        connection(stream, router, limits, watcher).await;
                    }
                }
                None => connection(stream, router, limits, watcher).await,
            }
            drop(place);
        });
    }
    drop(listener);
    stopping.cancel();
    graceful.shutdown().await;
    Ok(())
}

/// Answers the requests of one connection, HTTP/1.1 alone, until it ends, waits too long for a
/// request, or takes none of an answer for too long.
async fn connection<I>(io: I, router: TowerToHyperService<Router>, limits: Limits, watcher: Watcher)
where
    I: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let waiting = Waiting::new();
    let service = {
        let waiting = Arc::clone(&waiting);
        service_fn(move |request: Request<Incoming>| {
            let at_work = waiting.begin();
            let answer = router.call(request);
            async move {
                let answer: Response<Body> = answer.await?;
                Ok::<_, Infallible>(answer.map(|body| Answer {
                    body,
                    _at_work: at_work,
                }))
            }
        })
    };
    let io = TokioIo::new(Watched {
        io,
        waiting: Arc::clone(&waiting),
    });
    let serving = watcher.watch(http1::Builder::new().serve_connection(io, service));
    tokio::select! {
        // An error here is the other side's, such as a connection it broke.
        _ = serving => {}
        // Dropped, and so closed, with no answer: there is no request to answer.
        () = waiting.too_long(limits.wait) => {}
        () = waiting.stalled(limits.stalled) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;
    use std::net::SocketAddr;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::time::{sleep, timeout};

    fn limits(wait: Duration) -> Limits {
        Limits {
            wait,
            stalled: Duration::from_secs(60),
            open: 8,
            each: 8,
        }
    }

    /// A server that runs until the test ends.
    async fn served(router: Router, tls: Option<TlsAcceptor>, limits: Limits) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(serve(listener, tls, router, limits, std::future::pending()));
        address
    }

    fn here() -> Router {
        Router::new().route("/", get(|| async { "here" }))
    }

    const WHOLE: &[u8] = b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n";

    /// Reads until the server closes the connection, or gives up after `within`.
    async fn closed(stream: &mut TcpStream, within: Duration) -> Option<Vec<u8>> {
        let mut read = Vec::new();
        // A connection that is reset is closed too.
        let _ = timeout(within, stream.read_to_end(&mut read)).await.ok()?;
        Some(read)
    }

    #[tokio::test]
    async fn a_connection_that_never_ends_its_request_head_is_closed() {
        let address = served(here(), None, limits(Duration::from_millis(300))).await;

        // No final blank line: the head never ends.
        let mut slow = TcpStream::connect(address).await.unwrap();
        slow.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n").await.unwrap();
        let read = closed(&mut slow, Duration::from_secs(5)).await;
        let read = read.expect("the connection stays open");
        assert!(!String::from_utf8_lossy(&read).contains("here"));

        // One that sends nothing at all is closed too.
        let mut silent = TcpStream::connect(address).await.unwrap();
        assert!(closed(&mut silent, Duration::from_secs(5)).await.is_some());

        // And one that is answered, then sends no more.
        let mut idle = TcpStream::connect(address).await.unwrap();
        idle.write_all(WHOLE).await.unwrap();
        let read = closed(&mut idle, Duration::from_secs(5)).await;
        let read = read.expect("the connection stays open");
        assert!(String::from_utf8_lossy(&read).ends_with("here"));
    }

    #[tokio::test]
    async fn an_answer_takes_as_long_as_it_takes() {
        let slow = || async {
            sleep(Duration::from_millis(900)).await;
            "late"
        };
        let router = Router::new().route("/", get(slow));
        let address = served(router, None, limits(Duration::from_millis(200))).await;
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let read = closed(&mut stream, Duration::from_secs(5)).await.unwrap();
        assert!(String::from_utf8_lossy(&read).ends_with("late"));
    }

    /// One piece, far more than a socket holds: its end is handed over long before it is sent.
    const BIG: usize = 24 << 20;

    fn big() -> Router {
        Router::new().route("/", get(|| async { vec![b'x'; BIG] }))
    }

    const WHOLE_THEN_CLOSE: &[u8] = b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";

    #[tokio::test]
    async fn a_reader_that_is_slow_but_still_reads_gets_the_whole_answer() {
        let address = served(big(), None, limits(Duration::from_millis(250))).await;
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream.write_all(WHOLE_THEN_CLOSE).await.unwrap();
        let (mut read, mut piece) = (Vec::new(), vec![0; 1 << 20]);
        let started = Instant::now();
        loop {
            let count = timeout(Duration::from_secs(5), stream.read(&mut piece))
                .await
                .expect("the answer stopped")
                .unwrap();
            if count == 0 {
                break;
            }
            read.extend_from_slice(&piece[..count]);
            sleep(Duration::from_millis(40)).await;
        }
        // The reading took several times the wait, and every byte came.
        assert!(
            started.elapsed() > Duration::from_millis(750),
            "{:?}",
            started.elapsed()
        );
        let head = read.windows(4).position(|at| at == b"\r\n\r\n").unwrap() + 4;
        assert_eq!(read.len() - head, BIG);
    }

    #[tokio::test]
    async fn an_answer_that_is_never_read_is_given_up() {
        let limits = Limits {
            stalled: Duration::from_millis(300),
            ..limits(Duration::from_secs(30))
        };
        let address = served(big(), None, limits).await;
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream.write_all(WHOLE_THEN_CLOSE).await.unwrap();
        // Nothing is read for far longer than the limit. What comes after is cut short.
        sleep(Duration::from_millis(1500)).await;
        let read = closed(&mut stream, Duration::from_secs(10))
            .await
            .expect("it stays open");
        assert!(read.len() < BIG, "{}", read.len());
    }

    #[tokio::test]
    async fn one_address_cannot_hold_every_place() {
        let open = Arc::new(Semaphore::new(16));
        let permit = || Arc::clone(&open).try_acquire_owned().unwrap();
        let held = Arc::new(Held::default());
        let from = |text: &str| text.parse::<IpAddr>().unwrap();

        let first = held.take(from("192.0.2.7"), 2, permit());
        let second = held.take(from("192.0.2.7"), 2, permit());
        assert!(first.is_some() && second.is_some());
        assert!(held.take(from("192.0.2.7"), 2, permit()).is_none());
        // The same address written as IPv6 is the same holder.
        assert!(held.take(from("::ffff:192.0.2.7"), 2, permit()).is_none());
        // Another address has its own share.
        assert!(held.take(from("192.0.2.8"), 2, permit()).is_some());
        // A place that is given back is there to take again.
        drop(first);
        assert!(held.take(from("192.0.2.7"), 2, permit()).is_some());

        // Each IPv6 address is a holder of its own: one network of 64 bits is a whole LAN.
        let a = held.take(from("2001:db8:0:1::1"), 1, permit());
        let b = held.take(from("2001:db8:0:1::2"), 1, permit());
        assert!(a.is_some() && b.is_some());
        assert!(held.take(from("2001:db8:0:1::1"), 1, permit()).is_none());

        // This machine has no share to keep to: a proxy on it speaks for everyone.
        let local: Vec<_> = ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.1"]
            .iter()
            .map(|text| held.take(from(text), 2, permit()))
            .collect();
        assert!(local.iter().all(Option::is_some));
        drop((second, a, b, local));
        assert!(held.0.lock().unwrap().values().all(|count| *count > 0));
    }

    #[tokio::test]
    async fn no_more_connections_are_open_than_the_limit() {
        let limits = Limits {
            open: 2,
            each: 2,
            ..limits(Duration::from_secs(30))
        };
        let address = served(here(), None, limits).await;
        let ask = |mut stream: TcpStream| async move {
            stream.write_all(WHOLE).await.unwrap();
            let mut read = [0; 512];
            let count = timeout(Duration::from_millis(400), stream.read(&mut read)).await;
            (stream, count.is_ok_and(|count| count.is_ok_and(|count| count > 0)))
        };
        let (first, answered) = ask(TcpStream::connect(address).await.unwrap()).await;
        assert!(answered);
        let (_second, answered) = ask(TcpStream::connect(address).await.unwrap()).await;
        assert!(answered);
        // The third waits its turn, and gets it when a place is free.
        let (mut third, answered) = ask(TcpStream::connect(address).await.unwrap()).await;
        assert!(!answered);
        drop(first);
        let mut read = [0; 512];
        let count = timeout(Duration::from_secs(5), third.read(&mut read)).await;
        assert!(count.unwrap().unwrap() > 0);
    }

    #[tokio::test]
    async fn the_server_stops_when_told_and_lets_a_request_under_way_finish() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let slow = || async {
            sleep(Duration::from_millis(400)).await;
            "done"
        };
        let router = Router::new().route("/", get(slow));
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(serve(listener, None, router, limits(Duration::from_secs(30)), async {
            let _ = stopped.await;
        }));
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream.write_all(WHOLE).await.unwrap();
        sleep(Duration::from_millis(100)).await;
        stop.send(()).unwrap();
        let read = closed(&mut stream, Duration::from_secs(5)).await.unwrap();
        assert!(String::from_utf8_lossy(&read).ends_with("done"));
        timeout(Duration::from_secs(5), server).await.unwrap().unwrap().unwrap();
        assert!(TcpStream::connect(address).await.is_err());
    }

    #[tokio::test]
    async fn a_tls_handshake_that_never_ends_is_closed_and_holds_a_place_until_then() {
        let dir = tempfile::tempdir().unwrap();
        let made = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
        let (cert, key) = (dir.path().join("cert.pem"), dir.path().join("key.pem"));
        std::fs::write(&cert, made.cert.pem()).unwrap();
        std::fs::write(&key, made.signing_key.serialize_pem()).unwrap();
        let tls = TlsAcceptor::from(crate::tls::config(&cert, &key).unwrap());
        let limits = Limits {
            open: 2,
            each: 2,
            ..limits(Duration::from_millis(300))
        };
        let address = served(here(), Some(tls), limits).await;
        // Two connections that send no hello hold both places.
        let mut first = TcpStream::connect(address).await.unwrap();
        let mut second = TcpStream::connect(address).await.unwrap();
        let started = Instant::now();
        assert!(closed(&mut first, Duration::from_secs(5)).await.is_some());
        assert!(closed(&mut second, Duration::from_secs(5)).await.is_some());
        assert!(
            started.elapsed() >= Duration::from_millis(250),
            "{:?}",
            started.elapsed()
        );
        // Plain http on the TLS port is dropped with no answer but TLS's own word for it.
        let mut plain = TcpStream::connect(address).await.unwrap();
        plain.write_all(WHOLE).await.unwrap();
        let read = closed(&mut plain, Duration::from_secs(5)).await.unwrap();
        assert!(!String::from_utf8_lossy(&read).contains("HTTP"), "{read:?}");
    }
}
