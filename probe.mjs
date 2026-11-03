// Jednorázová diagnostika: co tvcom nabízí za obrázky / video URL.
import * as cheerio from "cheerio";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" };
const get = async (u, h = {}) => { const r = await fetch(u, { headers: { ...UA, ...h } }); console.log(`\n### ${r.status} ${u} (${r.headers.get("content-type")})`); return r.text(); };
const urls = (t) => [...new Set(t.match(/(https?:)?\/\/[^\s"'<>()\\]+/g) || [])];
const interesting = (t) => urls(t).filter(u => /\.(jpe?g|png|webp|m3u8|mp4|json)|poster|thumb|image|img|cdn|stream|vod|hls|api/i.test(u));

const league = await get("https://www.tvcom.cz/Zapasy/Sport-Basketbal/Soutez-Kooperativa-NBL/Sezona-2026-2027/");
const $ = cheerio.load(league);
const links = [...new Set($('a[href*="/Zapas/Sport-Basketbal/Soutez-Kooperativa-NBL/"]').map((_, e) => $(e).attr("href")).get())].filter(h => /Srsni|Sršni|srsni/i.test(h)).slice(0, 2);
console.log("match links:", links);
console.log("league imgs:", $("img").map((_, e) => $(e).attr("src") || $(e).attr("data-src")).get().slice(0, 40));

for (const l of links) {
  const url = l.startsWith("http") ? l : "https://www.tvcom.cz" + l;
  const html = await get(url);
  const d = cheerio.load(html);
  console.log("meta images:", d('meta[property^="og:"], meta[name^="twitter:"]').map((_, e) => `${d(e).attr("property") || d(e).attr("name")}=${d(e).attr("content")}`).get());
  console.log("imgs:", d("img").map((_, e) => d(e).attr("src") || d(e).attr("data-src")).get());
  console.log("interesting:", interesting(html));
  const g = html.match(/embed\.tvcom\.cz\/([a-f0-9-]{20,})\//i);
  if (!g) continue;
  const embedUrl = `https://embed.tvcom.cz/${g[1]}/`;
  const e = await get(embedUrl, { Referer: url });
  console.log("EMBED interesting:", interesting(e));
  console.log("EMBED head 3000:\n", e.slice(0, 3000));
  console.log("EMBED script tail:\n", e.slice(-3000));
  for (const s of cheerio.load(e)("script[src]").map((_, x) => cheerio.load(e)(x).attr("src")).get()) console.log("script:", s);
  break;
}
