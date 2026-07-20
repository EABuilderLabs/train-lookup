// Download historical NJ Transit rail GTFS snapshots from the Transitland archive.
//
// Picks one snapshot per calendar month (the last one fetched that month) from
// START_MONTH onward, plus the newest version, and caches them in archive/ by
// sha1 — already-downloaded snapshots are skipped, so re-running is cheap.
//
// Needs a Transitland API key (free account: https://www.transit.land):
//   --key <key>  or  TRANSITLAND_API_KEY env var  or  a .transitland-key file
//
// Usage:  node tools/fetch-archive.mjs [--key XXXX]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = join(ROOT, 'archive');
const FEED = 'f-dr5-nj~transit~rail';
const API = 'https://transit.land/api/v2/rest';
const START_MONTH = '2020-10'; // Transitland's NJT coverage is continuous from 2020-10-13

function apiKey() {
  const i = process.argv.indexOf('--key');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (process.env.TRANSITLAND_API_KEY) return process.env.TRANSITLAND_API_KEY;
  const f = join(ROOT, '.transitland-key');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  console.error('No Transitland API key. Pass --key, set TRANSITLAND_API_KEY, or create .transitland-key');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, key, asBuffer) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { apikey: key } });
    if (res.status === 429 && attempt <= 5) {
      console.log(`  rate-limited, waiting 65s (attempt ${attempt})...`);
      await sleep(65000);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.json();
  }
}

async function main() {
  const key = apiKey();
  mkdirSync(ARCHIVE, { recursive: true });

  console.log('Listing feed versions...');
  let versions = [], url = `${API}/feeds/${FEED}/feed_versions?limit=100`;
  while (url) {
    const page = await get(url, key);
    versions = versions.concat(page.feed_versions || []);
    url = page.meta && page.meta.next;
  }
  versions.sort((a, b) => (a.fetched_at < b.fetched_at ? -1 : 1));
  console.log(`${versions.length} versions available (oldest ${versions[0].fetched_at.slice(0, 10)})`);

  // Last-fetched version of each month from START_MONTH, plus the newest overall
  const byMonth = new Map();
  for (const v of versions) {
    const month = v.fetched_at.slice(0, 7);
    if (month >= START_MONTH) byMonth.set(month, v);
  }
  byMonth.set('latest', versions[versions.length - 1]);
  const picks = [...new Map([...byMonth.values()].map(v => [v.sha1, v])).values()]
    .sort((a, b) => (a.fetched_at < b.fetched_at ? -1 : 1));
  console.log(`Selected ${picks.length} monthly snapshots`);

  const manifest = [];
  let downloaded = 0, cached = 0;
  for (const v of picks) {
    const name = `${v.fetched_at.slice(0, 10)}_${v.sha1.slice(0, 8)}.zip`;
    const path = join(ARCHIVE, name);
    manifest.push({ file: name, sha1: v.sha1, fetched: v.fetched_at.slice(0, 10),
      calStart: v.earliest_calendar_date, calEnd: v.latest_calendar_date });
    if (existsSync(path)) { cached++; continue; }
    process.stdout.write(`Downloading ${name} ... `);
    const buf = await get(`${API}/feed_versions/${v.sha1}/download`, key, true);
    writeFileSync(path, buf);
    console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
    downloaded++;
    await sleep(1600); // stay friendly to the free-tier rate limit
  }
  writeFileSync(join(ARCHIVE, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Done: ${downloaded} downloaded, ${cached} already cached, manifest.json written.`);
}

main().catch(err => { console.error(err); process.exit(1); });
