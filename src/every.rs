//! How often, written the way the command line takes it: `90s`, `30m`, `6h`, `1d`, `1h30m`.

use std::time::Duration;

const UNITS: [(char, u64); 4] = [('d', 24 * 60 * 60), ('h', 60 * 60), ('m', 60), ('s', 1)];

/// A span of time from whole numbers each followed by a unit: `s`, `m`, `h` or `d`.
pub fn parse(text: &str) -> Result<Duration, String> {
    let wrong = || format!("{text:?} is not a span of time such as 90s, 30m, 6h or 1d");
    let mut seconds: u64 = 0;
    let mut number = String::new();
    for c in text.trim().chars() {
        if c.is_ascii_digit() {
            number.push(c);
            continue;
        }
        let Some((_, size)) = UNITS.iter().find(|(unit, _)| *unit == c.to_ascii_lowercase()) else {
            return Err(wrong());
        };
        let count: u64 = number.parse().map_err(|_| wrong())?;
        seconds = count
            .checked_mul(*size)
            .and_then(|more| seconds.checked_add(more))
            .ok_or_else(wrong)?;
        number.clear();
    }
    if !number.is_empty() || seconds == 0 {
        return Err(wrong());
    }
    Ok(Duration::from_secs(seconds))
}

/// A span of time the way `parse` takes it, to whole seconds: `6h`, `33m20s`, `30s`.
pub fn spoken(span: Duration) -> String {
    let mut left = span.as_secs();
    if left == 0 {
        return "0s".to_owned();
    }
    let mut words = String::new();
    for (unit, size) in UNITS {
        if left >= size {
            words.push_str(&format!("{}{unit}", left / size));
            left %= size;
        }
    }
    words
}

#[cfg(test)]
mod tests {
    use super::{parse, spoken};
    use std::time::Duration;

    #[test]
    fn reads_whole_numbers_with_units() {
        let hours = |h: u64| Duration::from_secs(h * 3600);
        assert_eq!(parse("6h"), Ok(hours(6)));
        assert_eq!(parse("1d"), Ok(hours(24)));
        assert_eq!(parse("90s"), Ok(Duration::from_secs(90)));
        assert_eq!(parse("1h30m"), Ok(Duration::from_secs(5400)));
        assert_eq!(parse("30M"), Ok(Duration::from_secs(1800)));
    }

    #[test]
    fn refuses_what_is_not_a_span_of_time() {
        for text in [
            "",
            "6",
            "h",
            "0s",
            "0h0m",
            "1.5h",
            "-1h",
            "6 h",
            "6w",
            "99999999999999999999d",
        ] {
            assert!(parse(text).is_err(), "{text:?}");
        }
    }

    #[test]
    fn says_a_span_the_way_it_is_read() {
        for text in ["6h", "1d", "30s", "33m20s", "1d2h3m4s"] {
            assert_eq!(spoken(parse(text).unwrap()), text);
        }
        assert_eq!(spoken(Duration::from_millis(1500)), "1s");
        assert_eq!(spoken(Duration::ZERO), "0s");
    }
}
