# LONGYU brand kit

Everything here is built from `tokens.json` by `tools/build.mjs`. Change the tokens, run the build, and every logo file, app icon and site icon follows. Do not edit the output files by hand.

`brand-sheet.png` shows the whole kit on one page.

## The logo

The mark is a capital L with the dragon pearl (龙珠) resting in its corner. It runs from blue at the top to azure at the foot; the pearl is solid blue.

| File | Use it for |
| --- | --- |
| `logo/lockup.svg` | The default: mark and LONGYU side by side, on light grounds |
| `logo/lockup-white.svg` | The same, on blue, ink or photographs |
| `logo/stacked.svg`, `logo/stacked-white.svg` | Square spaces, where the lockup would be too small |
| `logo/mark.svg` | The mark alone, when the name is already next to it |
| `logo/mark-ink.svg`, `logo/mark-white.svg` | One-colour printing, engraving, watermarks |
| `logo/wordmark-ink.svg`, `logo/wordmark-white.svg` | The name alone |
| `logo/icon.svg` | The mark on its sky tile: app icons and avatars |

PNG copies are in `png/`. Use SVG wherever it is accepted.

Rules:

- Keep clear space around the logo equal to the pearl's diameter.
- Smallest sizes: the mark 16 px tall, the lockup 20 px tall.
- On blue or ink, use the white versions. The colour mark goes on white, sky or the pale ground only.
- Do not recolour, outline, tilt, stretch or add effects. Do not redraw the L in another typeface.
- In the lockup the mark is 1.5 capital heights tall and sits 0.62 capital heights from the name. Use the files; do not rebuild the lockup by eye.

## Colour

| Name | Hex | Use |
| --- | --- | --- |
| Blue | `#0B6FDB` | Actions, the logo, mining |
| Azure | `#8CC6FA` | The foot of the logo |
| Sky | `#E6F4FE` | Icon ground, tints |
| Ink | `#0A1F3D` | Text, the wordmark |
| White | `#FFFFFF` | Cards, text on blue |

Screens use a pale ground `#F4F9FE`, white cards, a raised tint `#EAF2FC`, soft text `#4B5F7D` and faint text `#5F718A`. Hover and pressed blue is `#0857AD`. Hairlines are ink at 9% (17% where a stronger edge is needed).

Status colours: success `#0B8058`, warning `#A8610B`, danger `#D92D20`. They are for status only, never decoration.

Blue is for the one main action on a screen and for the logo. Body text is ink, not blue. All text colours above pass WCAG AA on white and on the pale ground.

## Type

| Face | Use |
| --- | --- |
| Sora Bold, tracked 0.12 em | The wordmark only |
| Sora SemiBold | Large numbers |
| Inter 400, 500, 600 | Everything else |
| JetBrains Mono 500 | Addresses and hashes |

All three are under the SIL Open Font License. The font files are in `apps/mobile/assets/fonts`.

## Icons

| File | Where it goes |
| --- | --- |
| `icons/app-icon-1024.png` | App icon (iOS, stores) |
| `icons/android-foreground-1024.png`, `android-background-1024.png`, `android-monochrome-1024.png` | Android adaptive icon |
| `icons/splash-1024.png` | App launch screen, on `#F4F9FE` |
| `icons/favicon.svg`, `favicon.ico`, `favicon-256.png` | Browser tabs |
| `icons/apple-touch-icon.png`, `icon-192.png`, `icon-512.png` | Home-screen shortcuts |
| `social/avatar-800.png` | X and other profile pictures |
| `social/banner-1500x500.png` | X header |
| `social/share-1200x630.png` | Link previews |

## Where the kit is wired in

The build copies its output straight into the products, so they cannot drift:

- LONGYU MINE (`apps/mobile`): app icon, Android adaptive icon, launch screen, favicon, and `src/design/brand.ts` (the mark and wordmark as paths). Colours are in `src/design/tokens.ts`.
- Web pages (`apps/web`): `src/favicon.svg`, `src/mark.svg`. Colours are the `:root` variables at the top of each page.
- Explorer (`apps/explorer`): `public/favicon.svg`, `public/mark.svg`. Colours are the `:root` variables in `public/app.css`.
- Admin console (`apps/api/admin`): `icon.svg`. Colours are the `:root` variables in `app.css`.

When a colour in `tokens.json` changes, change the same value in those four places.

## Rebuilding

```
cd brand/tools
npm ci
node build.mjs
```

Node 22 or later. `extract.mjs` is only needed to change the wordmark's lettering; it reads Sora Bold and rewrites `tools/paths.json`.

## Voice

Short and plain. Numbers first, then a short label. No slogans inside the product, no exclamation marks. Say "LONGYU" in capitals, "LONGYU MINE" for the mining app, "LONGYU Scan" for the explorer, "tLONG" for the testnet token.

## Use by others

The code in this repository is open source; the LONGYU name and mark are not part of that licence. Use them to refer to the network, link to it or list it. Do not use them as the name or logo of another project, or in a way that suggests LONGYU runs or endorses it.
