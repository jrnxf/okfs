# Field notes

A running log from the harbor. Times are local, heights are in metres above chart datum.

## North Pier

The gauge sits on the third piling from the end. It reads **12 cm high** against the staff, so every value in `stations.csv` already has that taken off.

> Low water came forty minutes later than the table said. The wind had been in the east for three days.

### What to bring

1. Staff gauge and the spare batteries
2. Notebook, two pencils
3. The long lens - the herons stand off at about 80 m

## Readings

| Station | High | Low | Range |
| --- | ---: | ---: | ---: |
| North Pier | 3.42 | 0.61 | 2.81 |
| East Channel | 3.18 | 0.74 | 2.44 |
| Salt Marsh | 2.96 | 1.02 | 1.94 |

## Converting a reading

```rust
fn corrected(raw_cm: f64, offset_cm: f64) -> f64 {
    (raw_cm - offset_cm) / 100.0
}
```

Run `plot.py` after each outing to redraw the season chart.
