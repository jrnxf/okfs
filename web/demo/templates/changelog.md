# Changelog

## 2.14.0

- `levelAt` draws between the two readings around a time, instead of taking the nearest
- `turns` smooths over three readings first, so a gust no longer makes a false high water
- New: `rangeOf(day)` for the high and low of one day in one call

## 2.13.2

- Fix: a station with no readings for a day no longer throws in `turns`

## 2.13.0

- Readings carry their gauge's offset, so a height is right even when the gauge moves
- Heights round to the centimetre in `formatHeight`, as the tide tables do
