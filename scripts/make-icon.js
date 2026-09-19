// Generates assets/icon.png (256x256), assets/tray.png (32x32) and assets/icon.ico
// entirely with Node's built-ins (zlib) — no image libraries needed.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSETS = path.join(__dirname, '..', 'assets');
fs.mkdirSync(ASSETS, { recursive: true });

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// --- draw a minimal "target ring + flame dot" glyph ---
function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const bg = [15, 17, 21];       // #0f1115 dark charcoal
  const ring = [255, 138, 61];   // amber
  const core = [255, 107, 53];   // deep orange

  const cx = size / 2, cy = size / 2;
  const r = size * 0.42;
  const corner = size * 0.18;

  function setPx(x, y, color, alpha) {
    const i = (y * size + x) * 4;
    buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2]; buf[i + 3] = Math.round(alpha * 255);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // rounded-square mask for background
      const dx = Math.max(0, Math.max(corner - x, x - (size - 1 - corner)));
      const dy = Math.max(0, Math.max(corner - y, y - (size - 1 - corner)));
      const cornerDist = Math.sqrt(dx * dx + dy * dy);
      const inRounded = cornerDist <= corner;
      if (!inRounded) { setPx(x, y, bg, 0); continue; }

      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (d > r) {
        setPx(x, y, bg, 1);
      } else if (d > r * 0.72) {
        setPx(x, y, ring, 1);
      } else if (d > r * 0.5) {
        setPx(x, y, bg, 1);
      } else if (d > r * 0.42) {
        setPx(x, y, ring, 1);
      } else {
        setPx(x, y, core, 1);
      }
    }
  }
  return buf;
}

function writeICO(pngBuffers, sizes, outPath) {
  // ICO container with PNG-compressed images (supported on Windows Vista+)
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  let offset = 6 + count * 16;
  const dirEntries = [];
  const dataParts = [];
  for (let i = 0; i < count; i++) {
    const png = pngBuffers[i];
    const size = sizes[i];
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // width
    entry[1] = size >= 256 ? 0 : size; // height
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    dataParts.push(png);
    offset += png.length;
  }
  fs.writeFileSync(outPath, Buffer.concat([header, ...dirEntries, ...dataParts]));
}

const big = drawIcon(256);
const small = drawIcon(32);
const tray = drawIcon(32);

const pngBig = encodePNG(256, 256, big);
const pngSmall = encodePNG(32, 32, small);
const pngTray = encodePNG(32, 32, tray);

fs.writeFileSync(path.join(ASSETS, 'icon.png'), pngBig);
fs.writeFileSync(path.join(ASSETS, 'tray.png'), pngTray);
writeICO([pngBig, pngSmall], [256, 32], path.join(ASSETS, 'icon.ico'));

console.log('Icons generated in', ASSETS);
