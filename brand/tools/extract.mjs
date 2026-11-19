// Reads the wordmark's outline from Sora Bold and writes it to paths.json. Run it only to change the
// wordmark; build.mjs needs no fonts for the logo. Usage: node extract.mjs <Sora-Bold.ttf>
//   Sora-Bold.ttf  apps/mobile/assets/fonts, SIL Open Font License 1.1
import * as fontkit from "fontkit";
import { writeFileSync } from "node:fs";

const [soraFile] = process.argv.slice(2);
if (!soraFile) throw new Error("usage: node extract.mjs <Sora-Bold.ttf>");

/** The wordmark's letter spacing, in thousandths of the type size. */
const TRACKING = 120;

/** An outline as an SVG path, moved right by dx and with y pointing down from `top`. */
function outline(glyph, dx, top) {
  const at = (x, y) => `${x + dx} ${top - y}`;
  return glyph.path.commands.map(({ command, args: a }) => {
    if (command === "moveTo") return `M${at(a[0], a[1])}`;
    if (command === "lineTo") return `L${at(a[0], a[1])}`;
    if (command === "quadraticCurveTo") return `Q${at(a[0], a[1])} ${at(a[2], a[3])}`;
    if (command === "bezierCurveTo") return `C${at(a[0], a[1])} ${at(a[2], a[3])} ${at(a[4], a[5])}`;
    return "Z";
  }).join("");
}

const sora = fontkit.openSync(soraFile);
const run = sora.layout("LONGYU");
const first = run.glyphs[0].bbox.minX;
let pen = -first;
let d = "";
let right = 0;
run.glyphs.forEach((glyph, i) => {
  d += outline(glyph, pen, sora.capHeight);
  right = pen + glyph.bbox.maxX;
  pen += run.positions[i].xAdvance + TRACKING;
});

writeFileSync(new URL("./paths.json", import.meta.url), `${JSON.stringify({
  wordmark: { source: `${sora.fullName}, ${sora.version}, tracking ${TRACKING}/1000`, width: right, height: sora.capHeight, d },
}, null, 2)}\n`);
console.log("wrote paths.json");
