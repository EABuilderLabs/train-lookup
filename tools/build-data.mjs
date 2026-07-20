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
const KM_PER_DEG = 111.32;

function havKm(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * Math.PI / 180, dLon = (bLon - aLon) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
}

// Approximate official mileposts per (route, station) by calibrating each
// route's station chain against FRA grade-crossing inventory mileposts.
function computeMileposts(stations, routes, trips, crossings) {
  const byRoute = new Map();
  for (const tr of trips) (byRoute.get(tr.r) ?? byRoute.set(tr.r, []).get(tr.r)).push(tr);
  const out = {};

  for (const [rIdx, rTrips] of byRoute) {
    // 1) Chain distance (km along stop sequence) for every station of the route.
    // Backbone = the trip with the most stops; other trips are aligned to it
    // through shared stations, which places branch stations on the same axis.
    const chain = new Map(); // global station idx -> km
    const backbone = rTrips.reduce((a, b) => (b.st.length > a.st.length ? b : a));
    let acc = 0;
    backbone.st.forEach(([si], i) => {
      if (i > 0) {
        const [, aLat, aLon] = stations[backbone.st[i - 1][0]], [, bLat, bLon] = stations[si];
        acc += havKm(aLat, aLon, bLat, bLon);
      }
      if (!chain.has(si)) chain.set(si, acc);
    });
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const tr of rTrips) {
        const own = []; let c = 0;
        tr.st.forEach(([si], i) => {
          if (i > 0) {
            const [, aLat, aLon] = stations[tr.st[i - 1][0]], [, bLat, bLon] = stations[si];
            c += havKm(aLat, aLon, bLat, bLon);
          }
          own.push([si, c]);
        });
        const known = own.filter(([si]) => chain.has(si));
        if (known.length < 2 || known.length === own.length) continue;
        // 1D least-squares alignment chain ≈ α + β·ownDist over shared stations
        const n = known.length;
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const [si, c2] of known) { const y = chain.get(si); sx += c2; sy += y; sxx += c2 * c2; sxy += c2 * y; }
        const denom = n * sxx - sx * sx;
        if (Math.abs(denom) < 1e-6) continue;
        const beta = (n * sxy - sx * sy) / denom, alpha = (sy - beta * sx) / n;
        for (const [si, c2] of own) {
          if (!chain.has(si)) { chain.set(si, alpha + beta * c2); changed = true; }
        }
      }
      if (!changed) break;
    }

    // 2) Segments between consecutive stations (deduped across trips)
    const segs = new Map();
    for (const tr of rTrips) {
      for (let i = 1; i < tr.st.length; i++) {
        const a = tr.st[i - 1][0], b = tr.st[i][0];
        if (chain.has(a) && chain.has(b)) segs.set(a + '>' + b, [a, b]);
      }
    }

    // 3) Project each crossing onto its best segment → (chainKm, officialMp)
    const calib = [];
    for (const x of crossings) {
      const mp = parseFloat(x.mp);
      if (!isFinite(mp) || mp <= 0 || x.lat == null) continue;
      let best = null;
      for (const [, [a, b]] of segs) {
        const [, aLat, aLon] = stations[a], [, bLat, bLon] = stations[b];
        const cos = Math.cos(aLat * Math.PI / 180);
        const ax = aLon * cos, ay = aLat, bx = bLon * cos, by = bLat;
        const px = x.lon * cos, py = x.lat;
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-12) continue;
        const t = ((px - ax) * dx + (py - ay) * dy) / len2;
        if (t < 0 || t > 1) continue;
        const perpKm = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * KM_PER_DEG;
        if (perpKm > 0.4) continue;
        const chainKm = chain.get(a) + t * (chain.get(b) - chain.get(a));
        if (!best || perpKm < best.perp) best = { perp: perpKm, chainKm, mp };
      }
      if (best) calib.push(best);
    }
    if (calib.length < 3) continue;

    // 4) Robust global fit mp ≈ a + b·chainKm, rejecting outliers twice
    // (wrong-branch matches, typo'd inventory records), then piecewise-linear
    // interpolation through the survivors for each station's milepost.
    let pts = calib;
    let a = 0, b = 0;
    for (let round = 0; round < 3; round++) {
      const n = pts.length;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const p of pts) { sx += p.chainKm; sy += p.mp; sxx += p.chainKm * p.chainKm; sxy += p.chainKm * p.mp; }
      const denom = n * sxx - sx * sx;
      if (Math.abs(denom) < 1e-6) break;
      b = (n * sxy - sx * sy) / denom; a = (sy - b * sx) / n;
      const keep = pts.filter(p => Math.abs(a + b * p.chainKm - p.mp) <= 1.5);
      if (keep.length === pts.length || keep.length < 3) break;
      pts = keep;
    }
    // Quality gate: a real calibration is dense, tightly linear, and has a
    // slope near ±1 mile per 1.609 km. Lines without genuine grade crossings
    // (e.g. the NEC) produce scattered junk here and are dropped entirely.
    const meanMp = pts.reduce((s, p) => s + p.mp, 0) / pts.length;
    let ssRes = 0, ssTot = 0;
    for (const p of pts) {
      ssRes += (p.mp - (a + b * p.chainKm)) ** 2;
      ssTot += (p.mp - meanMp) ** 2;
    }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    if (pts.length < 5 || r2 < 0.985 || Math.abs(b) < 0.45 || Math.abs(b) > 0.85) {
      console.log(`  mileposts: ${routes[rIdx][0]} — rejected (${pts.length} pts, R²=${r2.toFixed(3)}, slope=${b.toFixed(2)})`);
      continue;
    }
    pts.sort((p, q) => p.chainKm - q.chainKm);

    const routeName = routes[rIdx][0];
    const mps = {};
    for (const [si, d] of chain) {
      let mp = null;
      if (d <= pts[0].chainKm) {
        mp = pts[0].chainKm - d <= 4.8 ? pts[0].mp + b * (d - pts[0].chainKm) : null;
      } else if (d >= pts[pts.length - 1].chainKm) {
        const last = pts[pts.length - 1];
        mp = d - last.chainKm <= 4.8 ? last.mp + b * (d - last.chainKm) : null;
      } else {
        for (let i = 1; i < pts.length; i++) {
          if (d <= pts[i].chainKm) {
            const p = pts[i - 1], q = pts[i];
            const f = (d - p.chainKm) / (q.chainKm - p.chainKm || 1);
            mp = p.mp + f * (q.mp - p.mp);
            break;
          }
        }
      }
      if (mp != null && mp >= 0) mps[stations[si][0]] = Math.round(mp * 10) / 10;
    }
    // Enforce monotonicity along the backbone: a station whose MP fights the
    // line's direction was calibrated off a neighboring line's crossings —
    // keep the longest consistent subsequence and drop the rest.
    const nameChain = new Map();
    for (const [si, d] of chain) nameChain.set(stations[si][0], d);
    const resid = n => Math.abs(mps[n] - (a + b * nameChain.get(n)));
    for (let guard = 0; guard < 6; guard++) {
      const seq = backbone.st.map(([si]) => stations[si][0])
        .filter((n, i, arr) => mps[n] !== undefined && arr.indexOf(n) === i);
      if (seq.length < 3) break;
      const dir = Math.sign(mps[seq[seq.length - 1]] - mps[seq[0]]) || 1;
      let victim = null;
      for (let i = 1; i < seq.length; i++) {
        if (Math.sign(mps[seq[i]] - mps[seq[i - 1]]) === -dir) {
          // Two stations disagree with the line's direction — the one that
          // strays furthest from the global fit was calibrated off a
          // neighboring line's crossings.
          victim = resid(seq[i]) > resid(seq[i - 1]) ? seq[i] : seq[i - 1];
          break;
        }
      }
      if (!victim) break;
      console.log(`    dropped ${routeName} / ${victim} (breaks monotonic chain, off fit by ${resid(victim).toFixed(1)} mi)`);
      delete mps[victim];
    }

    // Backfill interior gaps (dropped outliers, crossing-free stretches) by
    // interpolating between the nearest trusted stations on either side.
    const seqAll = backbone.st.map(([si]) => stations[si][0]).filter((n, i, arr) => arr.indexOf(n) === i);
    for (let i = 0; i < seqAll.length; i++) {
      if (mps[seqAll[i]] !== undefined) continue;
      let p = i - 1; while (p >= 0 && mps[seqAll[p]] === undefined) p--;
      let q = i + 1; while (q < seqAll.length && mps[seqAll[q]] === undefined) q++;
      if (p < 0 || q >= seqAll.length) continue;
      const dp = nameChain.get(seqAll[p]), dq = nameChain.get(seqAll[q]), d = nameChain.get(seqAll[i]);
      const f = (d - dp) / ((dq - dp) || 1);
      mps[seqAll[i]] = Math.round((mps[seqAll[p]] + f * (mps[seqAll[q]] - mps[seqAll[p]])) * 10) / 10;
      console.log(`    backfilled ${routeName} / ${seqAll[i]} = MP ${mps[seqAll[i]]}`);
    }

    if (Object.keys(mps).length) out[routeName] = mps;
    console.log(`  mileposts: ${routeName} — ${pts.length} crossings → ${Object.keys(mps).length} stations`);
  }
  return out;
}
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

    const crossingsPath = join(ROOT, 'tools', 'crossings.json');
    if (existsSync(crossingsPath)) {
      console.log('Calibrating mileposts from FRA crossing inventory...');
      meta.mileposts = computeMileposts(
        stations, routes, [...tripByKey.values()], JSON.parse(readFileSync(crossingsPath, 'utf8')));
    }
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
