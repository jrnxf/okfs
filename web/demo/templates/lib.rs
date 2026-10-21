//! Tidal harmonics: the height of the tide as a sum of cosines, one per constituent.

use std::f64::consts::PI;

/// One constituent of the tide at a station: how high it swings and where it is in its cycle.
#[derive(Debug, Clone, Copy)]
pub struct Constituent {
    pub name: &'static str,
    /// Degrees per hour.
    pub speed: f64,
    /// Metres.
    pub amplitude: f64,
    /// Degrees, against the station's epoch.
    pub phase: f64,
}

/// The constituents that carry most of the tide in a small harbor.
pub const MAJOR: [(&str, f64); 6] = [
    ("M2", 28.984_104_2),
    ("S2", 30.0),
    ("N2", 28.439_729_5),
    ("K1", 15.041_068_6),
    ("O1", 13.943_035_6),
    ("M4", 57.968_208_4),
];

pub struct Station {
    pub name: String,
    /// Mean sea level above chart datum, in metres.
    pub mean: f64,
    pub constituents: Vec<Constituent>,
}

impl Station {
    /// The predicted height `hours` after the station's epoch.
    pub fn height(&self, hours: f64) -> f64 {
        self.mean
            + self
                .constituents
                .iter()
                .map(|c| c.amplitude * ((c.speed * hours - c.phase) * PI / 180.0).cos())
                .sum::<f64>()
    }

    /// High and low waters over `span` hours, found by stepping a minute at a time.
    pub fn turns(&self, from: f64, span: f64) -> Vec<(f64, f64, bool)> {
        let step = 1.0 / 60.0;
        let mut out = Vec::new();
        let (mut before, mut here) = (self.height(from - step), self.height(from));
        let mut t = from;
        while t < from + span {
            let after = self.height(t + step);
            if (here > before) != (after > here) {
                out.push((t, here, here > before));
            }
            (before, here, t) = (here, after, t + step);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pure_m2_tide_turns_four_times_a_day() {
        let station = Station {
            name: "test".into(),
            mean: 1.9,
            constituents: vec![Constituent { name: "M2", speed: MAJOR[0].1, amplitude: 1.4, phase: 0.0 }],
        };
        assert_eq!(station.turns(0.0, 24.0).len(), 4);
    }
}
