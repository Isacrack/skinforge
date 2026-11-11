/* Genera skins de ejemplo con aspecto "de verdad" para las capturas */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const crcTable = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const t = Buffer.from(type); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };
function encodePng(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const p = px(x, y); const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = p[0]; raw[o + 1] = p[1]; raw[o + 2] = p[2]; raw[o + 3] = p[3]; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// paleta
const SKIN = [181, 131, 106, 255], SKIN_D = [150, 105, 84, 255], HAIR = [58, 40, 24, 255];
const SHIRT = [0, 175, 175, 255], SHIRT_D = [0, 140, 140, 255], JEANS = [58, 58, 120, 255], JEANS_D = [44, 44, 96, 255];
const EYE_W = [235, 235, 235, 255], EYE_B = [60, 46, 120, 255], MOUTH = [110, 70, 55, 255], CLEAR = [0, 0, 0, 0];

function steveSkin() {
  return encodePng(64, 64, (x, y) => {
    // cabeza (cara frontal 8..16 x 8..16)
    if (y >= 8 && y < 16 && x >= 8 && x < 16) {
      const fx = x - 8, fy = y - 8;
      if (fy < 2) return HAIR;
      if (fy === 4 && (fx === 1 || fx === 5)) return EYE_W;
      if (fy === 4 && (fx === 2 || fx === 6)) return EYE_B;
      if (fy === 6 && fx >= 3 && fx <= 4) return MOUTH;
      if (fx === 0 || fx === 7 || fy === 7) return SKIN_D;
      return SKIN;
    }
    // cabeza: resto de caras -> pelo arriba / piel
    if (y < 16 && x >= 16 && x < 48) return (y - 8) < 2 ? HAIR : SKIN;
    if (y >= 8 && y < 16 && x < 8) return SKIN;
    // cuerpo frontal
    if (y >= 20 && y < 32 && x >= 20 && x < 28) {
      const fx = x - 20, fy = y - 20;
      if (fy > 8 && fx >= 3 && fx <= 4) return SHIRT_D;
      return SHIRT;
    }
    // cuerpo (otras caras)
    if (y >= 16 && y < 32 && x >= 16 && x < 40) return SHIRT;
    // brazos: frontal derecho (44..48 x 20..32) y izquierdo (36..40 x 52..64)
    const isSkinRegion = (y >= 20 && y < 32 && x >= 44 && x < 48) || (y >= 52 && y < 64 && x >= 36 && x < 40);
    if (isSkinRegion) return (y - (y >= 52 ? 52 : 20)) < 3 ? SHIRT : SKIN;
    // mangas / resto de brazos
    if ((y >= 16 && y < 32 && x >= 40 && x < 56) || (y >= 48 && y < 64 && x >= 32 && x < 48)) {
      return (y % 16) < 3 ? SHIRT : SKIN;
    }
    // piernas frontales
    if (y >= 20 && y < 32 && x >= 4 && x < 8) return y < 24 ? JEANS_D : JEANS;
    if (y >= 52 && y < 64 && x >= 20 && x < 24) return y < 56 ? JEANS_D : JEANS;
    // resto piernas
    if ((y >= 16 && y < 32 && x >= 0 && x < 16) || (y >= 48 && y < 64 && x >= 16 && x < 32)) return JEANS;
    return CLEAR;
  });
}

function alexSkin() {
  return encodePng(64, 64, (x, y) => {
    // piel clara con pelo naranja
    const isFace = y >= 8 && y < 16 && x >= 8 && x < 16;
    if (isFace) {
      const fx = x - 8, fy = y - 8;
      if (fy < 3) return [214, 122, 55, 255];
      if (fy === 4 && (fx === 1 || fx === 5)) return EYE_W;
      if (fy === 4 && (fx === 2 || fx === 6)) return [40, 110, 70, 255];
      if (fy === 6) return [225, 170, 150, 255];
      return [246, 200, 175, 255];
    }
    if (y < 16 && x >= 16 && x < 48) return (y - 8) < 3 ? [214, 122, 55, 255] : [246, 200, 175, 255];
    if (y >= 8 && y < 16 && x < 8) return [246, 200, 175, 255];
    const GREEN = [90, 150, 70, 255], GREEN_D = [70, 120, 55, 255];
    if (y >= 20 && y < 32 && x >= 20 && x < 28) return (y > 28) ? GREEN_D : GREEN;
    if (y >= 16 && y < 32 && x >= 16 && x < 40) return GREEN;
    if ((y >= 20 && y < 32 && x >= 44 && x < 47) || (y >= 52 && y < 64 && x >= 36 && x < 39)) {
      return (y - (y >= 52 ? 52 : 20)) < 2 ? GREEN : [246, 200, 175, 255];
    }
    if ((y >= 16 && y < 32 && x >= 40 && x < 56) || (y >= 48 && y < 64 && x >= 32 && x < 48)) return GREEN;
    const GREY = [70, 70, 80, 255];
    if ((y >= 20 && y < 32 && x >= 4 && x < 8) || (y >= 52 && y < 64 && x >= 20 && x < 24)) return GREY;
    if ((y >= 16 && y < 32 && x >= 0 && x < 16) || (y >= 48 && y < 64 && x >= 16 && x < 32)) return GREY;
    return CLEAR;
  });
}

function classicSkin() {
  return encodePng(64, 32, (x, y) => {
    if (y >= 8 && y < 16 && x >= 8 && x < 16) {
      const fx = x - 8, fy = y - 8;
      if (fy < 2) return [30, 30, 40, 255];
      if (fy === 4 && (fx === 1 || fx === 5)) return EYE_W;
      if (fy === 4 && (fx === 2 || fx === 6)) return [200, 60, 60, 255];
      return [200, 160, 130, 255];
    }
    if (y < 16 && x >= 16 && x < 48) return (y - 8) < 2 ? [30, 30, 40, 255] : [200, 160, 130, 255];
    const PURPLE = [110, 60, 150, 255];
    if (y >= 20 && y < 32 && x >= 20 && x < 28) return PURPLE;
    if (y >= 16 && y < 32 && x >= 16 && x < 40) return PURPLE;
    if (y >= 20 && y < 32 && x >= 44 && x < 48) return [200, 160, 130, 255];
    if (y >= 20 && y < 32 && x >= 4 && x < 8) return [40, 40, 60, 255];
    if ((y >= 16 && y < 32 && x >= 0 && x < 16) || (y >= 16 && y < 32 && x >= 40 && x < 56)) return [40, 40, 60, 255];
    return CLEAR;
  });
}

const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'steve.png'), steveSkin());
fs.writeFileSync(path.join(out, 'alex.png'), alexSkin());
fs.writeFileSync(path.join(out, 'clasica.png'), classicSkin());
console.log('skins de ejemplo generadas');

module.exports = { encodePng: encodePng, steveSkin: steveSkin, alexSkin: alexSkin, classicSkin: classicSkin };
