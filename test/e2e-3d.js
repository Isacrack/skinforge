/* E2E del modelo 3D: .bbmodel → parámetros BOX de LCE (node test/e2e-3d.js) */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const PCK = require('../src/pck.js');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

/* ---------- modelo de jugador estándar, con la cabeza más grande ---------- */
function standardModel(opts = {}) {
  const cubes = [
    ['head', [-5, 24, -5], [5, 34, 5], [0, 0]],
    ['hat', [-5, 24, -5], [5, 34, 5], [32, 0]],
    ['body', [-4, 12, -2], [4, 24, 2], [16, 16]],
    ['jacket', [-4, 12, -2], [4, 24, 2], [16, 32]],
    ['right_arm', [-8, 12, -2], [-4, 24, 2], [40, 16]],
    ['right_sleeve', [-8, 12, -2], [-4, 24, 2], [40, 32]],
    ['left_arm', [4, 12, -2], [8, 24, 2], [32, 48]],
    ['left_sleeve', [4, 12, -2], [8, 24, 2], [48, 48]],
    ['right_leg', [-4, 0, -2], [0, 12, 2], [0, 16]],
    ['right_pants', [-4, 0, -2], [0, 12, 2], [0, 32]],
    ['left_leg', [0, 0, -2], [4, 12, 2], [16, 48]],
    ['left_pants', [0, 0, -2], [4, 12, 2], [0, 48]]
  ];
  const elements = cubes.map(([name, from, to, uv]) => ({
    name, from, to, origin: [0, 24, 0], uv_offset: uv, box_uv: true, inflate: 0, rotation: [0, 0, 0]
  }));
  // cubo que no corresponde a ninguna parte del jugador
  elements.push({ name: 'tail', from: [0, 0, 3], to: [2, 10, 5], origin: [0, 0, 0], uv_offset: [0, 0], box_uv: true });
  if (opts.inflateHat) {
    const hat = elements.find((e) => e.name === 'hat');
    hat.inflate = opts.inflateHat;
  }
  if (opts.fractional) {
    const head = elements.find((e) => e.name === 'head');
    head.from = [-4.4, 24, -4]; head.to = [4.6, 31.5, 4];
  }
  if (opts.slim) {
    const ra = elements.find((e) => e.name === 'right_arm');
    const la = elements.find((e) => e.name === 'left_arm');
    ra.from = [-7, 12, -2]; ra.to = [-4, 24, 2];
    la.from = [4, 12, -2]; la.to = [7, 24, 2];
  }
  return {
    meta: { format_version: '4.10', model_format: 'java_block' },
    name: opts.name || 'Player HD',
    resolution: { width: 64, height: 64 },
    elements,
    textures: opts.textureB64 ? [{ name: 'skin.png', source: opts.textureB64, uv_width: 64, uv_height: 64 }] : []
  };
}

function pngDataUrl(file) {
  return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
}

(async () => {
  const skinPng = path.join(OUT, 'steve.png');
  if (!fs.existsSync(skinPng)) require('./mkskins.js');
  const b64 = pngDataUrl(skinPng);

  const modelPath = path.join(OUT, 'player-hd.bbmodel');
  fs.writeFileSync(modelPath, JSON.stringify(standardModel({ textureB64: b64 })));
  const modelV3Path = path.join(OUT, 'player-v3.bbmodel');
  fs.writeFileSync(modelV3Path, JSON.stringify(standardModel({ textureB64: b64, inflateHat: 0.75, name: 'Player V3' })));
  const modelFracPath = path.join(OUT, 'player-frac.bbmodel');
  fs.writeFileSync(modelFracPath, JSON.stringify(standardModel({ textureB64: b64, fractional: true, name: 'Player Fracciones' })));
  const modelSlimPath = path.join(OUT, 'player-slim.bbmodel');
  fs.writeFileSync(modelSlimPath, JSON.stringify(standardModel({ textureB64: b64, slim: true, name: 'Player Slim' })));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await page.waitForTimeout(250);

  /* 1. soltar el .bbmodel: debe crear una skin con su textura */
  await page.setInputFiles('#fileInput', modelPath);
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 1, null, { timeout: 15000 });
  await page.waitForFunction(() => /Modelo:/.test(document.querySelector('.skin-card').textContent), null, { timeout: 15000 });
  const pill = await page.textContent('.skin-card .pill.model-on');
  assert.ok(/12 cajas · XMLVERSION 2/.test(pill), 'pastilla del modelo: ' + pill);
  const thumb = await page.getAttribute('.skin-card .skin-thumb img', 'src');
  assert.ok(thumb.startsWith('data:image/png'), 'la textura viene dentro del .bbmodel');
  console.log('  ✓ .bbmodel con textura embebida → skin con 12 cajas (XMLVERSION 2)');

  /* 2. vista 3D: el canvas debe dibujar algo */
  await page.click('.skin-card .doll-btn');
  await page.waitForTimeout(600);
  const dollInfo = await page.textContent('#dollMeta');
  assert.ok(/modelo 3D: 12 cajas/.test(dollInfo), 'meta del modal: ' + dollInfo);
  const note = await page.textContent('#dollNote');
  assert.ok(/tail/.test(note), 'aviso del cubo ignorado: ' + note);
  const painted = await page.evaluate(() => {
    const c = document.querySelector('#dollCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  assert.ok(painted > 10000, 'la vista 3D pinta píxeles: ' + painted);
  await page.locator('#dollOverlay').screenshot({ path: path.join(OUT, 'shot-3d.png') });
  await page.click('#dollClose');
  console.log('  ✓ vista 3D isométrica dibujada (' + painted + ' px) y avisos mostrados');

  /* 3. descargar y comprobar los parámetros BOX */
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  const p1 = path.join(OUT, 'modelo.pck');
  await dl.saveAs(p1);
  const buf = fs.readFileSync(p1);
  const parsed = PCK.readPck(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.strictEqual(parsed.littleEndian, false);
  assert.strictEqual(parsed.xmlVersion, 2, 'XMLVERSION 2 en la cabecera');
  const skin = parsed.assets.find((a) => a.type === 0);
  const boxes = skin.params.filter((p) => p[0] === 'BOX').map((p) => p[1]);
  assert.strictEqual(boxes.length, 12, 'doce cajas BOX');
  const expect = {
    'HEAD -5 -10 -5 10 10 10 0 0': 'cabeza agrandada',
    'HEADWEAR -5 -10 -5 10 10 10 32 0 1 0': 'sombrero (oculto con casco)',
    'BODY -4 0 -2 8 12 4 16 16': 'cuerpo',
    'JACKET -4 0 -2 8 12 4 16 32 2 0': 'chaqueta (oculta con peto)',
    'ARM0 -3 -2 -2 4 12 4 40 16': 'brazo derecho',
    'SLEEVE0 -3 -2 -2 4 12 4 40 32 2 0': 'manga derecha (oculta con peto)',
    'ARM1 -1 -2 -2 4 12 4 32 48': 'brazo izquierdo',
    'SLEEVE1 -1 -2 -2 4 12 4 48 48 2 0': 'manga izquierda (oculta con peto)',
    'LEG0 -2 0 -2 4 12 4 0 16': 'pierna derecha',
    'PANTS0 -2 0 -2 4 12 4 0 32 4 0': 'pantalón derecho (oculto con gregüesco)',
    'LEG1 -2 0 -2 4 12 4 16 48': 'pierna izquierda',
    'PANTS1 -2 0 -2 4 12 4 0 48 4 0': 'pantalón izquierdo (oculto con gregüesco)'
  };
  Object.keys(expect).forEach((b) => {
    assert.ok(boxes.includes(b), 'falta la caja ' + expect[b] + ': «' + b + '» → ' + JSON.stringify(boxes));
  });
  console.log('  ✓ 12 parámetros BOX correctos (valores estándar de LCE)');

  /* 4. modelo con inflado propio → XMLVERSION 3 */
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  await page.setInputFiles('#fileInput', modelV3Path);
  await page.waitForFunction(() => /Modelo:/.test(document.querySelector('.skin-card')?.textContent || ''), null, { timeout: 15000 });
  const pill3 = await page.textContent('.skin-card .pill.model-on');
  assert.ok(/XMLVERSION 3/.test(pill3), 'pastilla v3: ' + pill3);
  const [dl3] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  const p3 = path.join(OUT, 'modelo-v3.pck');
  await dl3.saveAs(p3);
  const b3 = fs.readFileSync(p3);
  const parsed3 = PCK.readPck(b3.buffer.slice(b3.byteOffset, b3.byteOffset + b3.byteLength));
  assert.strictEqual(parsed3.xmlVersion, 3, 'XMLVERSION 3');
  const boxes3 = parsed3.assets.find((a) => a.type === 0).params.filter((p) => p[0] === 'BOX').map((p) => p[1]);
  assert.ok(boxes3.includes('HEADWEAR -5 -10 -5 10 10 10 32 0 1 0 0.75'), 'inflado explícito del sombrero: ' + JSON.stringify(boxes3));
  assert.ok(boxes3.includes('JACKET -4 0 -2 8 12 4 16 32 2 0 0.25'), 'inflado explícito de la chaqueta');
  console.log('  ✓ inflado propio → XMLVERSION 3 con argumento de inflado');

  /* 5. modelo slim */
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  await page.setInputFiles('#fileInput', modelSlimPath);
  await page.waitForFunction(() => /Modelo:/.test(document.querySelector('.skin-card')?.textContent || ''), null, { timeout: 15000 });
  const modelSel = await page.inputValue('.skin-card [data-role="model"]');
  assert.strictEqual(modelSel, 'slim', 'detecta brazos de 3 px → modelo slim');
  const [dl5] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  const p5 = path.join(OUT, 'modelo-slim.pck');
  await dl5.saveAs(p5);
  const b5 = fs.readFileSync(p5);
  const parsed5 = PCK.readPck(b5.buffer.slice(b5.byteOffset, b5.byteOffset + b5.byteLength));
  const skin5 = parsed5.assets.find((a) => a.type === 0);
  assert.strictEqual(skin5.get('ANIM'), '0x00080000', 'ANIM slim');
  const boxes5 = skin5.params.filter((p) => p[0] === 'BOX').map((p) => p[1]);
  assert.ok(boxes5.some((b) => b.startsWith('ARM0 ') && b.includes('3 12 4')), 'brazo de 3 px: ' + JSON.stringify(boxes5));
  console.log('  ✓ modelo slim detectado (ANIM 0x00080000, brazos de 3 px)');

  /* 6b. editor de armadura: máscara por caja y presets */
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  await page.setInputFiles('#fileInput', modelPath);
  await page.waitForFunction(() => /Modelo:/.test(document.querySelector('.skin-card')?.textContent || ''), null, { timeout: 15000 });
  const chipArmor = await page.textContent('.skin-card .warn-pill');
  assert.ok(/6 ocultables/.test(chipArmor), 'pastilla de armadura: ' + chipArmor);
  await page.click('.skin-card .doll-btn');
  await page.waitForTimeout(400);
  const filas = await page.locator('.box-row').count();
  assert.strictEqual(filas, 12, 'una fila por caja en el editor');
  // el sombrero trae «casco» marcado y la chaqueta «peto»
  const hatBits = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.box-row')].find((r) => r.querySelector('.be-type').textContent === 'HEADWEAR');
    return [...row.querySelectorAll('input[data-bit]')].map((c) => [c.dataset.bit, c.checked]);
  });
  assert.deepStrictEqual(hatBits, [['1', true], ['2', false], ['4', false], ['8', false]], 'sombrero → casco: ' + JSON.stringify(hatBits));
  const jakBits = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.box-row')].find((r) => r.querySelector('.be-type').textContent === 'JACKET');
    return [...row.querySelectorAll('input[data-bit]')].map((c) => [c.dataset.bit, c.checked]);
  });
  assert.deepStrictEqual(jakBits, [['1', false], ['2', true], ['4', false], ['8', false]], 'chaqueta → peto: ' + JSON.stringify(jakBits));
  // marcar «casco» en la cabeza agrandada
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.box-row')].find((r) => r.querySelector('.be-type').textContent === 'HEAD');
    row.querySelector('input[data-bit="1"]').click();
  });
  await page.waitForTimeout(200);
  const headLabel = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.box-row')].find((r) => r.querySelector('.be-type').textContent === 'HEAD');
    return row.querySelector('[data-role="label"]').textContent;
  });
  assert.strictEqual(headLabel, 'oculta con casco', 'etiqueta de la cabeza: ' + headLabel);
  await page.locator('#dollOverlay .modal').screenshot({ path: path.join(OUT, 'shot-armor.png') });
  await page.click('#dollClose');
  const [dlA] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  const pA = path.join(OUT, 'modelo-armor.pck');
  await dlA.saveAs(pA);
  const bA = fs.readFileSync(pA);
  const parsedA = PCK.readPck(bA.buffer.slice(bA.byteOffset, bA.byteOffset + bA.byteLength));
  const boxesA = parsedA.assets.find((a) => a.type === 0).params.filter((x) => x[0] === 'BOX').map((x) => x[1]);
  assert.ok(boxesA.includes('HEAD -5 -10 -5 10 10 10 0 0 1 0'), 'cabeza con máscara de casco: ' + JSON.stringify(boxesA));
  console.log('  ✓ máscara de armadura por caja (sombrero→casco, chaqueta→peto, cabeza a mano)');

  // preset «Todo» → 15 en todas las cajas
  await page.click('.skin-card .doll-btn');
  await page.waitForTimeout(300);
  await page.click('[data-preset="all"]');
  await page.waitForTimeout(300);
  await page.click('#dollClose');
  const [dlAll] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  const pAll = path.join(OUT, 'modelo-armor-all.pck');
  await dlAll.saveAs(pAll);
  const bAll = fs.readFileSync(pAll);
  const parsedAll = PCK.readPck(bAll.buffer.slice(bAll.byteOffset, bAll.byteOffset + bAll.byteLength));
  const boxesAll = parsedAll.assets.find((a) => a.type === 0).params.filter((x) => x[0] === 'BOX').map((x) => x[1]);
  assert.ok(boxesAll.every((b) => b.split(' ')[9] === '15'), 'preset Todo → máscara 15: ' + JSON.stringify(boxesAll));
  console.log('  ✓ preset «Todo» pone la máscara 15 en las 12 cajas');

  /* 7. ciclo completo: reimportar el .pck y volver a exportar sin perder la geometría */
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  await page.setInputFiles('#fileInput', p1);
  await page.waitForFunction(() => /Modelo: 12 cajas/.test(document.querySelector('.skin-card .pill.model-on')?.textContent || ''), null, { timeout: 15000 });
  const xmlSel = await page.inputValue('#xmlVersion');
  assert.strictEqual(xmlSel, '2', 'el XMLVERSION del pack importado pasa al ajuste avanzado');
  const [dl7] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  const p7 = path.join(OUT, 'modelo-reimportado.pck');
  await dl7.saveAs(p7);
  const b7 = fs.readFileSync(p7);
  const parsed7 = PCK.readPck(b7.buffer.slice(b7.byteOffset, b7.byteOffset + b7.byteLength));
  assert.strictEqual(parsed7.xmlVersion, 2);
  const boxes7 = parsed7.assets.find((a) => a.type === 0).params.filter((x) => x[0] === 'BOX').map((x) => x[1]);
  assert.deepStrictEqual(boxes7.sort(), boxes.slice().sort(), 'los BOX sobreviven al ciclo importar → exportar');
  console.log('  ✓ ciclo importar/exportar conserva las 12 cajas y el XMLVERSION');

  /* 8. cubos con decimales: el juego trunca a enteros, así que se redondea antes */
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  await page.setInputFiles('#fileInput', modelFracPath);
  await page.waitForFunction(() => /Modelo:/.test(document.querySelector('.skin-card')?.textContent || ''), null, { timeout: 15000 });
  const [dl8] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  const p8 = path.join(OUT, 'modelo-frac.pck');
  await dl8.saveAs(p8);
  const b8 = fs.readFileSync(p8);
  const parsed8 = PCK.readPck(b8.buffer.slice(b8.byteOffset, b8.byteOffset + b8.byteLength));
  const boxes8 = parsed8.assets.find((a) => a.type === 0).params.filter((x) => x[0] === 'BOX').map((x) => x[1]);
  assert.ok(boxes8.includes('HEAD -4 -8 -4 9 8 8 0 0'), 'cabeza redondeada a enteros: ' + boxes8[0]);
  assert.ok(boxes8.every((b) => !/\d\.\d/.test(b)), 'ninguna caja con decimales');
  console.log('  ✓ decimales del .bbmodel redondeados a enteros (LCE trunca)');

  /* 9. plantilla .bbmodel descargable desde la propia página */
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  await page.setInputFiles('#fileInput', skinPng);   // una skin normal, sin modelo
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 1, null, { timeout: 15000 });
  const [dlEx] = await Promise.all([page.waitForEvent('download'), page.click('#exampleModelBtn')]);
  const pEx = path.join(OUT, 'plantilla-descargada.bbmodel');
  await dlEx.saveAs(pEx);
  const json = JSON.parse(fs.readFileSync(pEx, 'utf8'));
  assert.strictEqual(json.elements.length, 12, 'la plantilla trae las 12 partes');
  assert.deepStrictEqual(json.groups.map((g) => g.name),
    ['head', 'body', 'right_arm', 'left_arm', 'right_leg', 'left_leg'], 'la plantilla trae 6 carpetas');
  assert.strictEqual(json.meta.format_version, '5.0', 'formato bbmodel 5.0 (Blockbench 5, oct-2025)');
  const hijos = json.outliner.flatMap((n) => n.children || []);
  assert.strictEqual(hijos.length, 12, 'las carpetas reparten los 12 cubos');
  assert.ok(json.elements.every((e) => hijos.includes(e.uuid)), 'todos los cubos están dentro de una carpeta');
  assert.ok(json.outliner.every((n) => n.uuid && n.isOpen === true && Array.isArray(n.children)),
    'el outliner son nodos {uuid, isOpen, children}');
  assert.deepStrictEqual(json.outliner.map((n) => n.uuid), json.groups.map((g) => g.uuid),
    'cada nodo del outliner casa con su grupo por uuid');
  assert.ok(json.groups.every((g) => !('children' in g)), 'en 5.0 los grupos no llevan children (van en el outliner)');
  assert.ok(json.textures[0].source.startsWith('data:image/png;base64,'), 'la plantilla lleva la textura dentro');
  assert.deepStrictEqual(json.elements.map((e) => e.name), ['head', 'hat', 'body', 'jacket', 'right_arm',
    'right_sleeve', 'left_arm', 'left_sleeve', 'right_leg', 'right_pants', 'left_leg', 'left_pants']);
  const hatArmor = json.elements.find((e) => e.name === 'hat').lce_armor;
  assert.strictEqual(hatArmor, 1, 'la plantilla sugiere casco para el sombrero');
  // y al volver a soltarla, la herramienta la interpreta bien: la plantilla se llama
  // «steve (modelo)» y apunta a «steve.png», así que el modelo se aplica a la skin que ya está
  await page.setInputFiles('#fileInput', pEx);
  await page.waitForFunction(() => /12 cajas/.test(document.querySelector('.skin-card .pill.model-on')?.textContent || ''), null, { timeout: 15000 });
  assert.strictEqual(await page.locator('.skin-card').count(), 1, 'la plantilla se aplica a la skin del mismo nombre, sin duplicarla');
  const createOk = await page.textContent('.skin-card .pill.model-on');
  assert.ok(/12 cajas/.test(createOk), 'la plantilla reimportada crea 12 cajas: ' + createOk);
  console.log('  ✓ plantilla .bbmodel descargable desde la página y reimportable');

  /* 10. ejemplos del proyecto: caballero con hombreras y crestas */
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  const caballero = path.join(__dirname, '..', 'ejemplos', 'caballero-armadura.bbmodel');
  await page.setInputFiles('#fileInput', caballero);
  await page.waitForFunction(() => /Modelo:/.test(document.querySelector('.skin-card .pill.model-on')?.textContent || ''), null, { timeout: 15000 });
  const pillCab = await page.textContent('.skin-card .pill.model-on');
  assert.ok(/15 cajas/.test(pillCab), 'el caballero trae 15 cajas (12 + hombreras + cresta): ' + pillCab);
  const [dlCab] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  const pCab = path.join(OUT, 'caballero.pck');
  await dlCab.saveAs(pCab);
  const bCab = fs.readFileSync(pCab);
  const parsedCab = PCK.readPck(bCab.buffer.slice(bCab.byteOffset, bCab.byteOffset + bCab.byteLength));
  const boxesCab = parsedCab.assets.find((a) => a.type === 0).params.filter((x) => x[0] === 'BOX').map((x) => x[1]);
  assert.strictEqual(boxesCab.length, 15);
  // la cabeza de 10×10×10 va marcada con casco desde el propio .bbmodel
  assert.ok(boxesCab.includes('HEAD -5 -10 -5 10 10 10 0 0 1 0'), 'cabeza agrandada + casco: ' + JSON.stringify(boxesCab));
  // las hombreras son cajas extra de tipo ARM0/ARM1 y se ocultan con el peto
  const pads = boxesCab.filter((b) => b.startsWith('ARM0 ') || b.startsWith('ARM1 '));
  assert.strictEqual(pads.length, 4, 'dos brazos + dos hombreras');
  assert.ok(pads.filter((b) => b.split(' ')[9] === '2').length >= 2, 'hombreras con máscara de peto');
  console.log('  ✓ ejemplo del caballero: 15 cajas, cabeza grande con casco y hombreras con peto');

  /* 11. cubos con nombres raros: manda el nombre de la carpeta */
  const raro = {
    meta: { format_version: '4.10', model_format: 'java_block', box_uv: true },
    name: 'Con carpetas',
    resolution: { width: 64, height: 64 },
    elements: [
      { uuid: 'aaa', type: 'cube', name: 'cubo1', from: [-4, 24, -4], to: [4, 32, 4], origin: [0, 24, 0], uv_offset: [0, 0], box_uv: true },
      { uuid: 'bbb', type: 'cube', name: 'cubo2', from: [-4, 12, -2], to: [4, 24, 2], origin: [0, 24, 0], uv_offset: [16, 16], box_uv: true },
      { uuid: 'ccc', type: 'cube', name: 'lo_que_sea', from: [4, 12, -2], to: [8, 24, 2], origin: [5, 22, 0], uv_offset: [32, 48], box_uv: true },
      { uuid: 'ddd', type: 'cube', name: 'cubo_huerfano', from: [0, 30, 0], to: [2, 32, 2], origin: [0, 0, 0], uv_offset: [0, 0], box_uv: true }
    ],
    groups: [
      { uuid: 'g1', type: 'group', name: 'head', children: ['aaa'] },
      { uuid: 'g2', type: 'group', name: 'body', children: ['bbb'] },
      { uuid: 'g3', type: 'group', name: 'left_arm', children: ['ccc'] }
    ],
    outliner: ['g1', 'g2', 'g3', 'ddd'],
    textures: [{ name: 'skin.png', id: '0', source: b64, uv_width: 64, uv_height: 64 }]
  };
  const raroPath = path.join(OUT, 'con-carpetas.bbmodel');
  fs.writeFileSync(raroPath, JSON.stringify(raro));
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  await page.setInputFiles('#fileInput', raroPath);
  await page.waitForFunction(() => /Modelo:/.test(document.querySelector('.skin-card .pill.model-on')?.textContent || ''), null, { timeout: 15000 });
  const pillRaro = await page.textContent('.skin-card .pill.model-on');
  assert.ok(/3 cajas/.test(pillRaro), 'solo entran los cubos con carpeta válida: ' + pillRaro);
  const [dlR] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  const pR = path.join(OUT, 'con-carpetas.pck');
  await dlR.saveAs(pR);
  const bR = fs.readFileSync(pR);
  const parsedR = PCK.readPck(bR.buffer.slice(bR.byteOffset, bR.byteOffset + bR.byteLength));
  const boxesR = parsedR.assets.find((a) => a.type === 0).params.filter((x) => x[0] === 'BOX').map((x) => x[1]);
  assert.deepStrictEqual(boxesR.map((b) => b.split(' ')[0]).sort(), ['ARM1', 'BODY', 'HEAD'],
    'la carpeta decide la parte: ' + JSON.stringify(boxesR));
  console.log('  ✓ si el cubo no dice nada, manda el nombre de la carpeta (head/body/left_arm)');

  /* 12. OFFSET de armadura y flags de skin (lo que en PCK Studio es «Offset» y «Skin Flags») */
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  await page.setInputFiles('#fileInput', modelPath);
  await page.waitForFunction(() => /Modelo:/.test(document.querySelector('.skin-card')?.textContent || ''), null, { timeout: 15000 });
  await page.click('.skin-card .doll-btn');
  await page.waitForTimeout(400);
  assert.strictEqual(await page.locator('input[data-off]').count(), 9, 'nueve piezas de armadura movibles');
  await page.fill('input[data-off="HELMET"]', '-2');
  await page.dispatchEvent('input[data-off="HELMET"]', 'change');
  await page.fill('input[data-off="CHEST"]', '1');
  await page.dispatchEvent('input[data-off="CHEST"]', 'change');
  await page.check('#hideArmorChk');
  await page.check('#unfairChk');
  await page.locator('#dollOverlay .modal').screenshot({ path: path.join(OUT, 'shot-offsets.png') });
  await page.click('#dollClose');
  const [dlO] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  const pO = path.join(OUT, 'modelo-offsets.pck');
  await dlO.saveAs(pO);
  const bO = fs.readFileSync(pO);
  const parsedO = PCK.readPck(bO.buffer.slice(bO.byteOffset, bO.byteOffset + bO.byteLength));
  const skinO = parsedO.assets.find((a) => a.type === 0);
  const offs = skinO.params.filter((x) => x[0] === 'OFFSET').map((x) => x[1]);
  assert.deepStrictEqual(offs.sort(), ['CHEST Y 1', 'HELMET Y -2'], 'OFFSET por pieza: ' + JSON.stringify(offs));
  assert.strictEqual(skinO.get('ANIM'), '0x00040100', 'bit 9 de ANIM (ocultar armadura)');
  assert.strictEqual(skinO.get('GAME_FLAGS'), '0x19', 'bit 1 de GAME_FLAGS (Battle Mode)');
  console.log('  ✓ OFFSET de armadura (casco -2, peto +1) y flags ANIM/GAME_FLAGS');

  // y vuelven al reimportar
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  await page.setInputFiles('#fileInput', pO);
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 1, null, { timeout: 15000 });
  await page.click('.skin-card .doll-btn');
  await page.waitForTimeout(400);
  assert.strictEqual(await page.inputValue('input[data-off="HELMET"]'), '-2', 'el OFFSET se relee');
  assert.strictEqual(await page.inputValue('input[data-off="CHEST"]'), '1');
  assert.ok(await page.isChecked('#hideArmorChk'), 'el flag de ocultar armadura se relee');
  assert.ok(await page.isChecked('#unfairChk'), 'el flag de Battle Mode se relee');
  await page.click('#dollClose');
  console.log('  ✓ el ciclo importar/exportar conserva OFFSET y flags');

  /* 13. compatibilidad: formato 4.x con el grupo en línea dentro del outliner */
  const v4 = {
    meta: { format_version: '4.10', model_format: 'java_block', box_uv: true },
    name: 'Viejo 4.x',
    resolution: { width: 64, height: 64 },
    elements: [
      { uuid: 'c1', type: 'cube', name: 'cubo_a', from: [-4, 24, -4], to: [4, 32, 4], origin: [0, 24, 0], uv_offset: [0, 0], box_uv: true },
      { uuid: 'c2', type: 'cube', name: 'cubo_b', from: [-4, 12, -2], to: [4, 24, 2], origin: [0, 24, 0], uv_offset: [16, 16], box_uv: true }
    ],
    outliner: [
      { uuid: 'g1', name: 'head', origin: [0, 24, 0], isOpen: true, children: ['c1'] },
      { uuid: 'g2', name: 'body', origin: [0, 24, 0], isOpen: true, children: ['c2'] }
    ],
    textures: [{ name: 'skin.png', id: '0', source: b64, uv_width: 64, uv_height: 64 }]
  };
  const v4Path = path.join(OUT, 'formato-4x.bbmodel');
  fs.writeFileSync(v4Path, JSON.stringify(v4));
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  await page.setInputFiles('#fileInput', v4Path);
  await page.waitForFunction(() => /Modelo:/.test(document.querySelector('.skin-card .pill.model-on')?.textContent || ''), null, { timeout: 15000 });
  const [dl4] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  const p4 = path.join(OUT, 'formato-4x.pck');
  await dl4.saveAs(p4);
  const b4 = fs.readFileSync(p4);
  const parsed4 = PCK.readPck(b4.buffer.slice(b4.byteOffset, b4.byteOffset + b4.byteLength));
  const boxes4 = parsed4.assets.find((a) => a.type === 0).params.filter((x) => x[0] === 'BOX').map((x) => x[1]);
  assert.deepStrictEqual(boxes4.map((b) => b.split(' ')[0]).sort(), ['BODY', 'HEAD'], '4.x en línea: ' + JSON.stringify(boxes4));
  console.log('  ✓ también lee el formato 4.x (grupo en línea en el outliner)');

  /* 14. .bbmodel con la textura como ruta externa (lo que guarda Blockbench si la cambias) */
  const externo = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  externo.textures = [{ name: 'isracrack.png', id: '0', uv_width: 64, uv_height: 64 }];
  const extPath = path.join(OUT, 'textura-externa.bbmodel');
  fs.writeFileSync(extPath, JSON.stringify(externo));
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  // soltando el modelo y la PNG a la vez: debe salir UNA skin con textura y modelo
  await page.setInputFiles('#fileInput', [extPath, skinPng]);
  await page.waitForFunction(() => /Modelo:/.test(document.querySelector('.skin-card .pill.model-on')?.textContent || ''), null, { timeout: 15000 });
  assert.strictEqual(await page.locator('.skin-card').count(), 1, 'la PNG del lote se usa como textura, sin duplicar la skin');
  const thumbExt = await page.getAttribute('.skin-card .skin-thumb img', 'src');
  assert.ok(thumbExt.startsWith('data:image/png'), 'la skin sale con la textura del PNG');
  console.log('  ✓ .bbmodel con textura externa + PNG en el mismo lote → una sola skin con modelo');

  /* 15. mover la armadura ARRASTRÁNDOLA en la vista 3D */
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  await page.setInputFiles('#fileInput', modelPath);
  await page.waitForFunction(() => /Modelo:/.test(document.querySelector('.skin-card')?.textContent || ''), null, { timeout: 15000 });
  await page.click('.skin-card .doll-btn');
  await page.waitForTimeout(800);
  const soloModelo = await page.evaluate(() => {
    const c = document.querySelector('#dollCanvas');
    return c._lce3d ? c._lce3d.piezas.length : -1;
  });
  assert.strictEqual(soloModelo, 0, 'por defecto la vista muestra SOLO el modelo (sin cajas de armadura)');
  await page.check('#showArmorChk');
  await page.waitForTimeout(500);
  const vista = await page.evaluate(() => {
    const c = document.querySelector('#dollCanvas');
    const st = c._lce3d;
    if (!st) return null;
    const r = c.getBoundingClientRect();
    const casco = st.piezas.find((p) => p.tipo === 'HELMET');
    return {
      piezas: st.piezas.length,
      tipos: st.piezas.map((p) => p.tipo),
      x: r.left + casco.centro.x * (r.width / c.width),
      y: r.top + casco.centro.y * (r.height / c.height)
    };
  });
  assert.ok(vista, 'la vista 3D expone las piezas de armadura');
  assert.strictEqual(vista.piezas, 9, 'nueve piezas dibujadas en 3D: ' + vista.tipos.join(','));
  await page.mouse.move(vista.x, vista.y);
  await page.mouse.down();
  await page.mouse.move(vista.x, vista.y - 27, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const cascoVal = Number(await page.inputValue('input[data-off="HELMET"]'));
  assert.ok(cascoVal < 0, 'arrastrar hacia arriba da OFFSET negativo (sube la armadura): ' + cascoVal);
  const selMarcada = await page.locator('.off.sel').count();
  assert.strictEqual(selMarcada, 1, 'la pieza arrastrada queda marcada en la lista');
  await page.locator('#dollOverlay .modal').screenshot({ path: path.join(OUT, 'shot-drag-armor.png') });
  await page.click('#dollClose');
  const [dlD] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  const pD = path.join(OUT, 'modelo-arrastre.pck');
  await dlD.saveAs(pD);
  const bD = fs.readFileSync(pD);
  const parsedD = PCK.readPck(bD.buffer.slice(bD.byteOffset, bD.byteOffset + bD.byteLength));
  const offsD = parsedD.assets.find((a) => a.type === 0).params.filter((x) => x[0] === 'OFFSET').map((x) => x[1]);
  assert.deepStrictEqual(offsD, ['HELMET Y ' + cascoVal], 'el arrastre acaba en el .pck: ' + JSON.stringify(offsD));
  console.log('  ✓ arrastrar la armadura en 3D escribe OFFSET (casco ' + cascoVal + ')');

  /* 16. la armadura también se puede mover en skins sin modelo */
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  await page.setInputFiles('#fileInput', skinPng);
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 1, null, { timeout: 15000 });
  await page.click('.skin-card .doll-btn');
  await page.waitForTimeout(800);
  await page.check('#showArmorChk');
  await page.waitForTimeout(500);
  const base3d = await page.evaluate(() => {
    const c = document.querySelector('#dollCanvas');
    const st = c._lce3d;
    const r = c.getBoundingClientRect();
    const peto = st.piezas.find((p) => p.tipo === 'CHEST');
    return { piezas: st.piezas.length, x: r.left + peto.centro.x * (r.width / c.width), y: r.top + peto.centro.y * (r.height / c.height) };
  });
  assert.strictEqual(base3d.piezas, 9, 'una skin sin modelo también enseña las 9 piezas');
  // elegir el peto en la lista (la cintura se solapa con él en la vista)
  await page.click('.off:has(input[data-off="CHEST"])');
  await page.waitForTimeout(250);
  assert.strictEqual(await page.locator('.off.sel').count(), 1, 'la fila elegida queda marcada');
  assert.ok(await page.isChecked('#showArmorChk'), 'al elegir una pieza se enciende la vista de armadura');
  await page.mouse.move(base3d.x, base3d.y);
  await page.mouse.down();
  await page.mouse.move(base3d.x, base3d.y + 20, { steps: 6 });   // bajar el peto
  await page.mouse.up();
  await page.waitForTimeout(200);
  const petoVal = Number(await page.inputValue('input[data-off="CHEST"]'));
  assert.ok(petoVal > 0, 'arrastrar hacia abajo sube el valor (baja la pieza): ' + petoVal);
  await page.click('#dollClose');
  console.log('  ✓ skins sin modelo: armadura movible en 3D (peto ' + petoVal + ')');

  /* 5b. la vista enseña la CARA del modelo, sin espejar la textura */
  const { encodePng } = require('./mkskins.js');
  const CARAS_PAL = {
    north: [200, 160, 120], east: [60, 160, 60], west: [150, 80, 190],
    south: [150, 150, 150], up: [0, 200, 200], down: [220, 0, 200],
    marca_roja: [255, 0, 0], marca_azul: [0, 0, 255]
  };
  const regiones = { north: [8, 8], east: [0, 8], west: [16, 8], south: [24, 8], up: [8, 0], down: [16, 0] };
  const marca = encodePng(64, 64, (x, y) => {
    if (x === 8 && y === 8) return [255, 0, 0, 255];          // esquina superior izquierda de la cara
    if (x === 15 && y === 15) return [0, 0, 255, 255];        // esquina inferior derecha
    for (const k of Object.keys(regiones)) {
      const [rx, ry] = regiones[k];
      if (x >= rx && x < rx + 8 && y >= ry && y < ry + 8) return [CARAS_PAL[k][0], CARAS_PAL[k][1], CARAS_PAL[k][2], 255];
    }
    return [0, 0, 0, 0];
  });
  const caraModelo = standardModel({ textureB64: 'data:image/png;base64,' + marca.toString('base64') });
  // cabeza de 8×8×8 para que el desplegado de la textura caiga en las regiones pintadas
  caraModelo.elements = [{ name: 'head', from: [-4, 24, -4], to: [4, 32, 4], origin: [0, 24, 0], uv_offset: [0, 0], box_uv: true }];
  const caraPath = path.join(OUT, 'caras-modelo.bbmodel');
  fs.writeFileSync(caraPath, JSON.stringify(caraModelo));
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  await page.setInputFiles('#fileInput', caraPath);
  await page.waitForFunction(() => /Modelo:/.test(document.querySelector('.skin-card')?.textContent || ''), null, { timeout: 15000 });
  await page.click('.skin-card .doll-btn');
  await page.waitForFunction(() => document.querySelector('#dollCanvas')._lce3d, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  if (await page.isChecked('#showArmorChk')) await page.uncheck('#showArmorChk');   // sin cajas de armadura encima
  await page.waitForTimeout(350);
  const caras = await page.evaluate((pal) => {
    const c = document.querySelector('#dollCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const out = {};
    const keys = Object.keys(pal);
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const o = (y * c.width + x) * 4;
        if (d[o + 3] < 250) continue;
        let mejor = null, dist = 1e9;
        keys.forEach((k) => {
          const p = pal[k];
          const dd = Math.abs(d[o] - p[0]) + Math.abs(d[o + 1] - p[1]) + Math.abs(d[o + 2] - p[2]);
          if (dd < dist) { dist = dd; mejor = k; }
        });
        if (dist > 70) continue;
        const r = out[mejor] || (out[mejor] = { n: 0, x0: 1e9, y0: 1e9, x1: -1, y1: -1, cx: 0, cy: 0 });
        r.n++;
        r.x0 = Math.min(r.x0, x); r.y0 = Math.min(r.y0, y);
        r.x1 = Math.max(r.x1, x); r.y1 = Math.max(r.y1, y);
        r.cx = (r.x0 + r.x1) / 2; r.cy = (r.y0 + r.y1) / 2;
      }
    }
    return out;
  }, CARAS_PAL);
  assert.ok(caras.north && caras.north.n > 200, 'se ve la cara frontal del modelo (north)');
  assert.ok(!caras.south || caras.south.n < 40, 'la vista no enseña la espalda');
  assert.ok(caras.east && caras.east.n > 40, 'se ve un costado (east)');
  assert.ok(caras.north.x1 - caras.north.x0 > 40 && caras.north.y1 - caras.north.y0 > 50, 'la cara frontal ocupa bien el lienzo');
  // el píxel rojo (arriba a la izquierda de la textura) queda arriba a la izquierda, y el azul abajo a la derecha
  assert.ok(caras.marca_roja, 'la marca roja de la textura se pinta');
  assert.ok(caras.marca_azul, 'la marca azul de la textura se pinta');
  assert.ok(caras.marca_roja.cx < caras.north.cx, 'la marca roja se ve a la IZQUIERDA (textura no espejada)');
  assert.ok(caras.marca_roja.cy < caras.north.cy, 'la marca roja se ve ARRIBA');
  assert.ok(caras.marca_azul.cx > caras.north.cx, 'la marca azul se ve a la DERECHA');
  assert.ok(caras.marca_azul.cy > caras.north.cy, 'la marca azul se ve ABAJO');
  await page.screenshot({ path: path.join(OUT, 'shot-caras.png'), clip: await page.evaluate(() => {
    const c = document.querySelector('#dollCanvas'); const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }) });
  await page.click('#dollClose');
  console.log('  ✓ la vista 3D enseña la cara del modelo con la textura sin espejar');

  /* 5c. PNG propia + .bbmodel en el mismo lote: manda la PNG (la skin que quieres ver) */
  const VERDE = [40, 190, 70];
  const verde = encodePng(64, 64, (x, y) => {
    if (x < 8 && y < 8) return [255, 255, 255, 255];      // un detalle para ver que no está espejada
    return [VERDE[0], VERDE[1], VERDE[2], 255];
  });
  const verdePath = path.join(OUT, 'verde.png');
  fs.writeFileSync(verdePath, verde);
  await page.click('#clearBtn');
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 0, null, { timeout: 5000 });
  // el .bbmodel lleva incrustada la textura de steve: aun así debe ganar verda.png
  await page.setInputFiles('#fileInput', [modelPath, verdePath]);
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length === 1, null, { timeout: 15000 });
  await page.waitForFunction(() => /Modelo:/.test(document.querySelector('.skin-card').textContent), null, { timeout: 15000 });
  assert.strictEqual(await page.locator('.skin-card').count(), 1, 'PNG + .bbmodel → UNA sola skin, no dos');
  assert.ok(/12 cajas/.test(await page.textContent('.skin-card .pill.model-on')), 'el modelo se aplica a la skin');
  const thumbVerde = await page.evaluate(() => {
    const img = document.querySelector('.skin-card .skin-thumb img');
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 1] > d[i] + 40 && d[i + 1] > d[i + 2] + 40) n++;
    return n;
  });
  assert.ok(thumbVerde > 3000, 'la miniatura es TU png (verde), no la textura del modelo: ' + thumbVerde);
  await page.click('.skin-card .doll-btn');
  await page.waitForFunction(() => document.querySelector('#dollCanvas')._lce3d, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const verdes3d = await page.evaluate(() => {
    const c = document.querySelector('#dollCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 200 && d[i + 1] > d[i] + 30 && d[i + 1] > d[i + 2] + 30) n++;
    }
    return n;
  });
  assert.ok(verdes3d > 3000, 'la vista 3D pinta la skin con TU png: ' + verdes3d);
  await page.screenshot({ path: path.join(OUT, 'shot-png-mas-modelo.png'), clip: await page.evaluate(() => {
    const c = document.querySelector('#dollCanvas'); const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }) });
  await page.click('#dollClose');
  console.log('  ✓ PNG + .bbmodel juntos → una skin con tu textura y la geometría del modelo');

  /* 6. el verificador independiente también lo acepta */
  const { execSync } = require('child_process');
  const out = execSync('python3 ' + path.join(__dirname, 'verify.py') + ' ' + p1).toString();
  assert.ok(/OK: estructura válida/.test(out), out);
  assert.ok(/BOX/.test(out), 'el verificador lista los BOX');
  console.log('  ✓ verificado con el parser independiente en Python');

  /* 7. geometría: editar cajas y bajar el .bbmodel */
  await page.click('.skin-card .doll-btn');
  await page.waitForFunction(() => document.querySelector('#dollCanvas')._lce3d, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const sumGeo = await page.textContent('#geoSummary');
  assert.ok(/12 cajas/.test(sumGeo), 'la geometría anuncia las cajas: ' + sumGeo);
  await page.click('#geoSummary');
  await page.waitForTimeout(200);
  assert.strictEqual(await page.locator('.geo-row').count(), 12, 'el modelo estándar tiene 12 cajas editables');

  const anchoNuevo = await page.evaluate(() => {
    const i = document.querySelector('.geo-row input[data-act="w"]');
    const w2 = String(Number(i.value) + 1);
    i.value = w2;
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return Number(w2);
  });
  await page.waitForTimeout(400);
  const metaGeo = await page.textContent('#dollMeta');
  assert.ok(/modelo 3D: 12 cajas/.test(metaGeo), 'el modal sabe que hay modelo propio: ' + metaGeo);

  const [descargaGeo] = await Promise.all([page.waitForEvent('download'), page.click('#geoDl')]);
  const rutaGeo = path.join(OUT, 'geometria.bbmodel');
  await descargaGeo.saveAs(rutaGeo);
  const modelo = JSON.parse(fs.readFileSync(rutaGeo, 'utf8'));
  assert.strictEqual(modelo.meta.format_version, '5.0', 'el .bbmodel es de Blockbench 5');
  assert.strictEqual(modelo.elements.length, 12, 'salen las 12 cajas');
  const cabeza = modelo.elements.find((e) => e.name === 'head');
  assert.strictEqual(cabeza.to[0] - cabeza.from[0], anchoNuevo, 'la cabeza va con el ancho que pusimos: ' + (cabeza.to[0] - cabeza.from[0]));
  assert.strictEqual(modelo.outliner.length, 6, 'el outliner lleva las 6 carpetas');

  await page.selectOption('#geoAddType', 'HEADWEAR');
  await page.click('#geoAddBtn');
  await page.waitForTimeout(400);
  assert.strictEqual(await page.locator('.geo-row').count(), 13, 'se puede añadir una caja');
  await page.locator('.geo-row').last().locator('.del').click();
  await page.waitForTimeout(300);
  assert.strictEqual(await page.locator('.geo-row').count(), 12, 'y borrarla');

  await page.locator('#dollCanvas').screenshot({ path: path.join(OUT, 'shot-geometria.png') });
  await page.click('#dollClose');
  await page.waitForTimeout(200);

  const [descargaPck2] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  const rutaPck2 = path.join(OUT, 'geo.pck');
  await descargaPck2.saveAs(rutaPck2);
  const buf2 = fs.readFileSync(rutaPck2);
  const leido = PCK.readPck(buf2.buffer.slice(buf2.byteOffset, buf2.byteOffset + buf2.byteLength));
  const todas = leido.assets.filter((a) => a.type === 0)
    .flatMap((a) => a.params.filter((p) => p[0] === 'BOX').map((p) => p[1]));
  const cabezaPck = todas.find((b) => b.startsWith('HEAD '));
  assert.strictEqual(Number(cabezaPck.split(' ')[4]), anchoNuevo, 'el .pck lleva el BOX con el ancho nuevo: ' + cabezaPck);
  console.log('  ✓ geometría editable en la app y .bbmodel descargable con los cambios');

  assert.deepStrictEqual(errors, [], 'errores de consola: ' + errors.join(' | '));
  console.log('\nE2E MODELO 3D OK');
  await browser.close();
})().catch((e) => { console.error('FALLO E2E 3D:', e); process.exit(1); });
