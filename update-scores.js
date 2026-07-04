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

// ---------- Load fixtures + flags from index.html (single source of truth) ----------
function loadMatches() {
  const html = fs.readFileSync(INDEX, "utf8");
  const m = html.match(/const MATCHES\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error("Could not locate MATCHES array in index.html");
  return JSON.parse(m[1]);
}
function loadFlags() {
  const html = fs.readFileSync(INDEX, "utf8");
  const m = html.match(/const FLAGS\s*=\s*(\{[\s\S]*?\});/);
  if (!m) throw new Error("Could not locate FLAGS map in index.html");
  return JSON.parse(m[1].replace(/,\s*}/g, "}"));
}

const ROUND_LABELS = {
  r32: "Round of 32", r16: "Round of 16", qf: "Quarter-final",
  sf: "Semi-final", third: "3rd-place match", final: "Final"
};

// From completed knockout games, list teams knocked out (loser of each FT match),
// with display names/flags resolved, most recent first. Penalty-shootout draws
// are skipped (the loser isn't inferable from the score alone).
function computeEliminated(matches, scores, koTeams, flags, teamIds) {
  const byN = {};
  for (const m of matches) byN[m.n] = m;
  const canon = {}; // normalized -> { name, flag }
  for (const name of Object.keys(flags)) canon[normName(name)] = { name, flag: flags[name] };

  const out = [];
  for (const n of Object.keys(koTeams)) {
    const M = byN[n], sc = scores[n], kt = koTeams[n];
    if (!M || M.round === "group" || !sc || sc.s !== "FT") continue;
    // goals for koTeams home/away, oriented by team name
    const hg = kt.h === sc.eh ? sc.h : sc.a;
    const ag = kt.a === sc.ea ? sc.a : sc.h;
    if (hg === ag) continue; // shootout — winner not in score
    const loserNorm = hg > ag ? kt.a : kt.h;
    const winnerNorm = hg > ag ? kt.h : kt.a;
    const L = canon[loserNorm], W = canon[winnerNorm];
    if (!L || !W) continue;
    const lg = Math.min(hg, ag), wg = Math.max(hg, ag);
    out.push({
      team: L.name, flag: L.flag, teamId: (teamIds && teamIds[loserNorm]) || null,
      round: M.round, roundLabel: ROUND_LABELS[M.round] || M.round,
      lostTo: W.name, lostToFlag: W.flag, score: `${lg}–${wg}`,
      matchN: M.n, date: M.date, city: M.city
    });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.matchN - a.matchN));
  return out;
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
  const teamIds = {}; // normalized team name -> ESPN team id (for roster lookups)
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

    const eh = normName(home.team.displayName);
    const ea = normName(away.team.displayName);

    // Exact kickoff instant, else any fixture within ±2h — real kickoffs
    // sometimes shift an hour vs our schedule (match 79 did); ambiguous
    // near-misses must agree on a team name.
    let candidates = byInstant.get(ev.date.slice(0, 16));
    if (!candidates) {
      const t = Date.parse(ev.date);
      const near = matches.filter((mt) => {
        const [y, mo, d] = mt.date.split("-").map(Number);
        const [hh, mm] = mt.et.split(":").map(Number);
        return Math.abs(Date.UTC(y, mo - 1, d, hh + 4, mm) - t) <= 2 * 3600 * 1000;
      });
      if (near.length === 1) candidates = near;
      else {
        const byName = near.filter((mt) =>
          [mt.home, mt.away].some((x) => { const n = normName(x); return n === eh || n === ea; }));
        candidates = byName.length ? byName : null;
      }
    }
    if (!candidates) { unmatched++; continue; }
    if (home.team.id) teamIds[eh] = home.team.id;
    if (away.team.id) teamIds[ea] = away.team.id;
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

  const flags = loadFlags();
  const eliminated = computeEliminated(matches, scores, koTeams, flags, teamIds);
  const payload = { updated: new Date().toISOString(), scores, koTeams, eliminated };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 0) + "\n");
  console.log(`Wrote ${OUT}: ${mapped} results mapped, ${unmatched} unmatched.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
