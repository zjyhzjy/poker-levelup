// Generates the PWA icons (public/icons/*.png) by rendering an SVG in headless
// Chrome and screenshotting it. Re-run after tweaking the artwork:
//   node scripts/generate-icons.mjs
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = new URL("../public/icons/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

// pad = empty margin fraction kept around the motif (maskable safe zone).
function svg(size, pad) {
  const inner = size * (1 - pad * 2);
  const cx = size / 2;
  const ring = inner * 0.46;
  const club = inner * 0.62;
  const corner = size * 0.22;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <radialGradient id="bg" cx="38%" cy="28%" r="85%">
      <stop offset="0%" stop-color="#11704c"/>
      <stop offset="58%" stop-color="#0a4a31"/>
      <stop offset="100%" stop-color="#05311f"/>
    </radialGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffe9a6"/>
      <stop offset="50%" stop-color="#e0a83d"/>
      <stop offset="100%" stop-color="#9a5c13"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${corner}" ry="${corner}" fill="url(#bg)"/>
  <circle cx="${cx}" cy="${cx}" r="${ring}" fill="none" stroke="url(#gold)" stroke-width="${size * 0.034}" opacity="0.92"/>
  <text x="${cx}" y="${cx}" dy="0.35em" text-anchor="middle" fill="#f6efdb"
        font-family="Georgia, 'Times New Roman', serif" font-weight="900" font-size="${club}">&#9827;</text>
</svg>`;
}

const SPECS = [
  { name: "icon-192.png", size: 192, pad: 0.0 },
  { name: "icon-512.png", size: 512, pad: 0.0 },
  { name: "icon-maskable-512.png", size: 512, pad: 0.13 },
  { name: "apple-touch-icon.png", size: 180, pad: 0.06 },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  for (const { name, size, pad } of SPECS) {
    const page = await browser.newPage();
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;padding:0">${svg(size, pad)}</body></html>`,
      { waitUntil: "domcontentloaded" }
    );
    await new Promise((r) => setTimeout(r, 150));
    await page.screenshot({ path: `${OUT}${name}`, clip: { x: 0, y: 0, width: size, height: size }, omitBackground: false });
    await page.close();
    console.log("wrote", name);
  }
} finally {
  await browser.close();
}
console.log("icons done");
