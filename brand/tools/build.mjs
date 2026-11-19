// Builds every LONGYU brand file from ../tokens.json (the mark's geometry and the colours) and the
// wordmark's outline in paths.json, then copies the ones the apps use into place.
// Usage: npm install && npm run build (in brand/tools)
//
// Nothing here is drawn by hand twice: the logo in the app, the favicons, the launcher icon and the
// social images all come from the same numbers, so they cannot drift apart.
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const { wordmark } = JSON.parse(readFileSync(new URL("./paths.json", import.meta.url), "utf8"));
const tokens = JSON.parse(readFileSync(new URL("../tokens.json", import.meta.url), "utf8"));
const C = Object.fromEntries(Object.entries(tokens.color).map(([name, c]) => [name, c.hex]));
const S = tokens.surface;
const M = tokens.mark;
const FONTS = ["Inter-Regular", "Inter-Medium", "Inter-SemiBold", "Sora-SemiBold", "Sora-Bold", "JetBrainsMono-Medium"].map((f) => `${ROOT}apps/mobile/assets/fonts/${f}.ttf`);
/** How round an icon's own corners are, as a share of its width (phones cut their own shape instead). */
const TILE_RADIUS = 0.225;

const round = (v) => String(Math.round(v * 100) / 100);

/** An outline from paths.json, scaled and moved, with the numbers written out (no transform to carry around). */
function place(d, scale, x, y) {
  return d.replace(/([MLQC])([^MLQCZ]*)/g, (_, cmd, args) => cmd + args.trim().split(/\s+/).map((v, i) => round(Number(v) * scale + (i % 2 ? y : x))).join(" "));
}

// --- The mark: an L with the dragon pearl in its arm ----------------------------------------------------

/** The mark's ink, as shares of the square it is drawn on. */
const INK = { x: M.left - M.stroke / 2, y: M.top - M.stroke / 2, w: M.right - M.left + M.stroke, h: M.bottom - M.top + M.stroke };

/** The L as an outline on a square `s` wide at (x, y): round ends, a round heel, a slightly eased inside corner. */
function letter(x, y, s) {
  const r = (M.stroke / 2) * s;
  const q = r * 0.3;
  const [l, rgt, t, b] = [x + M.left * s, x + M.right * s, y + M.top * s, y + M.bottom * s];
  const n = round;
  return `M${n(l - r)} ${n(t)}A${n(r)} ${n(r)} 0 0 1 ${n(l + r)} ${n(t)}V${n(b - r - q)}A${n(q)} ${n(q)} 0 0 0 ${n(l + r + q)} ${n(b - r)}H${n(rgt)}A${n(r)} ${n(r)} 0 0 1 ${n(rgt)} ${n(b + r)}H${n(l)}A${n(r)} ${n(r)} 0 0 1 ${n(l - r)} ${n(b)}Z`;
}
const pearl = (x, y, s, fill) => `<circle cx="${round(x + M.pearl.x * s)}" cy="${round(y + M.pearl.y * s)}" r="${round(M.pearl.r * s)}" fill="${fill}"/>`;

let ids = 0;
/** The mark in colour on a square `s` wide: the L runs from blue at its head to azure at its foot, the pearl is blue. */
function markColour(x, y, s, { shadow = false } = {}) {
  const id = `g${ids++}`;
  const body = `<path fill="url(#${id})" d="${letter(x, y, s)}"/>${pearl(x, y, s, C.blue)}`;
  const defs = `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${round(y + INK.y * s)}" x2="0" y2="${round(y + (INK.y + INK.h) * s)}"><stop offset="0" stop-color="${C.blue}"/><stop offset="1" stop-color="${C.azure}"/></linearGradient>`;
  if (!shadow) return `<defs>${defs}</defs>${body}`;
  return `<defs>${defs}<filter id="${id}s" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="${round(s * 0.026)}" stdDeviation="${round(s * 0.03)}" flood-color="${S.blueDeep}" flood-opacity="0.2"/></filter></defs><g filter="url(#${id}s)">${body}</g>`;
}
/** The mark in one colour. */
const markFlat = (x, y, s, fill) => `<path fill="${fill}" d="${letter(x, y, s)}"/>${pearl(x, y, s, fill)}`;

/** The icon: the mark on a sky square with rounded corners. */
function tile(x, y, s, { radius = TILE_RADIUS, ground = C.sky } = {}) {
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(s)}" height="${round(s)}" rx="${round(s * radius)}" fill="${ground}"/>${markColour(x, y, s)}`;
}

/** The mark cropped to its ink, `height` tall with its top left at (x, y). `paint` is a flat colour, or null for the colour mark. */
function markTight(x, y, height, paint) {
  const s = height / INK.h;
  const [ox, oy] = [x - INK.x * s, y - INK.y * s];
  return { width: INK.w * s, svg: paint ? markFlat(ox, oy, s, paint) : markColour(ox, oy, s) };
}

// --- The wordmark and the lockups ----------------------------------------------------------------------

/** LONGYU, with capitals `capHeight` tall and their top left at (x, y). */
function word(x, y, capHeight, fill) {
  const scale = capHeight / wordmark.height;
  return { width: wordmark.width * scale, svg: `<path fill="${fill}" d="${place(wordmark.d, scale, x, y)}"/>` };
}

/** How much taller than the capitals the mark stands in a lockup, and the gap between them in capital heights. */
const LOCKUP = { mark: 1.5, gap: 0.62 };

/** Mark and wordmark side by side, `height` tall. `ink` colours the wordmark; a `flat` colour paints the mark too. */
function lockup(x, y, height, ink, flat) {
  const cap = height / LOCKUP.mark;
  const m = markTight(x, y, height, flat);
  const w = word(x + m.width + cap * LOCKUP.gap, y + (height - cap) / 2, cap, ink);
  return { width: m.width + cap * LOCKUP.gap + w.width, height, svg: m.svg + w.svg };
}

/** Mark above the wordmark, for square spaces. */
function stacked(x, y, width, ink, flat) {
  const cap = width * (wordmark.height / wordmark.width);
  const markHeight = cap * 2.6;
  const markWidth = (markHeight * INK.w) / INK.h;
  const gap = cap * 0.9;
  return { width, height: markHeight + gap + cap, svg: markTight(x + (width - markWidth) / 2, y, markHeight, flat).svg + word(x, y + markHeight + gap, cap, ink).svg };
}

const svg = (w, h, body, title = "LONGYU") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(w)} ${round(h)}">${title ? `<title>${title}</title>` : ""}${body}</svg>\n`;

function png(source, width, background) {
  return new Resvg(source, { fitTo: { mode: "width", value: width }, background, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Inter" } }).render().asPng();
}

/** A .ico holding PNG images, which every current browser reads. */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size === 256 ? 0 : size, at);
    head.writeUInt8(size === 256 ? 0 : size, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

const written = [];
function write(path, data) {
  const file = ROOT + path;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  written.push(path);
}

// --- The logo ------------------------------------------------------------------------------------------

const G = 512;
const icon = svg(G, G, tile(0, 0, G));
const markFile = (paint) => {
  const m = markTight(0, 0, G, paint);
  return svg(m.width, G, m.svg);
};
const overshoot = 24;
const wordFile = (ink) => {
  const w = word(0, overshoot, wordmark.height, ink);
  return svg(w.width, wordmark.height + 2 * overshoot, w.svg);
};
const lockupFile = (ink, flat) => {
  const l = lockup(0, 0, 160, ink, flat);
  return svg(l.width, l.height, l.svg);
};
const stackedFile = (ink, flat) => {
  const s = stacked(0, 0, 400, ink, flat);
  return svg(s.width, s.height + 8, s.svg);
};

write("brand/logo/icon.svg", icon);
write("brand/logo/mark.svg", markFile(null));
write("brand/logo/mark-ink.svg", markFile(C.ink));
write("brand/logo/mark-white.svg", markFile(C.white));
write("brand/logo/wordmark-ink.svg", wordFile(C.ink));
write("brand/logo/wordmark-white.svg", wordFile(C.white));
write("brand/logo/lockup.svg", lockupFile(C.ink));
write("brand/logo/lockup-white.svg", lockupFile(C.white, C.white));
write("brand/logo/stacked.svg", stackedFile(C.ink));
write("brand/logo/stacked-white.svg", stackedFile(C.white, C.white));
for (const size of [256, 512, 1024]) write(`brand/png/icon-${size}.png`, png(icon, size));
write("brand/png/mark-1024.png", png(markFile(null), 830));
write("brand/png/lockup-1600.png", png(lockupFile(C.ink), 1600));
write("brand/png/lockup-white-1600.png", png(lockupFile(C.white, C.white), 1600));
write("brand/png/stacked-1200.png", png(stackedFile(C.ink), 1200));
write("brand/png/stacked-white-1200.png", png(stackedFile(C.white, C.white), 1200));

// --- Icons ---------------------------------------------------------------------------------------------

/** The icon with no corners of its own: phones and X cut the shape themselves. */
const fullBleed = (scale = 1) => svg(G, G, `<rect width="${G}" height="${G}" fill="${C.sky}"/>${markColour((G * (1 - scale)) / 2, (G * (1 - scale)) / 2, G * scale, { shadow: true })}`, "");
// Android shows the middle 72 of an adaptive icon's 108 units, so the mark is drawn at 72/108 of its usual size.
const ADAPTIVE = 72 / 108;
const inset = (G * (1 - ADAPTIVE)) / 2;
const adaptive = svg(G, G, markColour(inset, inset, G * ADAPTIVE, { shadow: true }), "");
const monochrome = svg(G, G, markFlat(inset, inset, G * ADAPTIVE, "#FFFFFF"), "");
// The launch screen's image, cut to a circle by Android 12 and later: the mark sits well inside that circle.
const splash = svg(G, G, markColour(G * 0.14, G * 0.14, G * 0.72), "");

write("brand/icons/app-icon-1024.png", png(fullBleed(), 1024));
write("brand/icons/android-foreground-1024.png", png(adaptive, 1024));
write("brand/icons/android-background-1024.png", png(svg(G, G, `<rect width="${G}" height="${G}" fill="${C.sky}"/>`, ""), 1024));
write("brand/icons/android-monochrome-1024.png", png(monochrome, 1024));
write("brand/icons/splash-1024.png", png(splash, 1024));
write("brand/icons/favicon.svg", icon);
write("brand/icons/favicon.ico", ico([16, 32, 48].map((size) => ({ size, data: png(icon, size) }))));
write("brand/icons/favicon-256.png", png(icon, 256));
write("brand/icons/apple-touch-icon.png", png(fullBleed(), 180));
write("brand/icons/icon-192.png", png(icon, 192));
write("brand/icons/icon-512.png", png(icon, 512));

// --- Social --------------------------------------------------------------------------------------------

function banner(w, h, height) {
  const l = lockup(0, 0, height, C.ink);
  return svg(w, h, `<rect width="${w}" height="${h}" fill="${C.sky}"/>${lockup((w - l.width) / 2, (h - height) / 2, height, C.ink).svg}`, "");
}
write("brand/social/avatar-800.png", png(fullBleed(0.86), 800));
write("brand/social/banner-1500x500.png", png(banner(1500, 500, 120), 1500));
write("brand/social/share-1200x630.png", png(banner(1200, 630, 132), 1200));

// --- The sheet -----------------------------------------------------------------------------------------

function sheet() {
  const W = 1600;
  const P = 96;
  const label = (x, y, text, fill = S.textSoft, size = 22, anchor = "start") => `<text x="${x}" y="${y}" font-family="Inter" font-weight="500" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${text}</text>`;
  const rule = (y) => `<rect x="${P}" y="${y}" width="${W - 2 * P}" height="1" fill="${S.lineStrong}"/>`;
  let y = 0;
  let out = "";

  // The lockup.
  y = 150;
  out += lockup(P, y, 190, C.ink).svg;
  out += label(W - P, y + 88, "Brand kit", S.textSoft, 24, "end") + label(W - P, y + 124, "November 2026", S.textFaint, 22, "end");
  y += 190 + 96;
  out += rule(y);

  // The icon at working sizes, and the mark on other grounds.
  y += 72;
  out += label(P, y, "Mark");
  y += 40;
  let x = P;
  for (const size of [240, 120, 64, 32]) {
    out += tile(x, y + 240 - size, size) + label(x + size / 2, y + 240 + 40, String(size), S.textFaint, 20, "middle");
    x += size + 56;
  }
  const box = 240;
  let tx = W - P - box * 3 - 64;
  for (const [name, ground, paint] of [["On white", C.white, null], ["On blue", C.blue, C.white], ["On ink", C.ink, C.white]]) {
    const width = (132 * INK.w) / INK.h;
    out += `<rect x="${tx}" y="${y}" width="${box}" height="${box}" rx="20" fill="${ground}"${ground === C.white ? ` stroke="${S.line}" stroke-width="2"` : ""}/>${markTight(tx + (box - width) / 2, y + (box - 132) / 2, 132, paint).svg}`;
    out += label(tx + box / 2, y + box + 40, name, S.textFaint, 20, "middle");
    tx += box + 32;
  }
  y += 240 + 40 + 72;
  out += rule(y);

  // The app icon in the shapes phones give it.
  y += 72;
  out += label(P, y, "App icon");
  y += 40;
  const side = 220;
  const shapes = [
    ["Android circle", `<circle cx="${side / 2}" cy="${side / 2}" r="${side / 2}"/>`],
    ["Android squircle", `<rect width="${side}" height="${side}" rx="${side * 0.3}"/>`],
    ["iPhone", `<rect width="${side}" height="${side}" rx="${side * TILE_RADIUS}"/>`],
    ["Themed", `<circle cx="${side / 2}" cy="${side / 2}" r="${side / 2}"/>`],
  ];
  x = P;
  shapes.forEach(([name, shape], i) => {
    const themed = name === "Themed";
    out += `<clipPath id="shape${i}" transform="translate(${x} ${y})">${shape}</clipPath><g clip-path="url(#shape${i})"><rect x="${x}" y="${y}" width="${side}" height="${side}" fill="${themed ? "#D7E3F4" : C.sky}"/>${themed ? markFlat(x, y, side, "#1B3A63") : markColour(x, y, side, { shadow: true })}</g>`;
    out += label(x + side / 2, y + side + 40, name, S.textFaint, 20, "middle");
    x += side + 56;
  });
  const st = stacked(0, 0, 250, C.ink);
  out += stacked(W - P - 250, y + (side - st.height) / 2, 250, C.ink).svg;
  out += label(W - P - 125, y + side + 40, "Stacked", S.textFaint, 20, "middle");
  y += side + 40 + 72;
  out += rule(y);

  // Colour.
  y += 72;
  out += label(P, y, "Colour");
  y += 40;
  const names = Object.keys(tokens.color);
  const sw = (W - 2 * P - 24 * (names.length - 1)) / names.length;
  names.forEach((name, i) => {
    const sx = P + i * (sw + 24);
    const hex = tokens.color[name].hex;
    out += `<rect x="${sx}" y="${y}" width="${sw}" height="170" rx="16" fill="${hex}"${name === "white" || name === "sky" ? ` stroke="${S.line}" stroke-width="2"` : ""}/>`;
    out += `<text x="${sx}" y="${y + 214}" font-family="Inter" font-weight="600" font-size="24" fill="${C.ink}">${name[0].toUpperCase() + name.slice(1)}</text>`;
    out += `<text x="${sx}" y="${y + 248}" font-family="JetBrains Mono" font-weight="500" font-size="20" fill="${S.textSoft}">${hex}</text>`;
    out += `<text x="${sx}" y="${y + 282}" font-family="Inter" font-size="19" fill="${S.textFaint}">${tokens.color[name].use}</text>`;
  });
  y += 282 + 56;
  x = P;
  for (const [name, hex] of Object.entries(tokens.status)) {
    out += `<circle cx="${x + 12}" cy="${y - 7}" r="12" fill="${hex}"/>` + label(x + 36, y, `${name[0].toUpperCase() + name.slice(1)} ${hex}`, S.textSoft, 20);
    x += 300;
  }
  y += 72;
  out += rule(y);

  // Type.
  y += 72;
  out += label(P, y, "Type");
  y += 116;
  out += `<text x="${P}" y="${y}" font-family="Sora" font-weight="600" font-size="104" letter-spacing="-3" fill="${C.ink}">12,480.52</text>`;
  out += `<text x="${P + 512}" y="${y}" font-family="Sora" font-weight="600" font-size="34" fill="${C.blue}">tLONG</text>`;
  out += label(W - P, y - 44, "Sora SemiBold", S.textSoft, 22, "end") + label(W - P, y - 10, "Numbers, the wordmark in Bold", S.textFaint, 20, "end");
  y += 96;
  out += `<text x="${P}" y="${y}" font-family="Inter" font-weight="600" font-size="40" fill="${C.ink}">Tap once a day. Earn on-chain.</text>`;
  out += label(W - P, y - 22, "Inter", S.textSoft, 22, "end") + label(W - P, y + 12, "Everything else", S.textFaint, 20, "end");
  y += 60;
  out += `<text x="${P}" y="${y}" font-family="Inter" font-size="26" fill="${S.textSoft}">Regular 400 · Medium 500 · SemiBold 600</text>`;
  y += 60;
  out += `<text x="${P}" y="${y}" font-family="JetBrains Mono" font-weight="500" font-size="24" fill="${S.textSoft}">0x7a3f…c41e · chain 668801</text>`;
  out += label(W - P, y, "JetBrains Mono, addresses", S.textFaint, 20, "end");
  y += 110;

  return svg(W, y, `<rect width="${W}" height="${y}" fill="${S.ground}"/>${out}`, "");
}
write("brand/brand-sheet.png", png(sheet(), 1600));

// --- Into the apps -------------------------------------------------------------------------------------

const copy = (from, to) => write(to, readFileSync(ROOT + from));
copy("brand/icons/app-icon-1024.png", "apps/mobile/assets/icon.png");
copy("brand/icons/android-foreground-1024.png", "apps/mobile/assets/android-icon-foreground.png");
copy("brand/icons/android-background-1024.png", "apps/mobile/assets/android-icon-background.png");
copy("brand/icons/android-monochrome-1024.png", "apps/mobile/assets/android-icon-monochrome.png");
copy("brand/icons/splash-1024.png", "apps/mobile/assets/splash-icon.png");
copy("brand/icons/favicon-256.png", "apps/mobile/assets/favicon.png");
copy("brand/icons/apple-touch-icon.png", "apps/mobile/public/apple-touch-icon.png");
for (const to of ["apps/web/src/favicon.svg", "apps/explorer/public/favicon.svg", "apps/api/admin/icon.svg"]) copy("brand/icons/favicon.svg", to);
copy("brand/logo/mark.svg", "apps/web/src/mark.svg");
copy("brand/logo/lockup.svg", "apps/web/src/lockup.svg");
copy("brand/social/share-1200x630.png", "apps/web/src/share.png");
copy("brand/logo/mark.svg", "apps/explorer/public/mark.svg");

// The app draws the logo itself (react-native-svg), from the same numbers.
write("apps/mobile/src/design/brand.ts", `// Written by brand/tools/build.mjs from brand/tokens.json and brand/tools/paths.json.
// Do not edit: change the brand kit and build it again.

/** The mark (an L with the dragon pearl), cropped to its ink: MARK_WIDTH by MARK_HEIGHT units. */
export const MARK_WIDTH = ${round(INK.w * 64)};
export const MARK_HEIGHT = ${round(INK.h * 64)};
export const MARK_LETTER = "${letter(-INK.x * 64, -INK.y * 64, 64)}";
export const MARK_PEARL = { cx: ${round((M.pearl.x - INK.x) * 64)}, cy: ${round((M.pearl.y - INK.y) * 64)}, r: ${round(M.pearl.r * 64)} };

/** LONGYU as an outline: capitals WORDMARK_HEIGHT units tall, with WORDMARK_PAD units above and below for the round letters. */
export const WORDMARK_WIDTH = ${round((wordmark.width / wordmark.height) * 100)};
export const WORDMARK_HEIGHT = 100;
export const WORDMARK_PAD = 4;
export const WORDMARK = "${place(wordmark.d, 100 / wordmark.height, 0, 4)}";
/** Capital height of the wordmark's typeface, as a share of the type size. */
export const WORDMARK_CAP = ${wordmark.height / 1000};
/** In a lockup the mark stands this many capital heights tall, this many away from the wordmark. */
export const LOCKUP_MARK = ${LOCKUP.mark};
export const LOCKUP_GAP = ${LOCKUP.gap};
`);

console.log(written.join("\n"));
