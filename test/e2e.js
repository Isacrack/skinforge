/* E2E: prueba la página real en Chromium (node test/e2e.js) */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const PCK = require('../src/pck.js');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

/* ---------- mini encoder PNG (RGBA) ---------- */
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function makePng(w, h, colorFn) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = colorFn(x, y);
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- mini constructor ZIP (store) ---------- */
function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

(async () => {
  /* ficheros de prueba */
  const png64 = makePng(64, 64, (x, y) => [x * 4, y * 4, 120, x < 8 ? 0 : 255]);
  const png32 = makePng(64, 32, (x, y) => [200, y * 6, x * 3, 255]);
  const png128 = makePng(128, 128, (x, y) => [255 - x, 90, y, 255]);
  fs.writeFileSync(path.join(OUT, 'steve.png'), png64);
  fs.writeFileSync(path.join(OUT, 'clasica.png'), png32);
  fs.writeFileSync(path.join(OUT, 'grande128.png'), png128);

  const mcpack = makeZip([
    { name: 'manifest.json', data: JSON.stringify({ format_version: 1, header: { name: 'Pack Bedrock', uuid: 'x' }, modules: [{ type: 'skin_pack' }] }) },
    { name: 'skins.json', data: JSON.stringify({ serialize_name: 'packdemo', localization_name: 'packdemo', skins: [{ geometry: 'geometry.humanoid.customSlim', localization_name: 'skin.heroe.name', texture: 'heroe.png', type: 'free' }, { geometry: 'geometry.humanoid.custom', localization_name: 'skin.lobo.name', texture: 'lobo.png', type: 'free' }] }) },
    { name: 'texts/en_US.lang', data: 'packdemo=Pack Bedrock Demo\nskin.heroe.name=Héroe\nskin.lobo.name=Lobo\n' },
    { name: 'heroe.png', data: png64 },
    { name: 'lobo.png', data: png128 }
  ]);
  fs.writeFileSync(path.join(OUT, 'pack.mcpack'), mcpack);

  // un .pck previo (para probar la importación)
  const prev = PCK.buildSkinPack({
    packName: 'Pack anterior', packId: 424242,
    skins: [{ id: 31415926, name: 'Vieja', png: png64, anim: PCK.ANIM.MODERN_WIDE_MODEL }]
  });
  fs.writeFileSync(path.join(OUT, 'anterior.pck'), Buffer.from(prev.bytes));

  const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await page.waitForTimeout(300);

  /* 1. añadir tres PNG */
  await page.setInputFiles('#fileInput', [
    path.join(OUT, 'steve.png'), path.join(OUT, 'clasica.png'), path.join(OUT, 'grande128.png')
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 3, null, { timeout: 15000 });
  console.log('  ✓ 3 PNG añadidas');

  /* 2. renombrar la primera skin */
  const firstName = page.locator('.skin-card [data-role="name"]').first();
  await firstName.fill('Steve Ñandú');
  await page.locator('#packName').fill('Mi Pack PS3');

  /* 3. ajustar modelos: la 2ª (64x32) clásica, la 3ª slim */
  await page.locator('.skin-card [data-role="model"]').nth(2).selectOption('slim');

  /* 4. descargar el .pck */
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#downloadBtn')
  ]);
  const pckPath = path.join(OUT, download.suggestedFilename());
  await download.saveAs(pckPath);
  console.log('  ✓ descarga: ' + download.suggestedFilename());

  const buf = fs.readFileSync(pckPath);
  const parsed = PCK.readPck(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.strictEqual(parsed.pckType, 3);
  assert.strictEqual(parsed.littleEndian, false, 'PS3 = big endian');
  const skins = parsed.assets.filter((a) => a.type === 0);
  assert.strictEqual(skins.length, 3, 'debe haber 3 skins');
  assert.strictEqual(parsed.assets[0].get('PACKID').length > 0, true);
  assert.strictEqual(parsed.assets[0].get('PACKVERSION'), '0');

  const loc = PCK.readLoc(parsed.assets[1].data);
  assert.strictEqual(loc.keys['IDS_DISPLAY_NAME']['en-EN'], 'Mi Pack PS3');
  assert.strictEqual(loc.keys[skins[0].get('DISPLAYNAMEID')]['en-EN'], 'Steve Ñandú');
  console.log('  ✓ pack descargado con 3 skins, PACKID ' + parsed.assets[0].get('PACKID'));

  // comprobaciones por skin
  assert.strictEqual(skins[0].get('ANIM'), '0x00040000', 'steve 64x64 -> ancho');
  assert.strictEqual(skins[1].get('ANIM'), '0x00000000', 'clasica 64x32 -> anim 0');
  assert.strictEqual(skins[2].get('ANIM'), '0x00080000', 'slim -> 0x80000');
  assert.strictEqual(skins[0].get('GAME_FLAGS'), '0x18');
  assert.strictEqual(skins[0].get('FREE'), '1');
  assert.match(skins[0].filename, /^dlcskin\d{8}\.png$/);
  assert.strictEqual(new Set(skins.map((s) => s.filename)).size, 3, 'IDs únicos');

  // resolución: la 128x128 debe haberse reducido a 64x64
  const dims = await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
    const bmp = await createImageBitmap(blob);
    return [bmp.width, bmp.height];
  }, Array.from(skins[2].data));
  assert.deepStrictEqual(dims, [64, 64], '128x128 -> 64x64');
  console.log('  ✓ ANIM correcto por modelo y 128×128 reescalada a 64×64');

  /* 5. importar un .mcpack de Bedrock */
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  console.log('  ✓ lista vaciada');
  await page.setInputFiles('#fileInput', [path.join(OUT, 'pack.mcpack')]);
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 2, null, { timeout: 15000 });
  const names = await page.$$eval('.skin-card [data-role="name"]', (els) => els.map((e) => e.value));
  assert.deepStrictEqual(names, ['Héroe', 'Lobo'], 'nombres desde en_US.lang: ' + names.join(','));
  const models = await page.$$eval('.skin-card [data-role="model"]', (els) => els.map((e) => e.value));
  assert.deepStrictEqual(models, ['slim', 'wide']);
  console.log('  ✓ .mcpack: 2 skins, nombres del .lang, slim detectado');

  /* 6. importar un .pck existente */
  await page.setInputFiles('#fileInput', [path.join(OUT, 'anterior.pck')]);
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 3, null, { timeout: 15000 });
  const packIdVal = await page.inputValue('#packId');
  assert.strictEqual(packIdVal, '424242', 'PACKID heredado del pck importado');
  console.log('  ✓ .pck importado (PACKID 424242 heredado)');

  /* 7. verificación integrada */
  await page.click('#buildTestBtn');
  await page.waitForSelector('#logWrap.show', { timeout: 5000 });
  const logText = await page.textContent('#logWrap');
  assert.ok(/Estructura verificada/.test(logText), 'debe verificar: ' + logText.slice(0, 120));
  console.log('  ✓ verificación integrada OK');

  /* 8. captura de pantalla */
  await page.screenshot({ path: path.join(OUT, 'screenshot.png'), fullPage: false });

  assert.deepStrictEqual(errors, [], 'errores de consola: ' + errors.join(' | '));
  console.log('\nE2E OK — sin errores de consola');
  await browser.close();
})().catch((e) => { console.error('FALLO E2E:', e); process.exit(1); });
