/* E2E del editor de skin: píxeles, capas PNG y móvil (node test/e2e-editor.js) */
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const leerCanvas = (page) => page.evaluate(() => {
  const c = document.querySelector('#edCanvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const s = c.width / 64;
  const at = (x, y) => {
    const o = (Math.floor(y * s) * c.width + Math.floor(x * s)) * 4;
    return [d[o], d[o + 1], d[o + 2], d[o + 3]];
  };
  return { at: null, size: [c.width, c.height] };
});

(async () => {
  const skinPng = path.join(OUT, 'steve.png');
  if (!fs.existsSync(skinPng)) require('./mkskins.js');
  const alexPng = path.join(OUT, 'alex.png');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));

  /* 1. abrir el editor desde la tarjeta */
  await page.setInputFiles('#fileInput', skinPng);
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 1, null, { timeout: 15000 });
  await page.click('.skin-card .edit-btn');
  await page.waitForFunction(() => document.querySelector('#editOverlay').classList.contains('show'), null, { timeout: 5000 });
  await page.waitForTimeout(300);
  assert.strictEqual(await page.locator('.ed-layer').count(), 1, 'al abrir hay una capa (la base)');
  const lienzo = await page.evaluate(() => {
    const c = document.querySelector('#edCanvas');
    const r = c.getBoundingClientRect();
    return { buffer: c.width, css: Math.round(r.width), cssH: Math.round(r.height) };
  });
  assert.strictEqual(lienzo.buffer, lienzo.css, 'la skin se pinta 1 píxel = 1 píxel de lienzo × zoom');
  assert.strictEqual(lienzo.css, lienzo.cssH, 'el lienzo es cuadrado (no deforma la skin)');
  console.log('  ✓ el editor abre con la textura de la skin (' + lienzo.css + '×' + lienzo.cssH + ' px)');

  /* 2. pintar un píxel con el ratón */
  const pintar = async (x, y) => {
    const r = await page.locator('#edCanvas').boundingBox();
    const s = r.width / 64;
    await page.mouse.move(r.x + (x + 0.5) * s, r.y + (y + 0.5) * s);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(120);
  };
  const pixel = (x, y) => page.evaluate(([px, py]) => {
    const c = document.querySelector('#edCanvas');
    const s = c.width / 64;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const o = (Math.floor(py * s + s / 2) * c.width + Math.floor(px * s + s / 2)) * 4;
    return [d[o], d[o + 1], d[o + 2], d[o + 3]].join(',');
  }, [x, y]);

  await page.fill('#edColor', '#ff0000');
  await pintar(3, 3);
  assert.strictEqual(await pixel(3, 3), '255,0,0,255', 'el píxel pintado sale rojo');
  console.log('  ✓ pintar con el ratón escribe en la textura');

  /* 3. deshacer */
  await page.click('#edUndo');
  await page.waitForTimeout(150);
  assert.notStrictEqual(await pixel(3, 3), '255,0,0,255', 'deshacer revierte el píxel');
  console.log('  ✓ deshacer funciona');

  /* 4. subir una capa PNG encima */
  await page.setInputFiles('#edFileInput', alexPng);
  await page.waitForTimeout(500);
  assert.strictEqual(await page.locator('.ed-layer').count(), 2, 'la PNG entra como capa nueva');
  const nombres = await page.evaluate(() => [...document.querySelectorAll('.ed-layer .ln b')].map((b) => b.textContent));
  assert.deepStrictEqual(nombres, ['Skin (base)', 'alex'], 'capas: ' + nombres.join(' · '));
  const conCapa = await pixel(10, 20);
  await page.click('.ed-layer:nth-child(2) [data-act="eye"]');   // ocultar la capa
  await page.waitForTimeout(250);
  const sinCapa = await pixel(10, 20);
  assert.notStrictEqual(conCapa, sinCapa, 'el ojo de la capa cambia lo que se ve (' + conCapa + ' → ' + sinCapa + ')');
  await page.click('.ed-layer:nth-child(2) [data-act="eye"]');   // volver a mostrarla
  await page.waitForTimeout(200);
  console.log('  ✓ subir capa PNG + ojo de visibilidad');

  /* 5. opacidad de la capa */
  await page.evaluate(() => {
    const r = document.querySelectorAll('.ed-layer')[1].querySelector('input[type=range]');
    r.value = '40';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(250);
  const al40 = await pixel(10, 20);
  assert.notStrictEqual(al40, conCapa, 'la opacidad al 40 % mezcla la capa con la base');
  console.log('  ✓ opacidad por capa');

  /* 6. guardar: la skin del pack cambia de verdad */
  const antes = await page.getAttribute('.skin-card .skin-thumb img', 'src');
  await page.click('#edSave');
  await page.waitForTimeout(600);
  const despues = await page.getAttribute('.skin-card .skin-thumb img', 'src');
  assert.notStrictEqual(antes, despues, 'la miniatura de la tarjeta se actualiza');
  const pngPill = await page.textContent('.skin-card .skin-meta .pill');
  assert.ok(/PNG/.test(pngPill), 'la pastilla del PNG sigue ahí: ' + pngPill);
  // y el pack exporta ese PNG
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  const p = path.join(OUT, 'editor.pck');
  await dl.saveAs(p);
  const PCK = require('../src/pck.js');
  const buf = fs.readFileSync(p);
  const parsed = PCK.readPck(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const asset = parsed.assets.find((a) => a.type === 0);
  const bytes = asset.data || asset.png;
  assert.ok(bytes && bytes.length > 300, 'el .pck lleva la textura editada (' + (bytes ? bytes.length : 0) + ' B)');
  console.log('  ✓ guardar escribe en la skin y en el .pck exportado');

  /* 7. cancelar no toca la skin */
  await page.click('.skin-card .edit-btn');
  await page.waitForFunction(() => document.querySelector('#editOverlay').classList.contains('show'));
  await page.waitForTimeout(250);
  await page.fill('#edColor', '#00ff00');
  await pintar(30, 30);
  const antesCancel = await page.getAttribute('.skin-card .skin-thumb img', 'src');
  await page.click('#edCancel');
  await page.waitForTimeout(300);
  const trasCancel = await page.getAttribute('.skin-card .skin-thumb img', 'src');
  assert.strictEqual(antesCancel, trasCancel, 'cancelar deja la skin como estaba');
  console.log('  ✓ cancelar descarta los cambios');

  /* 8. móvil: todo táctil, sin deformar y con botones grandes */
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const movil = await ctx.newPage();
  const errsMovil = [];
  movil.on('pageerror', (e) => errsMovil.push(String(e)));
  await movil.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await movil.setInputFiles('#fileInput', skinPng);
  await movil.waitForFunction(() => document.querySelectorAll('.skin-card').length === 1, null, { timeout: 15000 });
  const btn = await movil.locator('.skin-card .edit-btn').boundingBox();
  assert.ok(btn.width >= 36 && btn.height >= 36, 'el botón de editar es cómodo en móvil: ' + Math.round(btn.width) + '×' + Math.round(btn.height));
  await movil.locator('.skin-card .edit-btn').tap();
  await movil.waitForFunction(() => document.querySelector('#editOverlay').classList.contains('show'));
  await movil.waitForTimeout(400);
  const r = await movil.locator('#edCanvas').boundingBox();
  assert.ok(Math.abs(r.width - r.height) < 1.5, 'en móvil el lienzo sigue cuadrado: ' + Math.round(r.width) + '×' + Math.round(r.height));
  const sr = await movil.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: window.innerWidth }));
  assert.ok(sr.sw <= sr.vw + 1, 'sin scroll horizontal: ' + sr.sw + ' ≤ ' + sr.vw);
  const alturas = await movil.evaluate(() => [...document.querySelectorAll('.ed-tools .tool, .ed-actions .btn, .ed-zoom .btn')]
    .map((b) => Math.round(b.getBoundingClientRect().height)));
  assert.ok(alturas.every((h) => h >= 42), 'todos los botones del editor ≥ 42 px: ' + alturas.join(','));
  const s = r.width / 64;
  await movil.touchscreen.tap(r.x + (12 + 0.5) * s, r.y + (12 + 0.5) * s);
  await movil.waitForTimeout(250);
  const tocado = await movil.evaluate(() => {
    const c = document.querySelector('#edCanvas');
    const sc = c.width / 64;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const o = (Math.floor(12 * sc + sc / 2) * c.width + Math.floor(12 * sc + sc / 2)) * 4;
    return [d[o], d[o + 1], d[o + 2], d[o + 3]].join(',');
  });
  assert.strictEqual(tocado, '0,175,175,255', 'tocar pinta con el dedo: ' + tocado);
  await movil.screenshot({ path: path.join(OUT, 'shot-movil-editor.png') });
  assert.deepStrictEqual(errsMovil, [], 'errores en móvil: ' + errsMovil.join(' | '));
  console.log('  ✓ en móvil: táctil, cuadrado, sin scroll lateral y botones grandes');

  assert.deepStrictEqual(errors, [], 'errores de consola: ' + errors.join(' | '));
  console.log('\nE2E EDITOR SKIN OK');
  await browser.close();
})().catch((e) => { console.error('FALLO E2E EDITOR:', e); process.exit(1); });
