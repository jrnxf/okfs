#set document(title: "The harbor in 2025", author: "Tidewater field team")
#set page(paper: "a4", margin: (x: 2.2cm, y: 2.4cm), fill: rgb("#fbf9f4"))
#set text(font: "New Computer Modern", size: 10.5pt, fill: rgb("#1d2a36"))
#set par(justify: true, leading: 0.7em)
#show heading.where(level: 1): set text(size: 26pt, weight: "regular")
#show heading.where(level: 2): set text(size: 13pt, weight: "bold")

#v(1.2cm)
#text(size: 9pt, tracking: 0.14em, fill: rgb("#2f6fb5"))[TIDEWATER · ANNUAL SURVEY]
= The harbor in 2025
#text(size: 12pt, fill: rgb("#5a6b7d"))[Gauges, surge events, and the shape of the channel after the dredging.]
#v(0.6cm)
#line(length: 100%, stroke: 0.6pt + rgb("#c9c2b1"))
#v(0.4cm)

#grid(columns: (1fr, 1fr, 1fr, 1fr), gutter: 10pt,
  ..(("32", "gauges logging"), ("4.71 M", "readings archived"), ("3.66 m", "largest range"), ("+0.42 m", "worst surge")).map(((n, l)) => block(fill: rgb("#efe9dc"), inset: 10pt, radius: 3pt, width: 100%)[
    #text(size: 17pt)[#n] \ #text(size: 8.5pt, fill: rgb("#5a6b7d"))[#l]
  ])
)

#v(0.5cm)
== Summary
Every station in the network logged through the year, with 1.4% of days lost to outages, most of them at the buoys during the November storms. The east channel gauge was resurveyed after the August dredging: its offset moved by 3 cm, and every reading since has been corrected.

The largest tidal range of the year, 3.66 m, came with the king tide of 3 December. The worst surge came on 11 February, when the water stood 0.42 m above the prediction for two hours either side of the 02:30 high water.

== Ranges by station
#table(columns: (2fr, 1fr, 1fr, 1fr), stroke: none, inset: 6pt,
  table.hline(stroke: 0.6pt),
  [*Station*], [*High (m)*], [*Low (m)*], [*Range (m)*],
  table.hline(stroke: 0.4pt),
  [North Pier], [3.48], [0.44], [3.04],
  [East Channel], [3.27], [0.58], [2.69],
  [Salt Marsh], [3.01], [0.97], [2.04],
  [Headland], [3.61], [0.39], [3.22],
  [Oyster Reef], [3.22], [0.71], [2.51],
  table.hline(stroke: 0.6pt),
)

== The channel
The 2 m contour around the oyster reef has moved about 30 m north since the 2021 survey, as the reef grows. The dredged channel is holding its depth: no point surveyed in October was shallower than 4.1 m at chart datum.

#v(1fr)
#text(size: 8.5pt, fill: rgb("#8a8a86"))[Tidewater field team · Prepared from the gauge archive and the October hydrographic survey.]
