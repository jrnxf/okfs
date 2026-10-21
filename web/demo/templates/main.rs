//! Reads every gauge on the network once a minute and writes what it read to the archive.

use std::time::Duration;

use anyhow::Context;
use gauge_proto::{Frame, Gauge};
use station_db::Archive;
use tokio::time::interval;
use tracing::{info, warn};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    let config = config::load().context("reading gauges.toml")?;
    let archive = Archive::open(&config.archive).await?;
    let mut gauges: Vec<Gauge> = config.gauges.iter().map(Gauge::new).collect();
    info!(count = gauges.len(), "watching gauges");

    let mut tick = interval(Duration::from_secs(60));
    loop {
        tick.tick().await;
        for gauge in &mut gauges {
            match gauge.read().await {
                Ok(Frame { raw_cm, battery, .. }) => {
                    archive.write(&gauge.station, raw_cm - gauge.offset_cm).await?;
                    if battery < 0.2 {
                        warn!(station = %gauge.station, battery, "battery low");
                    }
                }
                Err(error) => warn!(station = %gauge.station, %error, "no reading"),
            }
        }
    }
}
