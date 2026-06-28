#!/usr/bin/env node
// Fetches FIFA World Cup 2026 results from ESPN's public scoreboard API and
// writes scores.json keyed by our internal match number (`n`).
//
// Mapping is done by the exact UTC kickoff instant (our ET + 4h == ESPN UTC),
// disambiguating simultaneous kickoffs by normalized team name. The schedule is
// the single source of truth in index.html, so we parse MATCHES out of it
// rather than duplicating the fixture list here.
//
// Zero dependencies. Run: `node update-scores.js`

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = __dirname;
const INDEX = path.join(ROOT, "index.html");
const OUT = path.join(ROOT, "scores.json");

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";

// ---------- Tournament date range (UTC days, padded a day each side) ----------
const RANGE_START = "2026-06-10";
const RANGE_END = "2026-07-20";

// ---------- Load fixtures from index.html (single source of truth) ----------
function loadMatches() {
  const html = fs.readFileSync(INDEX, "utf8");
  const m = html.match(/const MATCHES\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error("Could not locate MATCHES array in index.html");
  return JSON.parse(m[1]);
}

// ET (UTC-4 during tournament) -> UTC instant, normalized to YYYY-MM-DDTHH:MM.
function utcKey(dateStr, etStr) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [hh, mm] = etStr.split(":").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, hh + 4, mm));
  return t.toISOString().slice(0, 16);
}

function normName(s) {
  let n = (s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase().replace(/[^a-z0-9]/g, "");
  const ALIASES = {
    bosniaherzegovina: "bosniaandherzegovina",
    congodr: "drcongo",
    drcongo: "drcongo",
    turkey: "turkiye",
    cotedivoire: "ivorycoast",
    korearepublic: "southkorea",
    republicofkorea: "southkorea",
    usa: "unitedstates",
    czechrepublic: "czechia",
  };
  return ALIASES[n] || n;
}

// ---------- HTTP ----------
function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "wc26-watch-planner" } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`Bad JSON from ${url}: ${e.message}`)); }
        });
      })
      .on("error", reject);
  });
}

function datesInRange(start, end) {
  const out = [];
  let d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last) {
    out.push(
      `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
        d.getUTCDate()
      ).padStart(2, "0")}`
    );
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

// Short status code from ESPN's verbose status name.
function statusCode(typeName, state) {
  if (typeName === "STATUS_FULL_TIME" || state === "post") return "FT";
  if (typeName === "STATUS_HALFTIME") return "HT";
  if (state === "in") return "LIVE";
  return "PRE";
}

async function main() {
  const matches = loadMatches();

  // index: utcKey -> [match, ...]
  const byInstant = new Map();
  for (const mt of matches) {
    const key = utcKey(mt.date, mt.et);
    if (!byInstant.has(key)) byInstant.set(key, []);
    byInstant.get(key).push(mt);
  }

  // Collect ESPN events across the whole range, deduped by event id.
  const events = new Map();
  for (const ds of datesInRange(RANGE_START, RANGE_END)) {
    let data;
    try { data = await getJson(`${ESPN}?dates=${ds}`); }
    catch (e) { console.error(`  warn: ${ds} -> ${e.message}`); continue; }
    for (const ev of data.events || []) events.set(ev.id, ev);
  }

  const scores = {};
  // The 48 real teams (all appear in the group stage) — used to tell whether a
  // knockout fixture's teams are actually determined yet vs. still a placeholder.
  const realTeams = new Set();
  for (const mt of matches) {
    if (mt.round === "group") { realTeams.add(normName(mt.home)); realTeams.add(normName(mt.away)); }
  }

  const koTeams = {}; // n -> { h, a } actual (normalized) teams for knockout fixtures
  let mapped = 0, unmatched = 0;
  for (const ev of events.values()) {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) continue;
    const st = comp.status && comp.status.type;
    if (!st) continue;
    const code = statusCode(st.name, st.state);

    const sides = {};
    for (const c of comp.competitors || []) sides[c.homeAway] = c;
    const home = sides.home, away = sides.away;
    if (!home || !away) continue;

    const key = ev.date.slice(0, 16); // already UTC ...THH:MM
    const candidates = byInstant.get(key);
    if (!candidates) { unmatched++; continue; }

    const eh = normName(home.team.displayName);
    const ea = normName(away.team.displayName);
    let pick = candidates[0];
    if (candidates.length > 1) {
      // disambiguate simultaneous (group) kickoffs by best team-name overlap
      let best = -1;
      for (const cand of candidates) {
        const ch = normName(cand.home), ca = normName(cand.away);
        const score = (ch === eh) + (ca === ea) + (ch === ea) + (ca === eh);
        if (score > best) { best = score; pick = cand; }
      }
    }

    // Once the group stage resolves them, record knockout fixtures' actual teams
    // (even before kickoff) so the bracket shows real matchups instead of a
    // standings-based projection — this also fixes third-place slot ambiguity.
    if (pick.round !== "group" && realTeams.has(eh) && realTeams.has(ea)) {
      koTeams[pick.n] = { h: eh, a: ea };
    }

    if (code === "PRE") continue;            // no score worth recording yet
    if (home.score == null || away.score == null) continue;

    // h/a are ESPN's home/away goals; eh/ea are the (normalized) ESPN team names
    // so consumers can attribute goals to the right team regardless of whether
    // our fixture lists the teams in the same home/away order as ESPN.
    scores[pick.n] = {
      h: Number(home.score),
      a: Number(away.score),
      eh, ea,
      s: code,
      clock: st.shortDetail || st.detail || "",
    };
    mapped++;
  }

  const payload = { updated: new Date().toISOString(), scores, koTeams };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 0) + "\n");
  console.log(`Wrote ${OUT}: ${mapped} results mapped, ${unmatched} unmatched.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
