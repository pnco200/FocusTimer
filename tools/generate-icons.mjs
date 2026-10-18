// Dependency-free rasterization of our simple stopwatch mark for installable PWA icons.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name); const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, crc]);
}
for (const size of [192, 512]) {
  const data = Buffer.alloc(size * (1 + size * 3));
  const lineDistance = (x, y, ax, ay, bx, by) => {
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x * 192 / size; const py = y * 192 / size;
    const mark = Math.abs(Math.hypot(px - 96, py - 102) - 52) < 4.5 ||
      lineDistance(px, py, 96, 72, 96, 102) < 4.5 || lineDistance(px, py, 96, 102, 117, 114) < 4.5 ||
      lineDistance(px, py, 82, 27, 110, 27) < 4.5 || lineDistance(px, py, 96, 27, 96, 45) < 4.5;
    const offset = y * (1 + size * 3) + 1 + x * 3;
    data.set(mark ? [243, 245, 233] : [40, 86, 65], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  writeFileSync(`public/icon-${size}.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0))]));
}
