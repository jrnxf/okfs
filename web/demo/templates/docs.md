# Adding a gauge

A gauge is a staff gauge with a logger strapped to it, on a piling or a buoy. Adding one takes
three steps.

## 1. Survey it in

Read the staff against a known benchmark at two low waters and two high waters. The difference is
the gauge's **offset**, in centimetres. Write it down.

## 2. Name it

Add it to `gauges.toml`:

```toml
[[gauge]]
station = "mill-creek"
offset_cm = -4
depth_m = 2.1
```

## 3. Watch it

`gauge-daemon` picks it up on its next start and writes a file a day to
`archive/mill-creek/`. The dashboard shows it once it has a full day.
