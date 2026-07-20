# Train Lookup — NJ Transit scheduled positions

Enter a **train number + date + time** and see where that NJ Transit train was
scheduled to be at that moment — e.g. *Train 1625 at 5:00 PM → "Between
Wood-Ridge and Teterboro, next stop Teterboro 5:02 PM"* — with the position
pinned on a map and the full stop schedule below.

Companion app to [weather-lookup](https://github.com/EABuilderLabs/weather-lookup):
same idea (one page, one question, one answer), same styling.

## Using it

Open `index.html` in any browser, or serve the folder with
`node tools/serve.mjs` and open http://localhost:8035. The map tiles
(OpenStreetMap) are the only thing that needs internet.

Covers all NJ Transit commuter rail lines (light rail excluded — those vehicles
don't carry public train numbers). Positions between stations are interpolated
on a straight line from the schedule, and are **scheduled, not actual** — a
delayed or cancelled train will not be reflected.

## Data layout

- `data.js` — small manifest (`window.TT_META`): which years are covered
- `data/data-YYYY.js` — per-year schedule data, lazy-loaded when a date in
  that year is queried
- Each queried date resolves against the NJ Transit schedule **published
  closest before that date**, so past dates use the timetable that was
  actually in effect.

## Refreshing / extending the data

**Current schedules only** (no account needed):

```
node tools/build-data.mjs
```

Downloads NJ Transit's public `rail_data.zip` and rebuilds the data for the
current schedule period (~3 months). NJ Transit publishes new schedules a few
times a year.

**Historical archive back to Oct 2020** (needs a free Transitland API key with
the complimentary Hobbyist/Academic upgrade — see transit.land/plans-pricing):

```
node tools/fetch-archive.mjs      # downloads ~64 monthly snapshots into archive/
node tools/build-data.mjs         # merges the archive into per-year data files
```

The key is read from a git-ignored `.transitland-key` file (or the
`TRANSITLAND_API_KEY` env var, or `--key`). Snapshots are cached in `archive/`
(also git-ignored), so re-runs only fetch what's new.

Coverage notes: the Transitland archive for NJ Transit rail is continuous from
**2020-10-13**; January–mid-October 2020 has no archived feed (and 2016–2019
exists if ever wanted — adjust `START_MONTH` in `tools/fetch-archive.mjs`).

## Files

- `index.html` — the whole app (UI + lookup logic)
- `tools/build-data.mjs` — GTFS → data files (current feed, or merged archive)
- `tools/fetch-archive.mjs` — pulls historical snapshots from Transitland
- `tools/serve.mjs` — tiny static server for local development
