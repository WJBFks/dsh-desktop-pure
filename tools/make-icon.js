'use strict';

/**
 * tools/make-icon.js — app icon generator (pure Node + sharp, no Electron window).
 *
 * Reads assets/dsh-whale.svg (the official DeepSeek Harness whale mark), forces
 * a solid fill color, rasterizes at app-icon sizes, and writes:
 *   build/icon-256.png          (window icon)
 *   build/icon.ico              (multi-size, PNG-embedded .ico — shortcut/exe icon)
 *   build/icon-white-256.png
 *   build/icon-white.ico        (light-theme variant, for reference)
 *
 * Usage: node tools/make-icon.js   (after: npm i -D sharp)
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const SRC = path.join(ROOT, 'assets', 'dsh-whale.svg');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Strip the theme media query and force one fill color on every element. */
function normalizeSvg(raw, fill) {
  return raw
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/\sfill="[^"]*"/g, ` fill="${fill}"`);
}

/** Render the SVG to one 256px PNG, then downscale to every icon size. */
async function renderSizes(svg) {
  // Source is 50x50 at 72dpi; ~368 dpi renders it at ~256px, then resize to exact.
  const big = await sharp(Buffer.from(svg), { density: 368 })
    .resize(256, 256)
    .png()
    .toBuffer();
  const out = {};
  for (const size of SIZES) {
    out[size] =
      size === 256
        ? big
        : await sharp(big).resize(size, size, { fit: 'fill' }).png().toBuffer();
  }
  return out;
}

/** Assemble a PNG-embedded multi-size .ico (Windows Vista+ accepts PNG entries). */
function buildIco(pngsBySize) {
  const header = Buffer.alloc(6 + SIZES.length * 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(SIZES.length, 4);
  let offset = 6 + SIZES.length * 16;
  const blobs = [];
  SIZES.forEach((size, i) => {
    const blob = pngsBySize[size];
    const at = 6 + i * 16;
    header.writeUInt8(size === 256 ? 0 : size, at); // 0 means 256
    header.writeUInt8(size === 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(blob.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += blob.length;
    blobs.push(blob);
  });
  return Buffer.concat([header, ...blobs]);
}

async function main() {
  const raw = fs.readFileSync(SRC, 'utf8');
  fs.mkdirSync(BUILD, { recursive: true });

  for (const [name, fill] of [['icon', '#000000'], ['icon-white', '#FFFFFF']]) {
    const svg = normalizeSvg(raw, fill);
    const pngs = await renderSizes(svg);
    fs.writeFileSync(path.join(BUILD, `${name}-256.png`), pngs[256]);
    fs.writeFileSync(path.join(BUILD, `${name}.ico`), buildIco(pngs));
    console.log(`wrote build/${name}-256.png and build/${name}.ico`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});