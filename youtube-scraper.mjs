// Sršni TV — YouTube scraper
//
// Co dělá:
// 1. Stáhne RSS (Atom) feed YouTube kanálu Sršňů — vrací posledních ~15 videí.
// 2. Z každého <entry> vytáhne videoId, název, datum publikace a odkaz.
// 3. VÝSLEDEK SLOUČÍ s tím, co už v data/youtube.json bylo — nikdy ho celý
//    nepřepisuje. RSS vrací jen posledních ~15 videí, ale díky sloučení se
//    seznam sám postupně nabaluje, jak přibývají nová videa (starší, která
//    už z feedu vypadla, zůstanou v souboru).
// 4. Každému videu přiřadí "season" (např. "2026/2027") podle data publikace,
//    aby ho web zařadil do stejného přepínače sezón jako zápasy z tvcomu.
//
// Spouští se přes GitHub Actions (viz .github/workflows/scrape.yml) vedle
// scraperu zápasů. Lokálně: node youtube-scraper.mjs
//
// Pozn.: YouTube RSS endpoint (feeds/videos.xml) občas u některých kanálů
// vrací 404. Když by to náš kanál potkalo, scraper to jen zaloguje a skončí
// bez chyby (existující youtube.json nechá být) — nespadne celý workflow.
// Záložní cesta v takovém případě je yt-dlp, viz komentář na konci souboru.

import fs from "node:fs";

const CHANNEL_ID = "UCo6dlK2efMmxibG4_mTaIvA"; // @srsnipisek812 — Sršni Písek
const FEED_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const OUT_PATH = "data/youtube.json";

// Sezóna běží srpen -> červenec; formát "2026/2027" (stejně jako u zápasů).
function seasonOf(date) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1; // 1-12
  const startYear = m >= 8 ? y : y - 1;
  return `${startYear}/${startYear + 1}`;
}

// "17. 1. 2026" — den a měsíc bez úvodní nuly (jako v matches.json).
function czDate(date) {
  return `${date.getDate()}. ${date.getMonth() + 1}. ${date.getFullYear()}`;
}
function czTime(date) {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// Dekódování XML entit v názvu videa.
function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&"); // &amp; až nakonec, ať nerozbije ostatní
}

function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}

async function main() {
  const res = await fetch(FEED_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; SrsniTV-Scraper/1.0; +https://srsni.com/tv)",
    },
  });

  if (!res.ok) {
    console.error(
      `RSS feed vrátil HTTP ${res.status} (${FEED_URL}). ` +
        `Existující ${OUT_PATH} nechávám beze změny. ` +
        `Pokud to trvá, přepni na yt-dlp fallback (viz konec souboru).`
    );
    return; // nespadneme, jen tenhle běh přeskočíme
  }

  const xml = await res.text();
  const entries = xml.split("<entry>").slice(1); // první kus je hlavička feedu

  const scraped = [];
  for (const raw of entries) {
    const block = raw.split("</entry>")[0];
    const videoId = pick(block, "yt:videoId");
    const titleRaw = pick(block, "title");
    const published = pick(block, "published");
    if (!videoId || !titleRaw || !published) continue;

    const date = new Date(published);
    scraped.push({
      videoId,
      title: decodeXml(titleRaw),
      url: `https://www.youtube.com/watch?v=${videoId}`,
      published, // ISO — frontend podle něj řadí
      date: czDate(date),
      time: czTime(date),
      season: seasonOf(date),
    });
  }

  if (scraped.length === 0) {
    console.error("Feed se načetl, ale nenašel jsem žádné <entry>. Nechávám data beze změny.");
    return;
  }

  // Sloučení s existujícími daty — klíčem je videoId, staré záznamy se
  // zachovají i když už z feedu vypadly.
  let prev = [];
  if (fs.existsSync(OUT_PATH)) {
    try {
      prev = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
    } catch {
      prev = [];
    }
  }

  const byId = new Map();
  for (const v of prev) byId.set(v.videoId, v);
  for (const v of scraped) byId.set(v.videoId, v); // čerstvá verze přepíše starou

  const result = [...byId.values()].sort(
    (a, b) => new Date(b.published) - new Date(a.published)
  );

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log(
    `Hotovo: ${scraped.length} videí z feedu, celkem ${result.length} v ${OUT_PATH}.`
  );
}

main().catch((err) => {
  console.error("Chyba scraperu:", err);
  process.exit(1);
});

// ── Záložní cesta (jen kdyby RSS trvale 404oval) ──────────────────────────
// yt-dlp umí vytáhnout metadata bez API klíče:
//   yt-dlp --flat-playlist --playlist-end 15 -J \
//     "https://www.youtube.com/channel/UCo6dlK2efMmxibG4_mTaIvA/videos"
// Z výstupního JSON se berou pole `id` (videoId) a `title`. Datum publikace
// je potřeba dotáhnout per-video, takže pro řazení chronologicky s tvcomem je
// RSS pohodlnější — proto je primární cesta RSS.
