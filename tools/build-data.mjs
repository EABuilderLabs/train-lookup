// Build data.js for the NJ Transit train position lookup.
//
// Downloads NJ Transit's public rail GTFS feed (or reuses a local zip via
// --zip <path>), filters to commuter rail, and emits a compact data.js
// consumed by index.html as a plain <script> tag so the page works from file://.
//
// Usage:  node tools/build-data.mjs [--zip path\to\rail_data.zip]

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GTFS_URL = 'https://www.njtransit.com/rail_data.zip';
const OUT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data.js');

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

async function main() {
  const zipArg = process.argv.indexOf('--zip');
  const work = mkdtempSync(join(tmpdir(), 'njt-gtfs-'));
  let zipPath;
  try {
    if (zipArg !== -1 && process.argv[zipArg + 1]) {
      zipPath = resolve(process.argv[zipArg + 1]);
      console.log(`Using local zip: ${zipPath}`);
    } else {
      console.log(`Downloading ${GTFS_URL} ...`);
      const res = await fetch(GTFS_URL);
      if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
      zipPath = join(work, 'rail_data.zip');
      writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
      console.log(`Downloaded ${(Buffer.byteLength(readFileSync(zipPath)) / 1e6).toFixed(1)} MB`);
    }

    const gtfsDir = join(work, 'gtfs');
    mkdirSync(gtfsDir, { recursive: true });
    execFileSync('tar', ['-xf', zipPath, '-C', gtfsDir]); // Windows bsdtar extracts zips

    const read = f => parseCsv(readFileSync(join(gtfsDir, f), 'utf8'));
    const routesRaw = read('routes.txt');
    const tripsRaw = read('trips.txt');
    const stopsRaw = read('stops.txt');
    const stopTimesRaw = read('stop_times.txt');
    const calDatesRaw = read('calendar_dates.txt');

    // Commuter rail only (route_type 2) — light rail has no public train numbers.
    const routes = {};
    for (const r of routesRaw) {
      if (r.route_type === '2') routes[r.route_id] = [r.route_long_name, r.route_color || '888888'];
    }

    // exception_type 1 adds a service date, 2 removes one.
    const services = {};
    for (const c of calDatesRaw) {
      (services[c.service_id] ??= new Set());
      if (c.exception_type === '2') services[c.service_id].delete(c.date);
      else services[c.service_id].add(c.date);
    }
    const allDates = Object.values(services).flatMap(s => [...s]).sort();
    const feedStart = allDates[0], feedEnd = allDates[allDates.length - 1];

    const stopSeqByTrip = {};
    for (const st of stopTimesRaw) {
      (stopSeqByTrip[st.trip_id] ??= []).push([
        parseInt(st.stop_sequence, 10),
        st.stop_id,
        hhmmssToMin(st.arrival_time),
        hhmmssToMin(st.departure_time),
      ]);
    }

    const stopName = {};
    for (const s of stopsRaw) stopName[s.stop_id] = s;

    const usedStops = new Set(), usedServices = new Set();
    const trips = [];
    for (const t of tripsRaw) {
      if (!routes[t.route_id]) continue;
      const seq = stopSeqByTrip[t.trip_id];
      if (!seq || seq.length < 2) continue;
      seq.sort((a, b) => a[0] - b[0]);
      const st = seq.map(([, stopId, arr, dep]) => {
        usedStops.add(stopId);
        return [stopId, arr, dep];
      });
      usedServices.add(t.service_id);
      trips.push({ t: t.block_id, r: t.route_id, h: titleCase(t.trip_headsign), s: t.service_id, st });
    }

    const stations = {};
    for (const id of usedStops) {
      const s = stopName[id];
      stations[id] = [titleCase(s.stop_name), parseFloat(s.stop_lat), parseFloat(s.stop_lon)];
    }
    const servicesOut = {};
    for (const id of usedServices) servicesOut[id] = [...services[id]].sort();

    const data = {
      generated: new Date().toISOString().slice(0, 10),
      feedStart, feedEnd,
      routes, stations, services: servicesOut, trips,
    };
    writeFileSync(OUT_FILE, 'window.TT_DATA = ' + JSON.stringify(data) + ';\n');

    const nums = new Set(trips.map(t => t.t));
    console.log(`Wrote ${OUT_FILE}`);
    console.log(`  Feed window : ${feedStart} .. ${feedEnd}`);
    console.log(`  Rail lines  : ${Object.keys(routes).length}`);
    console.log(`  Trips       : ${trips.length} (${nums.size} distinct train numbers)`);
    console.log(`  Stations    : ${Object.keys(stations).length}`);
    console.log(`  Output size : ${(Buffer.byteLength(readFileSync(OUT_FILE)) / 1e6).toFixed(2)} MB`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exit(1); });
