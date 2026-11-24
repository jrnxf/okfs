//! HTTPS, behind `--tls-cert` and `--tls-key`: a certificate and its private key in PEM files, as
//! mkcert, a reverse proxy's own store or Let's Encrypt hands them out. okfs makes no certificate
//! itself.

use std::path::Path;
use std::sync::Arc;

use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::rustls::crypto::ring;

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
