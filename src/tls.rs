//! HTTPS, behind `--tls-cert` and `--tls-key`: a certificate and its private key in PEM files, as
//! mkcert, a reverse proxy's own store or Let's Encrypt hands them out. okfs makes no certificate
//! itself.

use std::io;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::rustls::crypto::ring;
use tokio_rustls::server::TlsStream;

/// How long a connection has to finish its handshake before it is dropped.
const HANDSHAKE_LIMIT: Duration = Duration::from_secs(10);
/// Connections through their handshake and waiting for the server to take them, at most.
const WAITING: usize = 64;

/// The server's side of TLS: the certificate chain in `cert`, leaf first, and the private key in `key`.
pub fn config(cert: &Path, key: &Path) -> Result<Arc<ServerConfig>, String> {
    let read = |flag: &str, path: &Path, error: rustls_pki_types::pem::Error| {
        format!("cannot read {flag} {}: {error}", path.display())
    };
    let chain = CertificateDer::pem_file_iter(cert)
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|error| read("--tls-cert", cert, error))?;
    if chain.is_empty() {
        return Err(format!("--tls-cert {} holds no certificate", cert.display()));
    }
    let private = PrivateKeyDer::from_pem_file(key).map_err(|error| read("--tls-key", key, error))?;
    let mut config = ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|error| format!("cannot set up TLS: {error}"))?
        .with_no_client_auth()
        .with_single_cert(chain, private)
        .map_err(|error| {
            format!(
                "cannot serve with --tls-cert {} and --tls-key {}: {error}",
                cert.display(),
                key.display()
            )
        })?;
    // okfs speaks HTTP/1.1 alone.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

/// Connections that have been through the TLS handshake, for `axum::serve`.
///
/// Each handshake runs on its own, so a client that stalls in one holds up no other. One that
/// fails, as a browser asking for plain http does, is dropped without an answer.
pub struct Listener {
    local: SocketAddr,
    ready: mpsc::Receiver<(TlsStream<TcpStream>, SocketAddr)>,
}

impl Listener {
    pub fn new(tcp: TcpListener, config: Arc<ServerConfig>) -> io::Result<Self> {
        let local = tcp.local_addr()?;
        let (send, ready) = mpsc::channel(WAITING);
        tokio::spawn(shake_hands(tcp, TlsAcceptor::from(config), send));
        Ok(Self { local, ready })
    }
}

/// Takes each connection to `tcp` through its handshake and hands it on, until the server is gone.
async fn shake_hands(
    mut tcp: TcpListener,
    acceptor: TlsAcceptor,
    send: mpsc::Sender<(TlsStream<TcpStream>, SocketAddr)>,
) {
    loop {
        let (stream, from) = tokio::select! {
            // axum's own accept, which waits out errors such as running out of file descriptors.
            accepted = axum::serve::Listener::accept(&mut tcp) => accepted,
            () = send.closed() => return,
        };
        let (acceptor, send) = (acceptor.clone(), send.clone());
        tokio::spawn(async move {
            if let Ok(Ok(stream)) = tokio::time::timeout(HANDSHAKE_LIMIT, acceptor.accept(stream)).await {
                let _ = send.send((stream, from)).await;
            }
        });
    }
}

impl axum::serve::Listener for Listener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.ready.recv().await {
            Some(accepted) => accepted,
            // The task that sends ends only once this listener is gone, so this never comes.
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        Ok(self.local)
    }
}
