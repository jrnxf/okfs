//! The key in the link. On an address beyond loopback okfs makes a random key when it starts,
//! prints its addresses with `?key=` on them, and answers only a request that brings the key:
//! in its address, or in the cookie a browser is given the first time it comes with one.
//!
//! The browser okfs opens itself gets a one-time code in place of the key, as other accounts on the
//! machine can read the command that opens it.

use std::fmt;
use std::hint::black_box;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use axum::http::header::{self, HeaderMap};

/// The random bytes in a key: 128 bits, far past what anyone could guess over a network.
const BYTES: usize = 16;

/// The name of the key in an address's query.
pub const PARAM: &str = "key";

/// The name of a one-time code in an address's query.
pub const ONCE_PARAM: &str = "once";

/// How long a one-time code lets a browser in, if no browser has used it first.
pub const ONCE_LIFE: Duration = Duration::from_secs(60);

/// What okfs says it wants when it refuses a request, in `WWW-Authenticate`. The page reads it to
/// tell okfs's own refusal from that of a proxy in front, which signs people in in its own way.
pub const SCHEME: &str = "okfs-key";

/// The secret that lets a request in.
#[derive(Clone, PartialEq, Eq)]
pub struct Key(String);

impl Key {
    /// A new key, from the operating system's random source.
    pub fn new() -> Result<Self, String> {
        Ok(Self(random()?))
    }

    /// A key of this text, such as one a test chooses.
    pub fn of(text: &str) -> Self {
        Self(text.to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether `given` is this key, in a time that does not depend on how much of it is right.
    pub fn matches(&self, given: &str) -> bool {
        same(self.0.as_bytes(), given.as_bytes())
    }
}

/// Never printed by accident, in a log or a panic.
impl fmt::Debug for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Key(..)")
    }
}

/// A code that lets one browser in once, in place of the key: the browser okfs opens itself. A
/// browser's command line can be read by every account on the machine, for as long as the browser
/// runs. The code in it is spent by the first request that brings it, and dies unspent after its
/// life, so what is left there lets no one in.
pub struct Once {
    code: String,
    made: Instant,
    life: Duration,
    spent: AtomicBool,
}

impl Once {
    /// A new code, from the operating system's random source, that lasts `life` from now.
    pub fn new(life: Duration) -> Result<Self, String> {
        Ok(Self {
            code: random()?,
            made: Instant::now(),
            life,
            spent: AtomicBool::new(false),
        })
    }

    pub fn as_str(&self) -> &str {
        &self.code
    }

    /// Whether `given` is this code, still alive and not yet spent. True once at most: a right
    /// answer spends it.
    pub fn take(&self, given: &str) -> bool {
        same(self.code.as_bytes(), given.as_bytes())
            && self.made.elapsed() < self.life
            && !self.spent.swap(true, Ordering::SeqCst)
    }
}

/// Never printed by accident, in a log or a panic.
impl fmt::Debug for Once {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Once(..)")
    }
}

/// 128 random bits from the operating system, as text an address carries as it is.
fn random() -> Result<String, String> {
    let mut bytes = [0; BYTES];
    getrandom::fill(&mut bytes).map_err(|error| format!("cannot make a key: {error}"))?;
    Ok(base64url(&bytes))
}

/// Whether two secrets are the same, comparing every byte whatever the first difference: how long
/// the answer takes says nothing of how much of a guess was right. Only the length shows, and a
/// key's length is no secret.
pub fn same(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let difference = a.iter().zip(b).fold(0, |all, (x, y)| all | (x ^ y));
    black_box(difference) == 0
}

/// Bytes as base64url without padding: letters, digits, `-` and `_`, which an address carries as
/// they are.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let group = chunk
            .iter()
            .enumerate()
            .fold(0u32, |all, (at, byte)| all | u32::from(*byte) << (16 - 8 * at));
        for at in 0..=chunk.len() {
            out.push(char::from(ALPHABET[(group >> (18 - 6 * at)) as usize & 63]));
        }
    }
    out
}

/// The name of the cookie that holds the key, for a request on this host. A browser keeps cookies
/// by host alone, so the port goes in the name: two okfs on one machine each keep their own.
pub fn cookie_name(host: &str) -> String {
    match crate::server::split_host(host.trim()).1 {
        Some(port) if !port.is_empty() => format!("{SCHEME}-{port}"),
        _ => SCHEME.to_owned(),
    }
}

/// The values of every cookie named `name` that a request carries.
pub fn cookies<'a>(headers: &'a HeaderMap, name: &'a str) -> impl Iterator<Item = &'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(move |pair| {
            let (key, value) = pair.split_once('=')?;
            (key.trim() == name).then(|| value.trim().trim_matches('"'))
        })
}

/// The cookie that hands a browser the key. Scripts cannot read it, no other site's page can send
/// it, and over https, as a proxy in front says, it never travels in the clear.
pub fn set_cookie(name: &str, key: &Key, secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!("{name}={}; Path=/; HttpOnly; SameSite=Strict{secure}", key.as_str())
}

/// Whether the browser reached okfs over https, through a proxy in front that ends TLS and says so.
/// A request that says so falsely only gets a cookie that its own browser keeps from plain http.
pub fn over_https(headers: &HeaderMap) -> bool {
    let first = |name| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .map(str::trim)
    };
    let forwarded_proto = first(header::HeaderName::from_static("x-forwarded-proto"));
    let forwarded = first(header::FORWARDED).and_then(|first| {
        first.split(';').find_map(|pair| {
            let (name, value) = pair.split_once('=')?;
            name.trim()
                .eq_ignore_ascii_case("proto")
                .then(|| value.trim().trim_matches('"'))
        })
    });
    forwarded_proto
        .or(forwarded)
        .is_some_and(|proto| proto.eq_ignore_ascii_case("https"))
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    #[test]
    fn secrets_are_the_same_only_byte_for_byte() {
        assert!(same(b"", b""));
        assert!(same(b"abc", b"abc"));
        assert!(!same(b"abc", b"abd"));
        assert!(!same(b"abc", b"xbc"));
        assert!(!same(b"abc", b"ab"));
        assert!(!same(b"ab", b"abc"));
        assert!(!same(b"abc", b""));
        let key = Key::of("k3y");
        assert!(key.matches("k3y"));
        assert!(!key.matches("K3Y"));
        assert!(!key.matches("k3y "));
    }

    #[test]
    fn a_new_key_holds_128_random_bits_an_address_carries_as_they_are() {
        let (first, second) = (Key::new().unwrap(), Key::new().unwrap());
        assert_ne!(first, second);
        for key in [&first, &second] {
            // 16 bytes are 22 characters of 6 bits each.
            assert_eq!(key.as_str().len(), 22);
            assert!(
                key.as_str()
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte)),
                "{}",
                key.as_str()
            );
        }
        assert_eq!(format!("{first:?}"), "Key(..)");
    }

    #[test]
    fn a_one_time_code_lets_in_once_and_never_again() {
        let once = Once::new(ONCE_LIFE).unwrap();
        let code = once.as_str().to_owned();
        assert_eq!(code.len(), 22);
        assert_ne!(code, Once::new(ONCE_LIFE).unwrap().as_str());
        // A wrong code spends nothing.
        assert!(!once.take("wrong"));
        assert!(!once.take(&code[1..]));
        assert!(once.take(&code));
        assert!(!once.take(&code));
        assert!(!once.take(&code));
        assert_eq!(format!("{once:?}"), "Once(..)");
    }

    #[test]
    fn a_one_time_code_dies_unspent_after_its_life() {
        let once = Once::new(Duration::from_millis(50)).unwrap();
        std::thread::sleep(Duration::from_millis(60));
        assert!(!once.take(once.as_str()));
        let dead = Once::new(Duration::ZERO).unwrap();
        assert!(!dead.take(dead.as_str()));
    }

    #[test]
    fn base64url_is_the_standard_one_without_padding() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"foob"), "Zm9vYg");
        assert_eq!(base64url(&[0xfb, 0xff, 0xfe]), "-__-");
    }

    #[test]
    fn each_port_keeps_its_own_cookie() {
        assert_eq!(cookie_name("192.168.1.20:8080"), "okfs-key-8080");
        assert_eq!(cookie_name("[::1]:9000"), "okfs-key-9000");
        assert_eq!(cookie_name("files.example.test"), "okfs-key");
        assert_eq!(cookie_name(""), "okfs-key");
    }

    #[test]
    fn the_cookie_is_found_among_others() {
        let mut headers = HeaderMap::new();
        headers.append(header::COOKIE, HeaderValue::from_static("a=1; okfs-key-8080=one"));
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("okfs-key-9000=two;okfs-key-8080=\"three\""),
        );
        assert_eq!(cookies(&headers, "okfs-key-8080").collect::<Vec<_>>(), ["one", "three"]);
        assert_eq!(cookies(&headers, "okfs-key").count(), 0);
    }

    #[test]
    fn the_cookie_is_secure_only_over_https() {
        let key = Key::of("k");
        assert_eq!(
            set_cookie("okfs-key", &key, false),
            "okfs-key=k; Path=/; HttpOnly; SameSite=Strict"
        );
        assert!(set_cookie("okfs-key", &key, true).ends_with("; Secure"));
        let said = |name: &'static str, value: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert(name, HeaderValue::from_static(value));
            over_https(&headers)
        };
        assert!(said("x-forwarded-proto", "https"));
        assert!(said("x-forwarded-proto", "HTTPS, http"));
        assert!(!said("x-forwarded-proto", "http"));
        assert!(said("forwarded", "for=192.0.2.1;proto=https;host=files.example.test"));
        assert!(said("forwarded", "proto=\"https\", proto=http"));
        assert!(!said("forwarded", "for=192.0.2.1;proto=http"));
        assert!(!over_https(&HeaderMap::new()));
    }
}
