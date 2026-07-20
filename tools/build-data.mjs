// Build the app's schedule data from NJ Transit GTFS feeds.
//
// With archive/ populated (via tools/fetch-archive.mjs): merges every archived
// snapshot so each calendar date resolves against the schedule published
// closest before it. Without an archive: downloads the current public feed and
// builds from that alone. Either way the output is:
//
//   data.js            — window.TT_META  (coverage manifest, loaded up front)
//   data/data-YYYY.js  — window.TT_YEARS[YYYY]  (per-year data, lazy-loaded)
//
// Trips identical across snapshots are deduplicated; each trip carries a
// per-year day bitmask (hex) of the dates on which it was the current schedule.
//
// Usage:  node tools/build-data.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = join(ROOT, 'archive');
const GTFS_URL = 'https://www.njtransit.com/rail_data.zip';

function parseCsv(text) {
  // RFC 4180: quoted fields may contain commas, quotes ("" escape), newlines.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows
    .filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''))
    .map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function hhmmssToMin(t) {
  // GTFS times can exceed 24:00:00 for after-midnight trains; keep raw minutes.
  const [h, m] = t.split(':');
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s\-\/(.])([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
}

const DAY_MS = 86400000;
function keyToDate(k) { return new Date(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8)); }
function dateToKey(d) {
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

// Expand one feed's calendar.txt + calendar_dates.txt into per-service date sets
function expandServices(gtfsDir) {
  const services = {};
  const calPath = join(gtfsDir, 'calendar.txt');
  if (existsSync(calPath)) {
    const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for (const c of parseCsv(readFileSync(calPath, 'utf8'))) {
      const set = (services[c.service_id] ??= new Set());
      for (let d = keyToDate(c.start_date); ; d = new Date(d.getTime() + DAY_MS)) {
        const k = dateToKey(d);
        if (k > c.end_date) break;
        if (c[DOW[d.getDay()]] === '1') set.add(k);
      }
    }
  }
  const cdPath = join(gtfsDir, 'calendar_dates.txt');
  if (existsSync(cdPath)) {
    for (const c of parseCsv(readFileSync(cdPath, 'utf8'))) {
      const set = (services[c.service_id] ??= new Set());
      if (c.exception_type === '2') set.delete(c.date);
      else set.add(c.date);
    }
  }
  return services;
}

async function main() {
  // Snapshot list: the archive if present, else the current public feed
  let snapshots;
  const work = mkdtempSync(join(tmpdir(), 'njt-gtfs-'));
  try {
    const manifestPath = join(ARCHIVE, 'manifest.json');
    if (existsSync(manifestPath)) {
      snapshots = JSON.parse(readFileSync(manifestPath, 'utf8'))
        .map(m => ({ path: join(ARCHIVE, m.file), fetched: m.fetched.replaceAll('-', '') }))
        .sort((a, b) => (a.fetched < b.fetched ? -1 : 1));
      console.log(`Merging ${snapshots.length} archived snapshots`);
    } else {
      console.log(`No archive/ — downloading current feed from ${GTFS_URL}`);
      const res = await fetch(GTFS_URL);
      if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
      const zipPath = join(work, 'rail_data.zip');
      writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
      snapshots = [{ path: zipPath, fetched: dateToKey(new Date()) }];
    }

    // Global registries, deduplicated across snapshots
    const stationIdx = new Map();  // NAME -> index
    const stations = [];           // [name, lat, lon]
    const routeIdx = new Map();    // long name -> index
    const routes = [];             // [name, color]
    const tripByKey = new Map();   // content key -> { t, r, h, st, dates:Set }

    for (let i = 0; i < snapshots.length; i++) {
      const snap = snapshots[i];
      // A snapshot "owns" dates from its fetch until the next snapshot's fetch;
      // the first also owns the earlier dates its calendar reaches back to.
      const ownStart = i === 0 ? '00000000' : snap.fetched;
      const ownEnd = i + 1 < snapshots.length ? snapshots[i + 1].fetched : '99999999';

      const gtfsDir = join(work, 'snap');
      rmSync(gtfsDir, { recursive: true, force: true });
      mkdirSync(gtfsDir);
      execFileSync('tar', ['-xf', snap.path, '-C', gtfsDir]); // Windows bsdtar extracts zips

      const read = f => parseCsv(readFileSync(join(gtfsDir, f), 'utf8'));
      const services = expandServices(gtfsDir);

      const railRoutes = {};
      for (const r of read('routes.txt')) {
        if (r.route_type !== '2') continue; // commuter rail only
        const name = r.route_long_name;
        if (!routeIdx.has(name)) { routeIdx.set(name, routes.length); routes.push([name, r.route_color || '888888']); }
        railRoutes[r.route_id] = routeIdx.get(name);
      }

      const stopMeta = {};
      for (const s of read('stops.txt')) stopMeta[s.stop_id] = s;

      const stopSeqByTrip = {};
      for (const st of read('stop_times.txt')) {
        (stopSeqByTrip[st.trip_id] ??= []).push([
          parseInt(st.stop_sequence, 10), st.stop_id,
          hhmmssToMin(st.arrival_time), hhmmssToMin(st.departure_time),
        ]);
      }

      let used = 0;
      for (const t of read('trips.txt')) {
        const rIdx = railRoutes[t.route_id];
        if (rIdx === undefined) continue;
        const seq = stopSeqByTrip[t.trip_id];
        if (!seq || seq.length < 2) continue;
        const svcDates = services[t.service_id];
        if (!svcDates) continue;
        const dates = [...svcDates].filter(d => d >= ownStart && d < ownEnd);
        if (!dates.length) continue;

        seq.sort((a, b) => a[0] - b[0]);
        const st = seq.map(([, stopId, arr, dep]) => {
          const meta = stopMeta[stopId];
          const name = titleCase(meta.stop_name.trim());
          if (!stationIdx.has(name)) {
            stationIdx.set(name, stations.length);
            stations.push([name, parseFloat(meta.stop_lat), parseFloat(meta.stop_lon)]);
          }
          return [stationIdx.get(name), arr, dep];
        });

        const trainNum = (t.block_id || t.trip_short_name || '').trim();
        if (!trainNum) continue;
        const headsign = titleCase(t.trip_headsign);
        const key = trainNum + '|' + rIdx + '|' + headsign + '|' + JSON.stringify(st);
        const entry = tripByKey.get(key) ??
          tripByKey.set(key, { t: trainNum, r: rIdx, h: headsign, st, dates: new Set() }).get(key);
        for (const d of dates) entry.dates.add(d);
        used++;
      }
      console.log(`  ${snap.path.split(/[\\/]/).pop()} (owns ${ownStart}..${ownEnd}): ${used} rail trips`);
    }

    // Split into per-year files with hex day-bitmasks
    const years = {};
    for (const trip of tripByKey.values()) {
      for (const d of trip.dates) {
        const y = d.slice(0, 4);
        ((years[y] ??= new Map()).get(trip) ?? years[y].set(trip, []).get(trip)).push(d);
      }
    }

    const dataDir = join(ROOT, 'data');
    mkdirSync(dataDir, { recursive: true });
    const meta = { generated: new Date().toISOString().slice(0, 10), years: {} };
    let total = 0;
    for (const y of Object.keys(years).sort()) {
      const yearStart = keyToDate(y + '0101');
      const yTrips = [], yStationsIdx = new Map(), yStations = [];
      let minD = '99999999', maxD = '00000000';
      for (const [trip, dates] of years[y]) {
        const mask = new Uint8Array(46); // 368 bits covers a year
        for (const d of dates) {
          const doy = Math.round((keyToDate(d) - yearStart) / DAY_MS);
          mask[doy >> 3] |= 1 << (doy & 7);
          if (d < minD) minD = d;
          if (d > maxD) maxD = d;
        }
        const st = trip.st.map(([gi, arr, dep]) => {
          if (!yStationsIdx.has(gi)) { yStationsIdx.set(gi, yStations.length); yStations.push(stations[gi]); }
          return [yStationsIdx.get(gi), arr, dep];
        });
        yTrips.push({ t: trip.t, r: trip.r, h: trip.h, st,
          d: [...mask].map(b => b.toString(16).padStart(2, '0')).join('') });
      }
      const payload = { stations: yStations, routes, trips: yTrips };
      const file = join(dataDir, `data-${y}.js`);
      writeFileSync(file,
        `window.TT_YEARS = window.TT_YEARS || {};\nwindow.TT_YEARS[${y}] = ${JSON.stringify(payload)};\n`);
      const size = Buffer.byteLength(readFileSync(file));
      total += size;
      meta.years[y] = { from: minD, to: maxD, trips: yTrips.length };
      console.log(`data/data-${y}.js  ${(size / 1e6).toFixed(2)} MB  (${yTrips.length} trips, ${minD}..${maxD})`);
    }
    writeFileSync(join(ROOT, 'data.js'), 'window.TT_META = ' + JSON.stringify(meta) + ';\n');
    console.log(`data.js manifest written · total data ${(total / 1e6).toFixed(1)} MB`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exit(1); });
