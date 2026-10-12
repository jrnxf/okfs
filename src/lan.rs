//! The addresses okfs prints on start, and the QR code behind `--qr`.
//!
//! A wildcard bind such as `0.0.0.0` is not a link anyone can open, so it is replaced
//! by the addresses this machine has. Choosing them is a pure function over a list, so
//! it is tested without real interfaces.

use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use qrcode::{Color, EcLevel, QrCode};

/// An address found on this machine, and whether its interface is up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Found {
    pub ip: IpAddr,
    pub up: bool,
}

/// The addresses of this machine's interfaces. Empty when they cannot be read.
pub fn found() -> Vec<Found> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .map(|interface| Found {
            ip: interface.ip(),
            // Elsewhere a stopped interface reads as unknown, which is as good as down.
            up: interface.is_oper_up() || (cfg!(windows) && interface.oper_status == if_addrs::IfOperStatus::Unknown),
        })
        .collect()
}

/// The addresses to print for a bind address: `bind` itself when it is one specific
/// address, otherwise this machine's loopback address first and then every address
/// another machine could use, IPv4 before IPv6.
pub fn addresses(bind: IpAddr, found: &[Found]) -> Vec<IpAddr> {
    if !bind.is_unspecified() {
        return vec![bind];
    }
    let loopback = match bind {
        IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::LOCALHOST),
    };
    let mut reachable: Vec<IpAddr> = found
        .iter()
        .filter(|found| found.up && reachable(found.ip))
        // `0.0.0.0` takes no IPv6 connection, while `::` takes both on the systems that matter.
        .filter(|found| bind.is_ipv6() || found.ip.is_ipv4())
        .map(|found| found.ip)
        .collect();
    reachable.sort_by_key(|ip| ip.is_ipv6());
    let mut seen = HashSet::new();
    reachable.retain(|ip| seen.insert(*ip));
    let mut all = vec![loopback];
    all.extend(reachable);
    all
}

/// Whether another machine could be given this address: not loopback, not a link-local
/// address (169.254.0.0/16, fe80::/10) that needs a scope to work, and not one that is
/// no address of a host at all.
fn reachable(ip: IpAddr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return false;
    }
    match ip {
        IpAddr::V4(ip) => !ip.is_link_local() && !ip.is_broadcast(),
        IpAddr::V6(ip) => ip.segments()[0] & 0xffc0 != 0xfe80,
    }
}

/// `http://host:port/`, with an IPv6 address in brackets.
pub fn link(ip: IpAddr, port: u16) -> String {
    format!("http://{}/", SocketAddr::new(ip, port))
}

/// The first address a phone could scan: one that is not loopback.
pub fn scan_target(addresses: &[IpAddr]) -> Option<IpAddr> {
    addresses
        .iter()
        .copied()
        .find(|ip| !ip.is_loopback() && !ip.is_unspecified())
}

/// What `--qr` prints for the addresses.
#[derive(Debug, PartialEq, Eq)]
pub enum Scan {
    /// The lines of the code.
    Code(Vec<String>),
    /// No address another device can use, and why.
    Nothing(&'static str),
    /// Output goes to a file or a pipe, where a code is noise.
    Skipped,
}

pub fn scan(bind: IpAddr, addresses: &[IpAddr], port: u16, terminal: bool) -> Scan {
    let Some(ip) = scan_target(addresses) else {
        return Scan::Nothing(if bind.is_loopback() {
            "nothing for another device to scan: listening on this machine only, try --bind 0.0.0.0"
        } else {
            "nothing for another device to scan: this machine has no network address"
        });
    };
    if !terminal {
        return Scan::Skipped;
    }
    match qr_lines(&link(ip, port)) {
        Some(lines) => Scan::Code(lines),
        None => Scan::Skipped,
    }
}

/// Black on white in fixed 256-color codes, not the terminal's own colors. A scanner
/// needs dark modules on a light ground, and a dark theme would invert the code.
const PAINT: &str = "\x1b[38;5;16;48;5;231m";
const RESET: &str = "\x1b[0m";

/// Modules of quiet zone on every side, as the QR standard asks.
const QUIET: usize = 4;

/// The code for `text` as terminal lines of half blocks, two modules to a line.
fn qr_lines(text: &str) -> Option<Vec<String>> {
    let code = QrCode::with_error_correction_level(text, EcLevel::L).ok()?;
    let width = code.width();
    let side = width + 2 * QUIET;
    let dark = |x: usize, y: usize| {
        let inside = (QUIET..QUIET + width).contains(&x) && (QUIET..QUIET + width).contains(&y);
        inside && code[(x - QUIET, y - QUIET)] == Color::Dark
    };
    let lines = (0..side)
        .step_by(2)
        .map(|y| {
            let cells: String = (0..side)
                .map(|x| match (dark(x, y), dark(x, y + 1)) {
                    (true, true) => '█',
                    (true, false) => '▀',
                    (false, true) => '▄',
                    (false, false) => ' ',
                })
                .collect();
            format!("{PAINT}{cells}{RESET}")
        })
        .collect();
    Some(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up(ip: &str) -> Found {
        Found {
            ip: ip.parse().unwrap(),
            up: true,
        }
    }

    fn ips(list: &[&str]) -> Vec<IpAddr> {
        list.iter().map(|ip| ip.parse().unwrap()).collect()
    }

    #[test]
    fn a_wildcard_lists_loopback_then_each_reachable_address() {
        let found = [
            up("127.0.0.1"),
            up("::1"),
            up("fe80::1"),
            up("169.254.3.4"),
            up("192.168.1.20"),
            up("fd00::20"),
            up("10.0.0.5"),
            Found {
                ip: "10.9.9.9".parse().unwrap(),
                up: false,
            },
            up("192.168.1.20"),
        ];
        assert_eq!(
            addresses("::".parse().unwrap(), &found),
            ips(&["::1", "192.168.1.20", "10.0.0.5", "fd00::20"])
        );
    }

    #[test]
    fn an_ipv4_wildcard_leaves_out_ipv6() {
        let found = [up("192.168.1.20"), up("fd00::20"), up("2001:db8::1")];
        assert_eq!(
            addresses("0.0.0.0".parse().unwrap(), &found),
            ips(&["127.0.0.1", "192.168.1.20"])
        );
    }

    #[test]
    fn no_network_leaves_loopback_alone() {
        assert_eq!(addresses("0.0.0.0".parse().unwrap(), &[]), ips(&["127.0.0.1"]));
        assert_eq!(addresses("::".parse().unwrap(), &[up("127.0.0.1")]), ips(&["::1"]));
    }

    #[test]
    fn a_specific_bind_is_printed_as_it_is() {
        let found = [up("192.168.1.20"), up("10.0.0.5")];
        assert_eq!(addresses("10.0.0.5".parse().unwrap(), &found), ips(&["10.0.0.5"]));
        assert_eq!(addresses("127.0.0.1".parse().unwrap(), &found), ips(&["127.0.0.1"]));
        assert_eq!(addresses("::1".parse().unwrap(), &found), ips(&["::1"]));
    }

    #[test]
    fn links_bracket_ipv6() {
        assert_eq!(link("192.168.1.20".parse().unwrap(), 8080), "http://192.168.1.20:8080/");
        assert_eq!(link("::1".parse().unwrap(), 9000), "http://[::1]:9000/");
        assert_eq!(link("fd00::20".parse().unwrap(), 80), "http://[fd00::20]:80/");
    }

    #[test]
    fn a_wildcard_is_never_printed() {
        for bind in ["0.0.0.0", "::"] {
            let bind: IpAddr = bind.parse().unwrap();
            for found in [vec![], vec![up("192.168.1.20"), up("fd00::20")]] {
                for ip in addresses(bind, &found) {
                    let text = link(ip, 8080);
                    assert!(!text.contains("0.0.0.0") && !text.contains("[::]"), "{text}");
                }
            }
        }
    }

    #[test]
    fn the_code_goes_to_the_first_address_that_is_not_loopback() {
        let all = ips(&["127.0.0.1", "192.168.1.20", "10.0.0.5"]);
        assert_eq!(scan_target(&all), Some("192.168.1.20".parse().unwrap()));
        assert_eq!(scan_target(&ips(&["127.0.0.1"])), None);
        assert_eq!(scan_target(&ips(&["::1"])), None);
    }

    #[test]
    fn qr_on_a_loopback_bind_says_so_and_does_not_fail() {
        let bind: IpAddr = "127.0.0.1".parse().unwrap();
        for terminal in [true, false] {
            match scan(bind, &[bind], 8080, terminal) {
                Scan::Nothing(why) => assert!(why.contains("--bind 0.0.0.0")),
                other => panic!("{other:?}"),
            }
        }
        let wildcard: IpAddr = "0.0.0.0".parse().unwrap();
        let lone = addresses(wildcard, &[]);
        assert!(matches!(scan(wildcard, &lone, 8080, true), Scan::Nothing(_)));
    }

    #[test]
    fn qr_is_skipped_when_output_is_not_a_terminal() {
        let bind: IpAddr = "0.0.0.0".parse().unwrap();
        let all = addresses(bind, &[up("192.168.1.20")]);
        assert_eq!(scan(bind, &all, 8080, false), Scan::Skipped);
    }

    #[test]
    fn the_code_has_a_quiet_zone_and_the_modules_of_the_link() {
        let bind: IpAddr = "0.0.0.0".parse().unwrap();
        let all = addresses(bind, &[up("192.168.1.20")]);
        let Scan::Code(lines) = scan(bind, &all, 8080, true) else {
            panic!("no code");
        };
        let text = "http://192.168.1.20:8080/";
        let code = QrCode::with_error_correction_level(text, EcLevel::L).unwrap();
        let side = code.width() + 2 * QUIET;
        assert_eq!(lines.len(), side.div_ceil(2));
        // Rebuild the grid from the glyphs and compare it with the encoder's matrix.
        let grid: Vec<Vec<bool>> = lines
            .iter()
            .flat_map(|line| {
                let cells: Vec<char> = line.trim_start_matches(PAINT).trim_end_matches(RESET).chars().collect();
                assert_eq!(cells.len(), side);
                [
                    cells.iter().map(|c| matches!(c, '█' | '▀')).collect::<Vec<_>>(),
                    cells.iter().map(|c| matches!(c, '█' | '▄')).collect::<Vec<_>>(),
                ]
            })
            .collect();
        for y in 0..side {
            for x in 0..side {
                let expected = (QUIET..QUIET + code.width()).contains(&x)
                    && (QUIET..QUIET + code.width()).contains(&y)
                    && code[(x - QUIET, y - QUIET)] == Color::Dark;
                assert_eq!(grid[y][x], expected, "module {x},{y}");
            }
        }
    }
}
