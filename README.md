# Train Lookup — NJ Transit scheduled positions

Enter a **train number + date + time** and see where that NJ Transit train was
scheduled to be at that moment — e.g. *Train 1625 at 5:00 PM → "Between
Wood-Ridge and Teterboro, next stop Teterboro 5:02 PM"* — with the position
pinned on a map and the full stop schedule below.

Companion app to [weather-lookup](https://github.com/EABuilderLabs/weather-lookup):
same idea (one page, one question, one answer), same styling.

## Using it

Open `index.html` in any browser — no server or install needed. The map tiles
(OpenStreetMap) are the only thing that needs internet; everything else is local.

Covers all NJ Transit commuter rail lines (light rail excluded — those vehicles
don't carry public train numbers). Positions between stations are interpolated
on a straight line from the schedule, and are **scheduled, not actual** — a
delayed or cancelled train will not be reflected.

## Refreshing the data

Schedule data comes from NJ Transit's public GTFS feed and covers roughly the
current schedule period (see the footer of the app for the exact window).
NJ Transit publishes new schedules a few times a year. To update:

```
node tools/build-data.mjs
```

That downloads the latest `rail_data.zip` from njtransit.com and rebuilds
`data.js` (~0.7 MB). Requires Node 18+ on Windows (uses the built-in `tar`
to extract). No npm dependencies.

Note: each feed only contains its own schedule period, so dates before the
current feed's window can't be looked up.

## Files

- `index.html` — the whole app (UI + lookup logic)
- `data.js` — generated schedule data (`window.TT_DATA`)
- `tools/build-data.mjs` — GTFS → `data.js` build script
