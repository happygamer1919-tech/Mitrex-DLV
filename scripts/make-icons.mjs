// Builds PWA icons from public/logo.png using only Node built-ins is not possible for PNG decode,
// so this draws a simple solid icon: ink background, neon "D" block mark. Run: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, safe) {
  const INK = [2, 8, 20], NEON = [43, 255, 136];
  const raw = Buffer.alloc((size * 3 + 1) * size);
  // neon rounded dot (the portal mark) plus a ring, centred; maskable keeps it inside the safe zone
  const cx = size / 2, cy = size / 2;
  const rOuter = size * (safe ? 0.26 : 0.34), rInner = rOuter * 0.62;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const c = d <= rInner ? NEON : d <= rOuter ? INK : INK;
      const ring = d > rInner && d <= rOuter && d > rOuter * 0.9;
      const px = ring ? NEON : c;
      raw[row + 1 + x * 3] = px[0]; raw[row + 2 + x * 3] = px[1]; raw[row + 3 + x * 3] = px[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
mkdirSync("public/icons", { recursive: true });
writeFileSync("public/icons/icon-192.png", png(192, false));
writeFileSync("public/icons/icon-512.png", png(512, false));
writeFileSync("public/icons/icon-maskable-512.png", png(512, true));
console.log("icons written");
