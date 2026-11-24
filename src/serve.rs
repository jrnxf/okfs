//! Takes connections and hands each one to the router, in place of `axum::serve`, which sets no
//! limit on how long a connection may take to send a request or on how many are open. Without
//! those, anyone who can reach the port stops the server with a few hundred idle sockets: each
//! holds a file descriptor, and okfs runs out of them.

use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
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
use hyper::service::{Service, service_fn};
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder;
use hyper_util::server::graceful::GracefulShutdown;
use hyper_util::service::TowerToHyperService;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

/// What bounds the connections that are open at once.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// How long a connection has to send the whole head of a request: from its start, and from
    /// the end of the answer before it. A connection that takes longer is closed. It bounds no
    /// body and no answer, so an upload, a download and the stream of changes take as long as
    /// they take.
    pub head: Duration,
    /// How many connections are open at once. One more waits its turn.
    pub open: usize,
    /// How many of those one address may hold. One more from it is closed at once, so that one
    /// machine cannot take every place.
    pub each: usize,
}

impl Limits {
    /// The limits okfs runs with. `open` leaves at least half of the file descriptors this
    /// process may hold for the files it serves.
    pub fn standard() -> Self {
        let open = (descriptors() / 2).clamp(32, 1024);
        Self {
            head: Duration::from_secs(20),
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

/// The connections each address holds. A place is given back when its holder is dropped.
#[derive(Default)]
struct Held(Mutex<HashMap<IpAddr, usize>>);

struct Place {
    held: Arc<Held>,
    from: IpAddr,
    _permit: OwnedSemaphorePermit,
}

impl Held {
    /// A place for one more connection from `from`, unless it holds `each` already.
    fn take(self: &Arc<Self>, from: IpAddr, each: usize, permit: OwnedSemaphorePermit) -> Option<Place> {
        let mut held = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let count = held.entry(from).or_insert(0);
        if *count >= each {
            return None;
        }
        *count += 1;
        Some(Place {
            held: Arc::clone(self),
            from,
            _permit: permit,
        })
    }
}

impl Drop for Place {
    fn drop(&mut self) {
        let mut held = self.held.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(count) = held.get_mut(&self.from) {
            *count -= 1;
            if *count == 0 {
                held.remove(&self.from);
            }
        }
    }
}

/// Whether a connection is at work on a request, and since when it is not.
struct Waiting {
    at_work: AtomicUsize,
    since: Mutex<Instant>,
    changed: Notify,
}

/// One request under way. It ends when its answer has been sent whole, or given up.
struct AtWork(Arc<Waiting>);

impl Waiting {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            at_work: AtomicUsize::new(0),
            since: Mutex::new(Instant::now()),
            changed: Notify::new(),
        })
    }

    fn begin(self: &Arc<Self>) -> AtWork {
        self.at_work.fetch_add(1, Ordering::SeqCst);
        self.changed.notify_one();
        AtWork(Arc::clone(self))
    }

    fn since(&self) -> Instant {
        *self.since.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Ends once the connection has waited `limit` for a request, with none under way.
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
        *self.0.since.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Instant::now();
        self.0.at_work.fetch_sub(1, Ordering::SeqCst);
        self.0.changed.notify_one();
    }
}

/// An answer's body, which keeps its request under way until it has been sent or dropped.
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

/// Serves `router` on `listener` until `stop` ends, then lets each request under way finish.
pub async fn serve<L>(mut listener: L, router: Router, limits: Limits, stop: impl Future<Output = ()>) -> io::Result<()>
where
    L: Listener<Addr = SocketAddr>,
    L::Io: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    // HTTP/1.1 alone, as the TLS side offers.
    let builder = Builder::new(TokioExecutor::new()).http1_only();
    let router = TowerToHyperService::new(router);
    let open = Arc::new(Semaphore::new(limits.open));
    let held = Arc::new(Held::default());
    let graceful = GracefulShutdown::new();
    let mut stop = pin!(stop);
    loop {
        // A place first, then a connection: one that has no place stays in the system's queue.
        let permit = tokio::select! {
            permit = Arc::clone(&open).acquire_owned() => permit.expect("the semaphore is never closed"),
            () = &mut stop => break,
        };
        let (io, from) = tokio::select! {
            accepted = listener.accept() => accepted,
            () = &mut stop => break,
        };
        let Some(place) = held.take(from.ip(), limits.each, permit) else {
            continue;
        };
        let waiting = Waiting::new();
        let service = {
            let (router, waiting) = (router.clone(), Arc::clone(&waiting));
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
        let connection = builder
            .serve_connection_with_upgrades(TokioIo::new(io), service)
            .into_owned();
        let connection = graceful.watch(connection);
        tokio::spawn(async move {
            tokio::select! {
                // An error here is the other side's, such as a connection it broke.
                _ = connection => {}
                // Dropped, and so closed, with no answer: there is no request to answer.
                () = waiting.too_long(limits.head) => {}
            }
            drop(place);
        });
    }
    drop(listener);
    graceful.shutdown().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::time::{sleep, timeout};

    /// A server with these limits, and its address. It stops when the sender is dropped.
    async fn served(limits: Limits) -> (SocketAddr, tokio::sync::oneshot::Sender<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new().route("/", get(|| async { "here" }));
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(serve(listener, router, limits, async {
            let _ = stopped.await;
        }));
        (address, stop)
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
        let limits = Limits {
            head: Duration::from_millis(300),
            open: 8,
            each: 8,
        };
        let (address, _stop) = served(limits).await;

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
        let limits = Limits {
            head: Duration::from_millis(200),
            open: 8,
            each: 8,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let slow = || async {
            sleep(Duration::from_millis(900)).await;
            "late"
        };
        let router = Router::new().route("/", get(slow));
        tokio::spawn(serve(listener, router, limits, std::future::pending()));
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let read = closed(&mut stream, Duration::from_secs(5)).await.unwrap();
        assert!(String::from_utf8_lossy(&read).ends_with("late"));
    }

    #[tokio::test]
    async fn one_address_cannot_hold_every_place() {
        let limits = Limits {
            head: Duration::from_secs(30),
            open: 4,
            each: 2,
        };
        let (address, _stop) = served(limits).await;
        let mut first = TcpStream::connect(address).await.unwrap();
        let mut second = TcpStream::connect(address).await.unwrap();
        // Both hold their place: each is answered.
        for stream in [&mut first, &mut second] {
            stream.write_all(WHOLE).await.unwrap();
            let mut read = [0; 512];
            let count = stream.read(&mut read).await.unwrap();
            assert!(String::from_utf8_lossy(&read[..count]).ends_with("here"));
        }
        // A third from the same address is closed with no answer.
        let mut third = TcpStream::connect(address).await.unwrap();
        let _ = third.write_all(WHOLE).await;
        let read = closed(&mut third, Duration::from_secs(5)).await;
        assert_eq!(read.as_deref(), Some(&b""[..]));
        // A place that is given back is there to take again.
        drop(first);
        let mut again = None;
        for _ in 0..50 {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream.write_all(WHOLE).await.unwrap();
            let mut read = [0; 512];
            if let Ok(Ok(count)) = timeout(Duration::from_millis(200), stream.read(&mut read)).await
                && count > 0
            {
                again = Some(String::from_utf8_lossy(&read[..count]).into_owned());
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
        assert!(again.is_some_and(|read| read.ends_with("here")));
    }

    #[tokio::test]
    async fn the_server_stops_when_told_and_lets_a_request_under_way_finish() {
        let limits = Limits {
            head: Duration::from_secs(30),
            open: 8,
            each: 8,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let slow = || async {
            sleep(Duration::from_millis(400)).await;
            "done"
        };
        let router = Router::new().route("/", get(slow));
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(serve(listener, router, limits, async {
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
}
