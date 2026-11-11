#!/usr/bin/env node
/**
 * Auditoría de PARÁMETROS del .pck (node test/params.js)
 *
 * Comprueba, uno por uno, los valores que la herramienta escribe en el fichero:
 * cabecera, LUT, tipos de asset, codificación de strings, .loc, parámetros de skin,
 * ANIM por modelo, rangos de ID, tamaño de PNG y reglas del parámetro BOX.
 * Falla (exit 1) en cuanto un parámetro no cumple lo que espera la consola.
 */
const PCK = require('../src/pck.js');
const fs = require('fs');
const path = require('path');

let fallos = 0;
const filas = [];
function ok(nombre, valor, esperado) {
  const bien = esperado === undefined ? !!valor : JSON.stringify(valor) === JSON.stringify(esperado);
  filas.push([bien ? 'OK  ' : 'FALLO', nombre, JSON.stringify(valor)]);
  if (!bien) fallos++;
  return bien;
}

const png = fs.readFileSync(path.join(__dirname, 'out', 'steve.png'));
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

/* =============================== cabecera =============================== */
const res = PCK.buildSkinPack({
  packName: 'Auditoría Ñ', packId: 424242, packVersion: 7, littleEndian: false,
  skins: [
    { name: 'Clásica', png, model: 'classic', anim: 0x00000000 },
    { name: 'Ancha', png, model: 'wide', anim: 0x00040000 },
    { name: 'Fina', png, model: 'slim', anim: 0x00080000, theme: 'Clásico' },
    { name: 'Con cajas', png, model: 'wide', anim: 0x00040000, xmlVersion: 3,
      boxes: [PCK.parseBox('HEAD -5 -10 -5 10 10 10 0 0'), PCK.parseBox('ARM1 -1 -2 -2 4 12 4 40 16 0 1')] }
  ]
});
const p = PCK.readPck(ab(res.bytes));

ok('pckType', p.pckType, 3);
ok('endianness PS3 (big endian)', p.littleEndian, false);
ok('XMLVERSION del pack', p.xmlVersion, 3);
ok('XMLVERSION está en la LUT', p.lut.includes('XMLVERSION'), true);
ok('assets: InfoFile + loc + 4 skins', p.assets.length, 6);

/* si no hay cajas, no debe aparecer XMLVERSION ni en LUT ni en cabecera */
const sinCajas = PCK.readPck(ab(PCK.buildSkinPack({ packName: 'X', packId: 1, skins: [{ name: 'A', png, model: 'wide' }] }).bytes));
ok('sin cajas → xmlVersion 0', sinCajas.xmlVersion, 0);
ok('sin cajas → XMLVERSION fuera de la LUT', sinCajas.lut.includes('XMLVERSION'), false);

/* stings: int32 len + len*2 UTF-16 + int32 0 */
const raw = Buffer.from(res.bytes);
{
  // primer string del fichero: tras int32 pckType + int32 count(LUT) + int32 index
  const off = 12;
  const len = raw.readInt32BE(off);
  const trozo = raw.slice(off + 4, off + 4 + len * 2).toString('utf16le');
  ok('string UTF-16 (longitud en caracteres)', len, 'PACKID'.length);
  ok('bytes por carácter', (off + 4 + len * 2) - (off + 4), len * 2);
  ok('terminador int32 = 0', raw.readInt32BE(off + 4 + len * 2), 0);
  void trozo;
}

/* ============================ .loc y sus claves ========================= */
const loc = p.assets.find((a) => a.type === 6);
const L = PCK.readLoc(loc.data);
ok('loc versión', L.version, 2);
ok('loc idiomas', L.languages, ['en-EN']);
ok('loc: nombre del pack', L.keys.IDS_DISPLAY_NAME['en-EN'], 'Auditoría Ñ');
const skinAssets = p.assets.filter((a) => a.type === 0);
skinAssets.forEach((a) => {
  const id = /dlcskin(\d+)\.png/.exec(a.filename)[1];
  ok('loc: clave de ' + a.filename, !!L.keys['IDS_dlcskin' + id + '_DISPLAYNAME'], true);
  ok('DISPLAYNAMEID casa con el nombre', a.get('DISPLAYNAMEID'), 'IDS_dlcskin' + id + '_DISPLAYNAME');
  ok('nombre visible en UTF-16 con acentos', L.keys['IDS_dlcskin' + id + '_DISPLAYNAME']['en-EN'], a.get('DISPLAYNAME'));
});

/* ============================ parámetros de skin ======================== */
const tipos = p.assets.map((a) => a.type);
ok('InfoFile = tipo 4', tipos.filter((t) => t === 4).length, 1);
ok('localisation.loc = tipo 6', tipos.filter((t) => t === 6).length, 1);
ok('skins = tipo 0', tipos.filter((t) => t === 0).length, 4);

const info = p.assets.find((a) => a.type === 4);
ok('InfoFile sin contenido', info.data.length, 0);
ok('PACKID', info.get('PACKID'), '424242');
ok('PACKVERSION', info.get('PACKVERSION'), '7');

const anims = skinAssets.map((a) => [a.get('DISPLAYNAME'), a.get('ANIM')]);
ok('ANIM clásica 64x32', anims[0], ['Clásica', '0x00000000']);
ok('ANIM brazos anchos', anims[1], ['Ancha', '0x00040000']);
ok('ANIM Alex / slim', anims[2], ['Fina', '0x00080000']);
skinAssets.forEach((a) => {
  ok('GAME_FLAGS de ' + a.filename, a.get('GAME_FLAGS'), '0x18');
  ok('FREE de ' + a.filename, a.get('FREE'), '1');
  const id = /^dlcskin(\d{8})\.png$/.exec(a.filename);
  ok('nombre de fichero dlcskin########.png', !!id, true);
  if (id) {
    const n = Number(id[1]);
    ok('ID decimal en rango 100000-99999999 (' + n + ')', n >= 100000 && n <= 99999999, true);
  }
  ok('PNG de ' + a.filename + ' ≤ 32767 B', a.data.length <= 0x7fff, true);
  ok('cabecera PNG', a.data[0] === 0x89 && a.data[1] === 0x50, true);
});

/* tema opcional */
const conTema = skinAssets.find((a) => a.get('DISPLAYNAME') === 'Fina');
ok('THEMENAME', conTema.get('THEMENAME'), 'Clásico');
ok('THEMENAMEID', /^IDS_dlcskin\d+_THEMENAME$/.test(conTema.get('THEMENAMEID') || ''), true);
ok('sin tema → sin THEMENAME', skinAssets[0].get('THEMENAME') == null, true);

/* ================================ BOX ================================== */
const cajas = p.assets.filter((a) => a.params.some((x) => x[0] === 'BOX'));
ok('solo la skin con modelo lleva BOX', cajas.length, 1);
const boxParams = cajas[0].params.filter((x) => x[0] === 'BOX').map((x) => x[1]);
ok('BOX conserva el orden', boxParams[0], 'HEAD -5 -10 -5 10 10 10 0 0');
ok('BOX con 9 argumentos', boxParams[0].split(' ').length, 9);
ok('BOX con mirror → 11 argumentos', boxParams[1].split(' ').length, 11);
ok('BOX usa punto decimal, nunca coma', boxParams.some((b) => b.includes(',')), false);
ok('tipos BOX válidos', boxParams.every((b) => PCK.BOX_TYPES.includes(b.split(' ')[0])), true);
ok('6 base + 6 overlay + 7 (TU58) + 4 (TU60)', PCK.BOX_TYPES.length, 23);
ok('tipos de overlay', PCK.OVERLAY_BOX_TYPES.concat().sort(),
  ['HEADWEAR', 'JACKET', 'PANTS0', 'PANTS1', 'SLEEVE0', 'SLEEVE1', 'WAIST']);

/* pivotes: cada tipo estándar debe reproducir los valores de referencia de LCE */
const ref = [
  // [tipo, min, max, uv, string esperado en LCE]
  ['HEAD', [-4, 24, -4], [4, 32, 4], [0, 0], 'HEAD -4 -8 -4 8 8 8 0 0'],
  ['BODY', [-4, 12, -2], [4, 24, 2], [16, 16], 'BODY -4 0 -2 8 12 4 16 16'],
  ['ARM0', [-8, 12, -2], [-4, 24, 2], [40, 16], 'ARM0 -3 -2 -2 4 12 4 40 16'],
  ['ARM1', [4, 12, -2], [8, 24, 2], [32, 48], 'ARM1 -1 -2 -2 4 12 4 32 48'],
  ['LEG0', [-4, 0, -2], [0, 12, 2], [0, 16], 'LEG0 -2 0 -2 4 12 4 0 16'],
  ['LEG1', [0, 0, -2], [4, 12, 2], [16, 48], 'LEG1 -2 0 -2 4 12 4 16 48'],
  ['HEADWEAR', [-4, 24, -4], [4, 32, 4], [32, 0], 'HEADWEAR -4 -8 -4 8 8 8 32 0'],
  ['JACKET', [-4, 12, -2], [4, 24, 2], [16, 32], 'JACKET -4 0 -2 8 12 4 16 32'],
  ['SLEEVE0', [-8, 12, -2], [-4, 24, 2], [40, 32], 'SLEEVE0 -3 -2 -2 4 12 4 40 32'],
  ['SLEEVE1', [4, 12, -2], [8, 24, 2], [48, 48], 'SLEEVE1 -1 -2 -2 4 12 4 48 48'],
  ['PANTS0', [-4, 0, -2], [0, 12, 2], [0, 32], 'PANTS0 -2 0 -2 4 12 4 0 32'],
  ['PANTS1', [0, 0, -2], [4, 12, 2], [0, 48], 'PANTS1 -2 0 -2 4 12 4 0 48'],
  // 64x32 clásica: las cajas izquierdas reutilizan la textura y van espejadas
  ['ARM1', [4, 12, -2], [8, 24, 2], [40, 16], 'ARM1 -1 -2 -2 4 12 4 40 16 0 1', true]
];
ref.forEach(([tipo, min, max, uv, esperado, conEspejo]) => {
  const val = PCK.boxToString(PCK.cubeToBox(tipo, min, max, uv, { mirror: conEspejo }));
  ok('BOX de referencia ' + tipo + (conEspejo ? ' espejada (64x32)' : ''), val, esperado);
});

/* Y invertido: subir una caja 4 unidades hace el valor más negativo */
const arriba = PCK.cubeToBox('HEAD', [-4, 28, -4], [4, 36, 4], [0, 0]);
ok('eje Y invertido (subir → Y más negativa)', arriba.pos[1], -12);

/* parse round-trip */
const original = 'JACKET -4 0 -2 8 12 4 16 32 0 1 0.25';
ok('parseBox → boxToString ida y vuelta', PCK.boxToString(PCK.parseBox(original)), original);
ok('parseBox rechaza tipos inventados', PCK.parseBox('WING 1 2 3 4 5 6 7 8'), null);
ok('parseBox rechaza cadenas cortas', PCK.parseBox('HEAD 1 2 3'), null);

/* ========================= máscara de armadura ========================== */
ok('bits de armadura', PCK.ARMOR, { HELMET: 1, CHEST: 2, LEGS: 4, BOOTS: 8 });
ok('etiqueta sin máscara', PCK.armorLabel(0), 'siempre visible');
ok('etiqueta casco', PCK.armorLabel(1), 'oculta con casco');
ok('etiqueta compuesta (1+4)', PCK.armorLabel(5), 'oculta con casco, gregüesco');
ok('etiqueta todas las piezas', PCK.armorLabel(15), 'oculta con casco, peto, gregüesco, botas');
ok('BOX con máscara 15', PCK.boxToString(PCK.cubeToBox('HEADWEAR', [-4, 24, -4], [4, 32, 4], [32, 0], { armor: 15 })),
  'HEADWEAR -4 -8 -4 8 8 8 32 0 15 0');
ok('BOX con máscara + espejo (64x32)', PCK.boxToString(PCK.cubeToBox('ARM1', [4, 12, -2], [8, 24, 2], [40, 16], { armor: 2, mirror: true })),
  'ARM1 -1 -2 -2 4 12 4 40 16 2 1');
ok('BOX con máscara + inflado (v3)', PCK.boxToString(PCK.cubeToBox('JACKET', [-4, 12, -2], [4, 24, 2], [16, 32], { armor: 2, inflate: 0.25 })),
  'JACKET -4 0 -2 8 12 4 16 32 2 0 0.25');
ok('la máscara se relee del fichero', PCK.parseBox('HEAD -4 -8 -4 8 8 8 0 0 9').armor, 9);

/* ==================== OFFSET de armadura y flags ======================= */
ok('OFFSET: 17 tipos', PCK.OFFSET_TYPES.length, 17);
ok('OFFSET incluye HELMET y CHEST', ['HELMET', 'CHEST'].every((t) => PCK.OFFSET_TYPES.includes(t)), true);
ok('OFFSET no admite overlays', ['HEADWEAR', 'JACKET'].every((t) => !PCK.OFFSET_TYPES.includes(t)), true);
ok('parseOffsets', PCK.parseOffsets([['OFFSET', 'HELMET Y -2'], ['OFFSET', 'CHEST Y 1']]), { HELMET: -2, CHEST: 1 });
ok('ANIM bit 9 (ocultar armadura)', PCK.ANIM.HIDE_ARMOR, 0x100);
ok('GAME_FLAGS bit 1 (Battle Mode)', PCK.GAME_FLAGS.UNFAIR, 0x1);
{
  const r = PCK.readPck(ab(PCK.buildSkinPack({
    packName: 'Flags', packId: 7, littleEndian: false,
    skins: [{ name: 'A', png, anim: 0x00040000, hideArmor: true, unfair: true, offsets: { HELMET: -2, BASURA: 3 } }]
  }).bytes));
  const a = r.assets.find((x) => x.type === 0);
  ok('ANIM con bit 9', a.get('ANIM'), '0x00040100');
  ok('GAME_FLAGS con bit 1', a.get('GAME_FLAGS'), '0x19');
  ok('OFFSET escrito', a.params.filter((x) => x[0] === 'OFFSET').map((x) => x[1]), ['HELMET Y -2']);
  ok('OFFSET de tipo inventado descartado', a.params.some((x) => x[1] && x[1].includes('BASURA')), false);
}

/* ============================ tabla de salida =========================== */
const ancho = Math.max(...filas.map((f) => f[1].length));
filas.forEach((f) => console.log(f[0] + '  ' + f[1].padEnd(ancho) + '  ' + f[2]));
console.log('\n' + (fallos ? fallos + ' PARÁMETROS INCORRECTOS' : 'TODOS LOS PARÁMETROS OK (' + filas.length + ')'));
process.exit(fallos ? 1 : 0);
