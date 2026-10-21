//! Turns raw gauge readings into corrected tide heights.

use std::collections::BTreeMap;

/// One reading from a staff gauge, in centimetres.
#[derive(Debug, Clone, Copy)]
pub struct Reading {
    pub minute: u32,
    pub raw_cm: f64,
}

pub struct Gauge {
    pub name: &'static str,
    pub offset_cm: f64,
}

impl Gauge {
    /// Height in metres above chart datum.
    pub fn corrected(&self, reading: Reading) -> f64 {
        (reading.raw_cm - self.offset_cm) / 100.0
    }

    /// The highest and lowest corrected heights of a day.
    pub fn range(&self, day: &[Reading]) -> Option<(f64, f64)> {
        let heights = day.iter().map(|&reading| self.corrected(reading));
        let high = heights.clone().fold(f64::MIN, f64::max);
        let low = heights.fold(f64::MAX, f64::min);
        (!day.is_empty()).then_some((high, low))
    }
}

/// Groups readings by the hour they were taken in.
pub fn by_hour(readings: &[Reading]) -> BTreeMap<u32, Vec<Reading>> {
    let mut hours: BTreeMap<u32, Vec<Reading>> = BTreeMap::new();
    for &reading in readings {
        hours.entry(reading.minute / 60).or_default().push(reading);
    }
    hours
}

fn main() {
    let pier = Gauge { name: "North Pier", offset_cm: 12.0 };
    let day = [
        Reading { minute: 0, raw_cm: 354.0 },
        Reading { minute: 370, raw_cm: 73.0 },
        Reading { minute: 745, raw_cm: 349.0 },
    ];
    if let Some((high, low)) = pier.range(&day) {
        println!("{}: high {high:.2} m, low {low:.2} m", pier.name);
    }
}
