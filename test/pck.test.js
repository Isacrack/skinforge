/* Tests del núcleo PCK (node test/pck.test.js) */
const assert = require('assert');
const PCK = require('../src/pck.js');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

/* ---------- 1. Layout exacto de un .pck mínimo ---------- */
ok('layout de cabecera byte a byte (big endian, 1 asset)', () => {
  const bytes = PCK.writePck({
    pckType: 3,
    littleEndian: false,
    assets: [{ filename: 'a', type: 0, data: new Uint8Array([1, 2, 3]), params: [['K', 'v']] }]
  });
  const dv = new DataView(bytes.buffer);
  let o = 0;
  const i32 = () => { const v = dv.getInt32(o, false); o += 4; return v; };
  const str = () => {
    const len = dv.getInt32(o, false); o += 4;
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(o + i * 2, false));
    o += len * 2 + 4;
    return s;
  };
  assert.strictEqual(i32(), 3, 'pckType');
  assert.strictEqual(i32(), 1, 'lutCount');
  assert.strictEqual(i32(), 0, 'lut index');
  assert.strictEqual(str(), 'K');
  assert.strictEqual(i32(), 1, 'assetCount');
  assert.strictEqual(i32(), 3, 'asset size');
  assert.strictEqual(i32(), 0, 'asset type');
  assert.strictEqual(str(), 'a');
  assert.strictEqual(i32(), 1, 'paramCount');
  assert.strictEqual(i32(), 0, 'param key index');
  assert.strictEqual(str(), 'v');
  assert.deepStrictEqual(Array.from(new Uint8Array(bytes.buffer, o, 3)), [1, 2, 3]);
  assert.strictEqual(o + 3, bytes.length, 'no sobra nada');
});

/* ---------- 2. ida y vuelta ---------- */
const fakePng = (n) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37) & 0xff));

ok('round-trip big endian (PS3)', () => {
  const skins = [
    { id: 12345678, name: 'Steve Ñandú', theme: 'Clásico', png: fakePng(600), anim: PCK.ANIM.MODERN_WIDE_MODEL },
    { id: 87654321, name: 'Alex', png: fakePng(300), anim: PCK.ANIM.SLIM_MODEL, gameFlags: PCK.GAME_FLAGS.FEMALE_HUMAN }
  ];
  const built = PCK.buildSkinPack({ packName: 'Pack de prueba', packId: 123456, skins });
  const p = PCK.readPck(built.bytes);
  assert.strictEqual(p.pckType, 3);
  assert.strictEqual(p.littleEndian, false, 'debe detectarse como big endian');
  assert.strictEqual(p.xmlVersion, 0);
  assert.strictEqual(p.assets.length, 4, '0 + loc + 2 skins');

  const info = p.assets[0];
  assert.strictEqual(info.filename, '0');
  assert.strictEqual(info.type, 4);
  assert.strictEqual(info.get('PACKID'), '123456');
  assert.strictEqual(info.get('PACKVERSION'), '0');

  const loc = p.assets[1];
  assert.strictEqual(loc.filename, 'localisation.loc');
  assert.strictEqual(loc.type, 6);
  const parsedLoc = PCK.readLoc(loc.data);
  assert.strictEqual(parsedLoc.version, 2);
  assert.deepStrictEqual(parsedLoc.languages, ['en-EN']);
  assert.strictEqual(parsedLoc.keys['IDS_DISPLAY_NAME']['en-EN'], 'Pack de prueba');
  assert.strictEqual(parsedLoc.keys['IDS_dlcskin12345678_DISPLAYNAME']['en-EN'], 'Steve Ñandú');

  const s1 = p.assets[2];
  assert.strictEqual(s1.filename, 'dlcskin12345678.png');
  assert.strictEqual(s1.type, 0);
  assert.strictEqual(s1.get('DISPLAYNAME'), 'Steve Ñandú');
  assert.strictEqual(s1.get('DISPLAYNAMEID'), 'IDS_dlcskin12345678_DISPLAYNAME');
  assert.strictEqual(s1.get('THEMENAME'), 'Clásico');
  assert.strictEqual(s1.get('ANIM'), '0x00040000');
  assert.strictEqual(s1.get('GAME_FLAGS'), '0x18');
  assert.strictEqual(s1.get('FREE'), '1');
  assert.deepStrictEqual(Array.from(s1.data), Array.from(fakePng(600)), 'datos PNG intactos');

  const s2 = p.assets[3];
  assert.strictEqual(s2.get('ANIM'), '0x00080000');
  assert.strictEqual(s2.get('GAME_FLAGS'), '0x1a');
  assert.strictEqual(s2.get('THEMENAME'), null);

  // re-extracción
  const ext = PCK.extractSkins(p);
  assert.strictEqual(ext.skins.length, 2);
  assert.strictEqual(ext.skins[0].id, 12345678);
  assert.strictEqual(ext.skins[0].name, 'Steve Ñandú');
  assert.deepStrictEqual(Array.from(ext.skins[1].png), Array.from(fakePng(300)));
});

ok('round-trip little endian (PS4 / Vita / Switch)', () => {
  const built = PCK.buildSkinPack({
    packName: 'LE pack',
    packId: 9000,
    skins: [{ id: 11111111, name: 'X', png: fakePng(64) }],
    littleEndian: true
  });
  const p = PCK.readPck(built.bytes);
  assert.strictEqual(p.littleEndian, true);
  assert.strictEqual(p.assets[2].get('DISPLAYNAME'), 'X');
  assert.deepStrictEqual(Array.from(p.assets[2].data), Array.from(fakePng(64)));
});

ok('XMLVERSION se escribe tras la LUT y se relee', () => {
  const bytes = PCK.writePck({
    pckType: 3,
    xmlVersion: 3,
    littleEndian: false,
    assets: [{ filename: 'Skins.pck', type: 11, data: new Uint8Array([9]), params: [] }]
  });
  const p = PCK.readPck(bytes);
  assert.strictEqual(p.xmlVersion, 3);
  assert.ok(p.lut.indexOf('XMLVERSION') !== -1);
  assert.strictEqual(p.assets[0].filename, 'Skins.pck');
  assert.strictEqual(p.assets[0].type, 11);
});

ok('UTF-16 con acentos y emoji sobrevive al round-trip', () => {
  const name = 'Pikachú 🐉 Niño';
  const built = PCK.buildSkinPack({ packName: name, skins: [{ name, png: fakePng(10) }] });
  const p = PCK.readPck(built.bytes);
  assert.strictEqual(p.assets[2].get('DISPLAYNAME'), name);
  assert.strictEqual(PCK.readLoc(p.assets[1].data).keys['IDS_DISPLAY_NAME']['en-EN'], name);
});

ok('los IDs se autogeneran únicos y de 8 dígitos', () => {
  const built = PCK.buildSkinPack({
    packName: 'x',
    skins: [{ name: 'a', png: fakePng(4) }, { name: 'b', png: fakePng(4) }, { name: 'c', png: fakePng(4) }]
  });
  const p = PCK.readPck(built.bytes);
  const names = p.assets.filter(a => a.type === 0).map(a => a.filename);
  assert.strictEqual(new Set(names).size, 3);
  names.forEach(n => assert.match(n, /^dlcskin\d{8}\.png$/));
});

ok('el pack con 0 skins sigue siendo válido', () => {
  const built = PCK.buildSkinPack({ packName: 'vacío', skins: [] });
  const p = PCK.readPck(built.bytes);
  assert.strictEqual(p.assets.length, 2);
});

ok('un fichero basura lanza error controlado', () => {
  assert.throws(() => PCK.readPck(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer));
});

console.log('\n' + passed + ' tests OK');
