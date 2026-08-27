// Sršni TV — scraper
//
// Co dělá:
// 1. Stáhne stránku Maxa NBL na tvcom.cz (server-rendered HTML, aktuální sezóna).
// 2. Vyfiltruje jen zápasy Sršňů (podle "Sršni" v názvu týmu).
// 3. U zápasů, které ještě nemáme vyřešené (bez embed GUID), stáhne detail
//    zápasu a zkusí z něj vytáhnout <iframe src="//embed.tvcom.cz/{GUID}/">.
// 4. VÝSLEDEK SLOUČÍ s tím, co už v data/matches.json bylo — nikdy ho
//    celý nepřepisuje. Tvcom defaultně ukazuje jen aktuální sezónu, takže
//    bez sloučení by scraper při každém přechodu na novou sezónu tiše
//    smazal historii z té předchozí. Každému zápasu navíc přiřadí "season"
//    (např. "2025/2026"), podle kterého web nabízí přepínač sezón.
//
// Spouští se přes GitHub Actions (viz .github/workflows/scrape.yml), žádný
// ruční krok není potřeba. Lokálně jde spustit přes: node scraper.mjs

import fs from "node:fs";
import * as cheerio from "cheerio";

const BASE = "https://www.tvcom.cz";
const TEAM_MARK = "Sršni";
const OUT_PATH = "data/matches.json";
const REQUEST_DELAY_MS = 500; // ať to na tvcom nebušíme zbytečně rychle

// tvcom defaultně na "holé" adrese ukazuje jen AKTUÁLNÍ sezónu — jakmile se
// sezóna přehoupne, staré zápasy z ní zmizí z výchozí stránky a scraper by
// se k nim už nikdy nedostal (přesně tohle se stalo při přechodu na
// 2026/2027 — 31 z 35 zápasů 2025/2026 zůstalo napořád bez embedu).
// Řešení: scraper prochází i explicitní adresu MINULÉ sezóny, dokud se jí
// nepodaří dohledat embed. Obě adresy se počítají dynamicky podle
// aktuálního data, takže se kód nemusí každý rok ručně upravovat.
function seasonSlug(now, seasonsBack) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1-12
  let startYear = m >= 8 ? y : y - 1; // sezóna běží srpen -> červenec
  startYear -= seasonsBack;
  return `${startYear}-${startYear + 1}`;
}

function buildLeagueUrls(now) {
  return [0, 1].map(
    (back) =>
      `${BASE}/Zapasy/Sport-Basketbal/Soutez-Kooperativa-NBL/Sezona-${seasonSlug(now, back)}/`
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept-Language": "cs,en;q=0.8",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} pro ${url}`);
  }
  return await res.text();
}

// "5. 5. 2026" / "5" -> "2025/2026" (sezóna běží srpen-červenec)
function computeSeason(dateStr) {
  const [day, month, year] = dateStr.split(".").map((s) => parseInt(s.trim(), 10));
  return month >= 8 ? `${year}/${year + 1}` : `${year - 1}/${year}`;
}

function matchKey(m) {
  return `${m.date}|${m.time}|${m.home}|${m.away}`;
}

// Vyparsuje jeden <a href="/Zapas/Sport-Basketbal/Soutez-Kooperativa-NBL/...">
// odkaz na zápas z textu odkazu. Formát textu (tak jak ho tvcom vykresluje):
//   "video 5. 5.18:00 Sršni Photomate Písek - BK KVIS Pardubice Basketbal Maxa NBLPlay-off"
//   "video 30. 12. 202517:40 BK ARMEX ENERGY Děčín - Sršni Photomate Písek Basketbal Maxa NBLZákladní část"
// Rok se v textu objevuje jen když zápas není v "aktuálním" roce zobrazení,
// proto rok při jeho absenci dopočítáváme ze sezóny v URL (Sezona-2025-2026).
function parseMatchAnchor(href, rawText) {
  if (!href || !href.includes("/Zapas/Sport-Basketbal/Soutez-Kooperativa-NBL/")) {
    return null;
  }

  let text = rawText.replace(/\s+/g, " ").trim();
  text = text.replace(/^video\s*/i, "");
  text = text.replace(/Studio Basketbal/i, "");

  const dateMatch = text.match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})?(\d{1,2}:\d{2})\s*(.+)$/);
  if (!dateMatch) return null;
  const [, day, month, yearInText, time, rest] = dateMatch;

  const teamsMatch = rest.match(/^(.*?)\s*-\s*(.*?)\s*Basketbal\s*Maxa NBL(.+)$/);
  if (!teamsMatch) return null;
  const home = teamsMatch[1].trim();
  const away = teamsMatch[2].trim();
  const phase = teamsMatch[3].trim();

  if (!home.includes(TEAM_MARK) && !away.includes(TEAM_MARK)) return null;

  let year = yearInText;
  if (!year) {
    const seasonMatch = href.match(/Sezona-(\d{4})-(\d{4})/);
    if (seasonMatch) {
      const [, y1, y2] = seasonMatch;
      year = Number(month) >= 8 ? y1 : y2; // srpen-prosinec => první rok sezóny
    }
  }
  if (!year) return null;

  const idMatch = href.match(/\/(\d+)-[^/]+\.htm$/);
  if (!idMatch) return null;

  return {
    id: idMatch[1],
    url: href.startsWith("http") ? href : BASE + href,
    date: `${Number(day)}. ${Number(month)}. ${year}`,
    time,
    home,
    away,
    phase,
    us: home.includes(TEAM_MARK) ? "home" : "away",
  };
}

async function getSrsniMatches(leagueUrls) {
  const byId = new Map();

  for (const url of leagueUrls) {
    console.log(`  … prochází ${url}`);
    let html;
    try {
      html = await fetchHtml(url);
    } catch (e) {
      console.warn(`  ! přeskakuji ${url}: ${e.message}`);
      continue; // jedna nedostupná sezóna nesmí shodit celý běh
    }
    const $ = cheerio.load(html);

    $('a[href*="/Zapas/Sport-Basketbal/Soutez-Kooperativa-NBL/"]').each((_, el) => {
      const href = $(el).attr("href");
      const text = $(el).text();
      const parsed = parseMatchAnchor(href, text);
      if (parsed) byId.set(parsed.id, parsed);
    });

    await sleep(REQUEST_DELAY_MS);
  }

  return [...byId.values()];
}

async function getEmbedId(matchUrl) {
  let html;
  try {
    html = await fetchHtml(matchUrl);
  } catch (e) {
    console.warn(`  ! embed nedohledán (${matchUrl}): ${e.message}`);
    return null;
  }
  const m = html.match(/embed\.tvcom\.cz\/([a-f0-9-]{20,})\//i);
  return m ? m[1] : null;
}

// Načte, co už v repu máme — napříč VŠEMI dosud viděnými sezónami.
// Klíčováno stejně jako nová data, aby šlo bezpečně přepisovat/doplňovat.
function loadExisting() {
  const map = new Map();
  if (!fs.existsSync(OUT_PATH)) return map;
  try {
    const prev = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
    for (const m of prev) map.set(matchKey(m), m);
  } catch (e) {
    console.warn(`Nepodařilo se přečíst existující ${OUT_PATH}, začínám od nuly: ${e.message}`);
  }
  return map;
}

function toTimestamp(m) {
  const [d, mo, y] = m.date.split(".").map((s) => Number(s.trim()));
  const [hh, mm] = m.time.split(":").map(Number);
  return new Date(y, mo - 1, d, hh, mm).getTime();
}

async function main() {
  const now = new Date();
  const leagueUrls = buildLeagueUrls(now);
  console.log(`Stahuji rozpis Maxa NBL (aktuální + minulá sezóna):`);
  const found = await getSrsniMatches(leagueUrls);
  console.log(`Nalezeno ${found.length} zápasů Sršňů na tvcom.cz`);

  // Start: vše, co už máme uložené (klidně i z dřívějších sezón).
  const merged = loadExisting();
  console.log(`V repu už bylo ${merged.size} zápasů (napříč sezónami)`);

  for (const m of found) {
    const key = matchKey(m);
    const existing = merged.get(key);
    let embed = existing?.embed ?? null;

    if (!embed) {
      try {
        embed = await getEmbedId(m.url);
        await sleep(REQUEST_DELAY_MS);
      } catch (e) {
        console.warn(`  ! Nepodařilo se načíst detail (${m.url}): ${e.message}`);
      }
    }

    merged.set(key, {
      date: m.date,
      time: m.time,
      home: m.home,
      away: m.away,
      phase: m.phase,
      us: m.us,
      season: computeSeason(m.date),
      ...(embed ? { embed } : {}),
    });
  }

  // Starším záznamům (z doby před zavedením "season") sezónu dopočítáme.
  for (const [key, m] of merged) {
    if (!m.season) merged.set(key, { ...m, season: computeSeason(m.date) });
  }

  const result = [...merged.values()].sort((a, b) => toTimestamp(b) - toTimestamp(a));

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2) + "\n", "utf8");

  const withVideo = result.filter((m) => m.embed).length;
  const seasons = [...new Set(result.map((m) => m.season))].sort();
  console.log(`Uloženo ${OUT_PATH}: ${result.length} zápasů (sezóny: ${seasons.join(", ")}), ${withVideo} s videem.`);
}

main().catch((err) => {
  console.error("Scraper selhal:", err);
  process.exit(1);
});
