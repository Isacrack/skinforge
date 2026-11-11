/* E2E de la pestaña "Texture packs" (node test/e2e-tex.js) */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const PCK = require('../src/pck.js');
const { makePng, makeZip, readZipStore } = require('./lib.js');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

function pngDims(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  assert.deepStrictEqual(Array.from(buf.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47], 'firma PNG');
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

(async () => {
  /* ---------- pack base sintético (little endian, como un pack de PS4) ---------- */
  const png = (w, h, c) => makePng(w, h, () => c);
  const atlas = png(64, 64, [30, 120, 30, 255]);          // 4×4 tiles de 16
  const stoneOld = png(16, 16, [90, 90, 90, 255]);
  const dirtOld = png(16, 16, [110, 70, 40, 255]);
  const animStrip = png(16, 32, [0, 100, 200, 255]);       // animación de 2 fotogramas
  const nested = PCK.writePck({
    pckType: 3, littleEndian: true,
    assets: [{ filename: 'icon.png', type: 2, data: png(8, 8, [255, 0, 0, 255]), params: [] }]
  });

  const baseAssets = [
    { filename: '0', type: 4, data: new Uint8Array(0), params: [['PACKID', '7777'], ['PACKVERSION', '0']] },
    { filename: 'languages.loc', type: 6, data: PCK.writeLoc({ languages: ['en-EN'], keys: { IDS_DISPLAY_NAME: { 'en-EN': 'Pack Base Prueba' } }, version: 2 }), params: [] },
    { filename: 'terrain.png', type: 2, data: new Uint8Array(atlas), params: [] },
    { filename: 'textures/blocks/stone.png', type: 2, data: new Uint8Array(stoneOld), params: [] },
    { filename: 'textures/blocks/dirt.png', type: 2, data: new Uint8Array(dirtOld), params: [] },
    { filename: 'textures/blocks/fire_0.png', type: 2, data: new Uint8Array(animStrip), params: [] },
    { filename: 'colours.col', type: 9, data: new Uint8Array([1, 2, 3, 4, 5, 6]), params: [] },
    { filename: 'x16/x16Info.pck', type: 5, data: nested, params: [['PACKID', '0'], ['DATAPATH', 'x16Data.pck']] }
  ];
  const baseBytes = PCK.writePck({ pckType: 3, littleEndian: true, assets: baseAssets });
  fs.writeFileSync(path.join(OUT, 'base-tex.pck'), Buffer.from(baseBytes));

  /* ---------- zip con texturas nuevas (rutas de Java moderno) ---------- */
  const newStone = png(16, 16, [10, 200, 10, 255]);
  const newDirt = png(32, 32, [200, 120, 20, 255]);        // se reescala a 16×16
  const newFire = png(8, 16, [255, 80, 0, 255]);           // 2 fotogramas más pequeños: se reescala por fotograma
  const newAtlas = png(64, 64, [80, 30, 200, 255]);
  const texturesZip = makeZip([
    { name: 'pack.mcmeta', data: '{}' },
    { name: 'assets/minecraft/textures/block/stone.png', data: newStone },
    { name: 'assets/minecraft/textures/blocks/dirt.png', data: newDirt }, // ruta antigua
    { name: 'assets/minecraft/textures/block/fire_0.png', data: newFire },
    { name: 'assets/minecraft/textures/block/terrain.png', data: newAtlas },
    { name: 'assets/minecraft/textures/block/granite.png', data: png(16, 16, [1, 2, 3, 255]) }, // sin destino
    { name: 'assets/minecraft/textures/gui/widgets.png', data: png(8, 8, [1, 1, 1, 255]) }      // ignorado
  ]);
  fs.writeFileSync(path.join(OUT, 'texturas.zip'), texturesZip);

  /* ---------- navegador ---------- */
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await page.waitForTimeout(250);

  /* 1. cambiar a la pestaña de texture packs */
  await page.click('#tabBtnTex');
  await page.waitForTimeout(150);
  assert.strictEqual(await page.isVisible('#panel-tex'), true, 'panel de texturas visible');
  assert.strictEqual(await page.isVisible('#panel-skins'), false, 'panel de skins oculto');
  console.log('  ✓ pestañas: skins ↔ texture packs');

  /* 2. cargar pack base */
  await page.setInputFiles('#baseInput', path.join(OUT, 'base-tex.pck'));
  await page.waitForFunction(() => document.querySelector('#baseState').textContent === 'cargado', null, { timeout: 10000 });
  const baseInfo = await page.textContent('#baseInfo');
  assert.ok(/Pack Base Prueba/.test(baseInfo), 'nombre del pack leído del .loc: ' + baseInfo);
  assert.ok(/little endian/.test(baseInfo), 'detecta little endian');
  console.log('  ✓ pack base cargado (nombre y endianness leídos)');

  /* 3. aplicar el zip */
  await page.setInputFiles('#texInput', path.join(OUT, 'texturas.zip'));
  await page.waitForFunction(() => Number(document.querySelector('#texSumPatched').textContent) === 4, null, { timeout: 20000 });
  const report = await page.textContent('#texReport');
  assert.ok(/textures\/blocks\/stone\.png/.test(report), 'stone emparejado');
  assert.ok(/no existe en el pack base/.test(report), 'granite reportado como sin destino');
  assert.ok(/reescalado por fotograma/.test(report), 'animación reescalada por fotograma: ' + report.slice(0, 400));
  console.log('  ✓ 4 texturas sustituidas, informe correcto');

  /* 4. descargar el .pck convertido a PS3 */
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#texDownloadBtn')]);
  const outPck = path.join(OUT, 'texturas-ps3.pck');
  await dl.saveAs(outPck);
  const data = fs.readFileSync(outPck);
  const parsed = PCK.readPck(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  assert.strictEqual(parsed.littleEndian, false, 'convertido a big endian (PS3)');
  assert.strictEqual(parsed.pckType, 3);
  assert.strictEqual(parsed.assets.length, baseAssets.length, 'mismo número de archivos');
  const byName = {};
  parsed.assets.forEach((a) => { byName[a.filename] = a; });

  assert.deepStrictEqual(pngDims(byName['textures/blocks/stone.png'].data), { w: 16, h: 16 });
  assert.notDeepStrictEqual(Array.from(byName['textures/blocks/stone.png'].data),
    Array.from(stoneOld), 'stone sustituido (bytes distintos)');
  assert.deepStrictEqual(pngDims(byName['textures/blocks/dirt.png'].data), { w: 16, h: 16 }, 'dirt reescalado a 16×16');
  assert.deepStrictEqual(pngDims(byName['terrain.png'].data), { w: 64, h: 64 });
  assert.deepStrictEqual(pngDims(byName['textures/blocks/fire_0.png'].data), { w: 16, h: 32 },
    'tira de animación mantenida en 2 fotogramas');
  assert.deepStrictEqual(Array.from(byName['colours.col'].data), [1, 2, 3, 4, 5, 6], 'colours.col intacto');
  assert.strictEqual(byName['0'].get('PACKID'), '7777');

  // el sub-PCK incrustado también debe haberse convertido a big endian
  const sub = PCK.readPck(byName['x16/x16Info.pck'].data);
  assert.strictEqual(sub.littleEndian, false, 'sub-PCK convertido también');
  assert.strictEqual(sub.assets[0].filename, 'icon.png');
  console.log('  ✓ .pck exportado: BE, 8 archivos, sub-PCK convertido, colours.col intacto');

  /* 5. exportar los PNG del pack a un zip y comprobar que se puede reimportar */
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#texZipBtn')]);
  const zipPath = path.join(OUT, 'export-png.zip');
  await dl2.saveAs(zipPath);
  const zipBytes = fs.readFileSync(zipPath);
  const entries = readZipStore(zipBytes);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('terrain.png'), 'el zip incluye terrain.png');
  assert.ok(names.includes('textures/blocks/stone.png'));
  assert.ok(names.includes('LEEME.txt'));
  assert.deepStrictEqual(pngDims(entries.find((e) => e.name === 'terrain.png').data), { w: 64, h: 64 });
  console.log('  ✓ export .zip con ' + (names.length - 1) + ' PNG reimportables');

  /* 6. reimportar ese zip sobre el mismo pack base */
  await page.setInputFiles('#texInput', zipPath);
  await page.waitForFunction(() => document.querySelectorAll('#texReport .r-row').length >= 8, null, { timeout: 20000 });
  console.log('  ✓ zip reimportado sobre el pack base');

  /* 7. verificación integrada + captura */
  await page.click('#texVerifyBtn');
  await page.waitForSelector('#texLog.show', { timeout: 5000 });
  const log = await page.textContent('#texLog');
  assert.ok(/Estructura verificada/.test(log));
  await page.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); window.scrollTo(0, 0); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'shot-tex.png'), fullPage: true });
  console.log('  ✓ verificación integrada OK');

  assert.deepStrictEqual(errors, [], 'errores de consola: ' + errors.join(' | '));
  console.log('\nE2E TEXTURE PACKS OK');
  await browser.close();
})().catch((e) => { console.error('FALLO E2E:', e); process.exit(1); });
