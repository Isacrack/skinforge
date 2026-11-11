/* =========================================================================
   pck.js — Lector/escritor del formato .PCK de Minecraft Legacy Console
   Edition (PS3 / Xbox 360 / Wii U / PS4 / Vita / Switch).

   Reimplementación en JavaScript del formato documentado por:
     - OMI-Filetype-Library (PckFileReader / PckFileWriter / LOCFileWriter)
     - PCK Studio (LCERD/PCK-Studio)  — SkinExtensions, MainForm.InitializePack
   Ambas GPL-3.0. Esta es una implementación independiente del mismo formato.

   Estructura de un .pck (tipo 3, el que usan los skin packs):
     int32   pckType                     (3)
     int32   lutCount                    (nº de claves de la tabla de parámetros)
     [ int32 index, string key ] * n
     int32   xmlVersion                  (sólo si la LUT contiene "XMLVERSION")
     int32   assetCount
     [ int32 size, int32 type, string filename ] * assetCount
     [ int32 paramCount, [ int32 keyIndex, string value ] * n, bytes data ] * assetCount

   string = int32 longitudEnChars + longitudEnChars*2 bytes (UTF-16, en el
            endianness del pack) + int32 padding (0)
   ========================================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PCK = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ASSET_TYPE = {
    SkinFile: 0,
    CapeFile: 1,
    TextureFile: 2,
    UIDataFile: 3,
    InfoFile: 4,
    TexturePackInfoFile: 5,
    LocalisationFile: 6,
    GameRulesFile: 7,
    AudioFile: 8,
    ColourTableFile: 9,
    GameRulesHeader: 10,
    SkinDataFile: 11,
    ModelsFile: 12,
    BehavioursFile: 13,
    MaterialFile: 14
  };
  var ASSET_TYPE_NAME = {};
  Object.keys(ASSET_TYPE).forEach(function (k) { ASSET_TYPE_NAME[ASSET_TYPE[k]] = k; });

  var XML_VERSION_STRING = 'XMLVERSION';

  /* ----------------------------- utilidades ----------------------------- */

  function pad8(n) { return String(n).padStart(8, '0'); }

  function hex(value, digits) {
    return (value >>> 0).toString(16).padStart(digits, '0');
  }

  function toU8(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array(0);
  }

  /* ------------------------------ escritor ------------------------------ */

  function Writer(littleEndian) {
    this.le = !!littleEndian;
    this.chunks = [];
    this.length = 0;
  }
  Writer.prototype.push = function (u8) {
    this.chunks.push(u8);
    this.length += u8.length;
    return this;
  };
  Writer.prototype.i32 = function (v) {
    var b = new ArrayBuffer(4);
    new DataView(b).setInt32(0, v | 0, this.le);
    return this.push(new Uint8Array(b));
  };
  Writer.prototype.i16 = function (v) {
    var b = new ArrayBuffer(2);
    new DataView(b).setUint16(0, v & 0xffff, false); // las longitudes de .loc son siempre big-endian
    return this.push(new Uint8Array(b));
  };
  Writer.prototype.u8 = function (v) { return this.push(new Uint8Array([v & 0xff])); };
  Writer.prototype.raw = function (u8) { return this.push(u8); };
  /* string del .pck: longitud en chars + UTF-16 + padding */
  Writer.prototype.string = function (str) {
    str = String(str == null ? '' : str);
    var buf = new Uint8Array(4 + str.length * 2 + 4);
    var dv = new DataView(buf.buffer);
    dv.setInt32(0, str.length, this.le);
    for (var i = 0; i < str.length; i++) dv.setUint16(4 + i * 2, str.charCodeAt(i), this.le);
    dv.setInt32(4 + str.length * 2, 0, this.le);
    return this.push(buf);
  };
  /* string UTF-8 de 16 bits de longitud (formato .loc, siempre big-endian) */
  Writer.prototype.utf8 = function (str) {
    var bytes = utf8Encode(String(str == null ? '' : str));
    var b = new ArrayBuffer(2);
    new DataView(b).setUint16(0, bytes.length, false);
    return this.push(new Uint8Array(b)).push(bytes);
  };
  Writer.prototype.bytes = function () {
    var out = new Uint8Array(this.length);
    var off = 0;
    for (var i = 0; i < this.chunks.length; i++) {
      out.set(this.chunks[i], off);
      off += this.chunks[i].length;
    }
    return out;
  };

  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    // Fallback mínimo
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /* ------------------------------ lector -------------------------------- */

  function Reader(buffer, littleEndian) {
    this.buf = buffer;
    this.view = new DataView(buffer);
    this.offset = 0;
    this.le = !!littleEndian;
  }
  Reader.prototype.canRead = function (n) { return this.offset + n <= this.buf.byteLength; };
  Reader.prototype.i32 = function () {
    if (!this.canRead(4)) throw new Error('Fin de fichero inesperado (i32 @' + this.offset + ')');
    var v = this.view.getInt32(this.offset, this.le);
    this.offset += 4;
    return v;
  };
  Reader.prototype.raw = function (n) {
    if (!this.canRead(n)) throw new Error('Fin de fichero inesperado (data @' + this.offset + ')');
    var out = new Uint8Array(this.buf, this.offset, n);
    this.offset += n;
    return out;
  };
  Reader.prototype.string = function () {
    var len = this.i32();
    if (len < 0 || len > 0x100000) throw new Error('Longitud de cadena inválida: ' + len);
    var bytes = this.raw(len * 2);
    this.i32(); // padding
    var s = '';
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (var i = 0; i < len; i++) {
      var c = dv.getUint16(i * 2, this.le);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  /* --------------------------- .pck : escritura -------------------------- */

  /**
   * Escribe un .pck.
   * @param {object} o
   * @param {number} o.pckType        tipo de pack (3 = skin pack / DLC)
   * @param {number} [o.xmlVersion]   BOX version (0 = formato clásico)
   * @param {boolean} [o.littleEndian] false = PS3 / Xbox 360 / Wii U
   * @param {Array} o.assets          [{filename, type, data, params:[[k,v],...]}]
   */
  function writePck(o) {
    var assets = (o.assets || []).filter(function (a) { return !a.skip; });
    var le = !!o.littleEndian;
    var pckType = o.pckType == null ? 3 : o.pckType;
    var xmlVersion = o.xmlVersion | 0;

    // Tabla de parámetros (LUT): claves únicas, en orden de aparición.
    var lut = [];
    assets.forEach(function (asset) {
      (asset.params || []).forEach(function (p) {
        if (lut.indexOf(p[0]) === -1) lut.push(p[0]);
      });
    });
    var hasXml = xmlVersion > 0;
    if (hasXml && lut.indexOf(XML_VERSION_STRING) === -1) lut.push(XML_VERSION_STRING);

    var w = new Writer(le);
    w.i32(pckType);
    w.i32(lut.length);
    lut.forEach(function (key, i) {
      w.i32(i);
      w.string(key);
    });
    if (hasXml) w.i32(xmlVersion);

    var used = assets;
    w.i32(used.length);
    used.forEach(function (a) {
      var data = toU8(a.data);
      w.i32(data.length);
      w.i32(a.type);
      w.string(a.filename);
    });
    used.forEach(function (a) {
      var params = a.params || [];
      w.i32(params.length);
      params.forEach(function (p) {
        var idx = lut.indexOf(p[0]);
        if (idx === -1) throw new Error('Parámetro fuera de la LUT: ' + p[0]);
        w.i32(idx);
        w.string(p[1]);
      });
      w.raw(toU8(a.data));
    });
    return w.bytes();
  }

  /* --------------------------- .pck : lectura --------------------------- */

  function readPckWith(buffer, le) {
    var r = new Reader(buffer, le);
    var pckType = r.i32();
    if (pckType < 3 || pckType > 0x00ffffff) throw new Error('pckType inválido: ' + pckType);

    var lutCount = r.i32();
    if (lutCount % 1 !== 0 || lutCount < 0 || lutCount > 100000) throw new Error('LUT inválida');
    var lut = new Array(lutCount);
    for (var i = 0; i < lutCount; i++) {
      var idx = r.i32();
      var key = r.string();
      if (idx < 0 || idx >= lutCount) throw new Error('índice LUT inválido');
      lut[idx] = key;
    }
    var xmlVersion = 0;
    if (lut.indexOf(XML_VERSION_STRING) !== -1) xmlVersion = r.i32();

    var assetCount = r.i32();
    if (assetCount < 0 || assetCount > 200000) throw new Error('assetCount inválido: ' + assetCount);
    var entries = [];
    for (var a = 0; a < assetCount; a++) {
      entries.push({ size: r.i32(), type: r.i32(), filename: r.string().replace(/\\/g, '/') });
    }

    var assets = [];
    for (var b = 0; b < entries.length; b++) {
      var e = entries[b];
      var paramCount = r.i32();
      if (paramCount < 0 || paramCount > 100000) throw new Error('paramCount inválido');
      var params = [];
      for (var p = 0; p < paramCount; p++) {
        var ki = r.i32();
        var value = r.string();
        params.push([lut[ki] != null ? lut[ki] : 'UNKNOWN_' + ki, value]);
      }
      if (e.size < 0) throw new Error('tamaño de asset inválido');
      var data = r.raw(e.size);
      assets.push({
        filename: e.filename,
        type: e.type,
        typeName: ASSET_TYPE_NAME[e.type] || ('Type' + e.type),
        data: new Uint8Array(data), // copia (buf.slice)
        params: params,
        get: function (k) {
          for (var i2 = 0; i2 < this.params.length; i2++) if (this.params[i2][0] === k) return this.params[i2][1];
          return null;
        }
      });
    }
    if (r.offset !== buffer.byteLength) {
      // sobrante: no es fatal, algunos packs llevan relleno
    }
    return {
      pckType: pckType,
      xmlVersion: xmlVersion,
      littleEndian: !!le,
      assets: assets,
      lut: lut,
      platform: le ? 'PS4 / PS Vita / Switch' : 'PS3 / Xbox 360 / Wii U'
    };
  }

  /**
   * Lee un .pck detectando el endianness automáticamente.
   */
  function readPck(input) {
    var buffer = input instanceof ArrayBuffer
      ? input
      : (input.buffer ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) : input);
    try {
      return readPckWith(buffer, false);
    } catch (errBE) {
      try {
        return readPckWith(buffer, true);
      } catch (errLE) {
        throw new Error('No es un .pck válido (' + errBE.message + ' / ' + errLE.message + ')');
      }
    }
  }

  /* ---------------------------- .loc (idiomas) --------------------------- */

  /**
   * Escribe un archivo de localización (localisation.loc / languages.loc).
   * version 2 = formato moderno (sin UIDs).
   * @param {object} o {languages:['en-EN'], keys:{KEY:{'en-EN':'valor'}}, version}
   */
  function writeLoc(o) {
    var version = o.version == null ? 2 : o.version;
    var languages = o.languages || ['en-EN'];
    var keys = o.keys || {};
    var keyNames = Object.keys(keys);
    var hasUids = false;

    var w = new Writer(false); // .loc siempre big-endian
    w.i32(version);
    w.i32(languages.length);
    if (version === 2) {
      w.u8(hasUids ? 1 : 0);
      w.i32(keyNames.length);
      keyNames.forEach(function (k) { w.utf8(k); });
    }
    languages.forEach(function (lang) {
      var langBytes = utf8Encode(lang);
      var size = 4 + (version > 0 ? 1 : 0) + (2 + langBytes.length) + 4;
      keyNames.forEach(function (k) {
        if (version === 0) size += 2 + utf8Encode(k).length;
        size += 2 + utf8Encode((keys[k] || {})[lang] || '').length;
      });
      w.utf8(lang);
      w.i32(size);
    });
    languages.forEach(function (lang) {
      w.i32(version);
      if (version > 0) w.u8(hasUids ? 1 : 0);
      w.utf8(lang);
      w.i32(keyNames.length);
      keyNames.forEach(function (k) {
        if (version === 0) w.utf8(k);
        w.utf8((keys[k] || {})[lang] || '');
      });
    });
    return w.bytes();
  }

  function readLoc(input) {
    var buffer = input instanceof ArrayBuffer
      ? input
      : (input.buffer ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) : input);
    var dv = new DataView(buffer);
    var off = 0;
    function i32() { var v = dv.getInt32(off, false); off += 4; return v; }
    function u8() { return dv.getUint8(off++); }
    function str() {
      var len = dv.getUint16(off, false); off += 2;
      var bytes = new Uint8Array(buffer, off, len); off += len;
      return utf8Decode(bytes);
    }
    var version = i32();
    var langCount = i32();
    var hasUids = false;
    var keyNames = [];
    if (version === 2) {
      hasUids = u8() !== 0;
      var keyCount = i32();
      for (var i = 0; i < keyCount; i++) {
        if (hasUids) { off += 4; keyNames.push('UID_' + i); }
        else keyNames.push(str());
      }
    }
    var langs = [];
    for (var l = 0; l < langCount; l++) {
      langs.push(str());
      off += 4; // tamaño de la entrada
    }
    if (version === 0 ||
      (langs.length === 0)) {
      // formatos antiguos: no soportados más allá de la cabecera
      return { version: version, languages: langs, keys: {}, unsupported: true };
    }
    var keys = {};
    for (var li = 0; li < langs.length; li++) {
      var lang = langs[li];
      var v = i32();
      if (v > 0) off += 1; // hasUids
      off += 2 + dv.getUint16(off, false); // nombre de idioma repetido
      var n = i32();
      for (var k = 0; k < n; k++) {
        var name = version === 0 ? str() : keyNames[k];
        var value = str();
        if (!name) continue;
        if (!keys[name]) keys[name] = {};
        keys[name][lang] = value;
      }
    }
    return { version: version, languages: langs, keys: keys, unsupported: false };
  }


  /* ------------------- geometría de skin (parámetros BOX) ------------------ */

  /**
   * Pivotes del modelo de jugador estándar (Java / Blockbench, y = 0 en los pies).
   * Los parámetros BOX de LCE guardan la esquina mínima de la caja relativa a
   * estos pivotes, con el eje Y invertido.
   */
  var BOX_PIVOT = {
    HEAD: [0, 24, 0],
    HEADWEAR: [0, 24, 0],
    BODY: [0, 24, 0],
    JACKET: [0, 24, 0],
    WAIST: [0, 24, 0],
    BODYARMOR: [0, 24, 0],
    BELT: [0, 24, 0],
    ARM0: [-5, 22, 0],
    ARM1: [5, 22, 0],
    SLEEVE0: [-5, 22, 0],
    SLEEVE1: [5, 22, 0],
    ARMARMOR0: [-5, 22, 0],
    ARMARMOR1: [5, 22, 0],
    LEG0: [-2, 12, 0],
    LEG1: [2, 12, 0],
    PANTS0: [-2, 12, 0],
    PANTS1: [2, 12, 0],
    LEGGING0: [-2, 12, 0],
    LEGGING1: [2, 12, 0],
    SOCK0: [-2, 12, 0],
    SOCK1: [2, 12, 0],
    BOOT0: [-2, 12, 0],
    BOOT1: [2, 12, 0]
  };

  /** Tipos válidos (TU7 + TU34 + TU58 + TU60) */
  var BOX_TYPES = Object.keys(BOX_PIVOT);
  /** bits de la máscara de armadura (TU31+): la caja se oculta al llevar esa pieza */
  var ARMOR = { HELMET: 1, CHEST: 2, LEGS: 4, BOOTS: 8 };

  function armorLabel(mask) {
    if (!mask) return 'siempre visible';
    var out = [];
    if (mask & ARMOR.HELMET) out.push('casco');
    if (mask & ARMOR.CHEST) out.push('peto');
    if (mask & ARMOR.LEGS) out.push('gregüesco');
    if (mask & ARMOR.BOOTS) out.push('botas');
    return 'oculta con ' + out.join(', ');
  }

  var OVERLAY_BOX_TYPES = ['HEADWEAR', 'JACKET', 'SLEEVE0', 'SLEEVE1', 'PANTS0', 'PANTS1', 'WAIST'];

  /**
   * Convierte una caja del modelo (esquina mínima y máxima en coordenadas de
   * Blockbench, y hacia arriba) al string BOX de LCE.
   *   BOX: "TIPO X Y Z ANCHO ALTO FONDO U V [mascaraArmadura] [espejo] [inflado]"
   */
  function boxToString(box) {
    var parts = [
      box.type,
      fmt(box.pos[0]), fmt(box.pos[1]), fmt(box.pos[2]),
      fmt(box.size[0]), fmt(box.size[1]), fmt(box.size[2]),
      fmt(box.uv[0]), fmt(box.uv[1])
    ];
    if (box.armor || box.mirror || box.inflate) {
      parts.push(String(box.armor || 0), box.mirror ? '1' : '0');
      if (box.inflate) parts.push(fmt(box.inflate));
    }
    return parts.join(' ');
  }

  /** string BOX -> objeto {type,pos,size,uv,armor,mirror,inflate} (o null) */
  function parseBox(str) {
    var parts = String(str).trim().split(/\s+/);
    if (parts.length < 9) return null;
    var type = parts[0].toUpperCase();
    if (!BOX_PIVOT[type]) return null;
    var n = parts.slice(1).map(Number);
    if (n.slice(0, 8).some(function (v) { return !isFinite(v); })) return null;
    return {
      type: type,
      pos: [n[0], n[1], n[2]],
      size: [n[3], n[4], n[5]],
      uv: [n[6], n[7]],
      armor: isFinite(n[8]) ? n[8] : 0,
      mirror: n[9] === 1,
      inflate: isFinite(n[10]) ? n[10] : 0
    };
  }

  function fmt(n) {
    var v = Math.round(n * 100) / 100;
    return String(v).replace(',', '.');
  }

  /** caja (min/max en coordenadas del modelo) -> {pos, size} relativo al pivote */
  function cubeToBox(type, min, max, uv, opts) {
    opts = opts || {};
    var pivot = BOX_PIVOT[type];
    if (!pivot) throw new Error('Tipo de caja no válido: ' + type);
    return {
      type: type,
      pos: [min[0] - pivot[0], pivot[1] - max[1], min[2] - pivot[2]],
      size: [Math.abs(max[0] - min[0]), Math.abs(max[1] - min[1]), Math.abs(max[2] - min[2])],
      uv: [uv[0], uv[1]],
      armor: opts.armor || 0,
      mirror: !!opts.mirror,
      inflate: opts.inflate || 0
    };
  }

  /** devuelve las cajas en coordenadas absolutas del modelo (para dibujar) */
  function boxToModelSpace(box) {
    var pivot = BOX_PIVOT[box.type] || [0, 24, 0];
    var x = pivot[0] + box.pos[0];
    var yTop = pivot[1] - box.pos[1];
    var z = pivot[2] + box.pos[2];
    return {
      type: box.type,
      min: [x, yTop - box.size[1], z],
      max: [x + box.size[0], yTop, z + box.size[2]],
      uv: box.uv,
      inflate: box.inflate || 0
    };
  }

  /* ------------------------- construcción del pack ----------------------- */

  /** piezas de armadura/hand que se pueden desplazar con OFFSET (TU33 + TU58) */
  var OFFSET_TYPES = ['HELMET', 'CHEST', 'SHOULDER0', 'SHOULDER1', 'WAIST',
    'PANTS0', 'PANTS1', 'BOOT0', 'BOOT1', 'TOOL0', 'TOOL1',
    'HEAD', 'BODY', 'ARM0', 'ARM1', 'LEG0', 'LEG1'];

  var ANIM = {
    NONE: 0x00000000,
    MODERN_WIDE_MODEL: 0x00040000, // skin 64x64, brazos anchos (Steve)
    SLIM_MODEL: 0x00080000,        // skin 64x64, brazos finos (Alex)
    HIDE_ARMOR: 0x00000100         // bit 9: no dibujar ninguna armadura (TU17)
  };

  var GAME_FLAGS = {
    UNFAIR: 0x01,       // bit 1: no permitida en Battle Mode con «Allow All Skins» desactivado
    CREATURE: 0x16,
    HUMAN: 0x18,
    FEMALE_HUMAN: 0x1a,
    MALE_HUMAN: 0x1c,
    ROBOT: 0x0e
  };

  function randomSkinId(used) {
    used = used || [];
    var id;
    do {
      id = 100000 + Math.floor(Math.random() * 99899999);
    } while (used.indexOf(id) !== -1);
    return id;
  }

  function randomPackId() {
    return 8000 + Math.floor(Math.random() * (0x00ffffff - 8000));
  }

  /**
   * Construye un skin pack .pck completo (mismo esquema que PCK Studio:
   * "0" InfoFile con PACKID/PACKVERSION + localisation.loc + skins dlcskinXXXXXXXX.png).
   *
   * @param {object} o
   * @param {string} o.packName
   * @param {number} [o.packId]
   * @param {number} [o.packVersion]
   * @param {Array}  o.skins  [{id,name,theme,png(Uint8Array),anim,gameFlags}]
   * @param {boolean}[o.littleEndian] false = PS3 / 360 / Wii U
   * @param {number} [o.pckType]
   * @param {number} [o.xmlVersion]
   * @param {number} [o.locVersion]
   */
  function buildSkinPack(o) {
    var packName = o.packName || 'Mi skin pack';
    var packId = o.packId == null ? randomPackId() : o.packId | 0;
    var packVersion = o.packVersion == null ? 0 : o.packVersion | 0;
    var skins = o.skins || [];
    var locVersion = o.locVersion == null ? 2 : o.locVersion;

    var assets = [];
    assets.push({
      filename: '0',
      type: ASSET_TYPE.InfoFile,
      data: new Uint8Array(0),
      params: [['PACKID', String(packId)], ['PACKVERSION', String(packVersion)]]
    });

    var locKeys = {};
    locKeys['IDS_DISPLAY_NAME'] = { 'en-EN': packName };

    var skinAssets = [];
    var usedIds = [];
    skins.forEach(function (s) {
      var id = s.id == null || usedIds.indexOf(s.id) !== -1 ? randomSkinId(usedIds) : s.id | 0;
      usedIds.push(id);
      var idStr = pad8(id);
      var displayKey = 'IDS_dlcskin' + idStr + '_DISPLAYNAME';
      var name = s.name || ('Skin ' + idStr);
      locKeys[displayKey] = { 'en-EN': name };

      var params = [['DISPLAYNAME', name], ['DISPLAYNAMEID', displayKey]];
      if (s.theme) {
        var themeKey = 'IDS_dlcskin' + idStr + '_THEMENAME';
        locKeys[themeKey] = { 'en-EN': s.theme };
        params.push(['THEMENAME', s.theme], ['THEMENAMEID', themeKey]);
      }
      var anim = s.anim == null ? ANIM.MODERN_WIDE_MODEL : s.anim;
      if (s.hideArmor) anim |= ANIM.HIDE_ARMOR;
      var flags = s.gameFlags == null ? GAME_FLAGS.HUMAN : s.gameFlags;
      if (s.unfair) flags |= GAME_FLAGS.UNFAIR;
      params.push(['ANIM', '0x' + hex(anim, 8)]);
      params.push(['GAME_FLAGS', '0x' + hex(flags, 2)]);
      params.push(['FREE', '1']);
      // geometría personalizada: una entrada BOX por caja
      (s.boxes || []).forEach(function (box) {
        params.push(['BOX', boxToString(box)]);
      });
      // desplazamiento vertical de armadura / partes (OFFSET TIPO Y valor)
      var offs = s.offsets || {};
      Object.keys(offs).forEach(function (tipo) {
        var v = Math.round(Number(offs[tipo]) || 0);
        if (!v || OFFSET_TYPES.indexOf(tipo) < 0) return;
        params.push(['OFFSET', tipo + ' Y ' + v]);
      });

      skinAssets.push({
        filename: 'dlcskin' + idStr + '.png',
        type: ASSET_TYPE.SkinFile,
        data: toU8(s.png),
        params: params,
        id: id
      });
    });

    assets.push({
      filename: 'localisation.loc',
      type: ASSET_TYPE.LocalisationFile,
      data: writeLoc({ languages: ['en-EN'], keys: locKeys, version: locVersion }),
      params: []
    });
    assets = assets.concat(skinAssets);

    // Si alguna skin lleva BOX, el pack necesita XMLVERSION (2 por defecto, 3 si hay inflado)
    var minXml = 0;
    skins.forEach(function (s) {
      if (s.boxes && s.boxes.length) minXml = Math.max(minXml, s.xmlVersion || 0);
    });
    var xmlVersion = Math.max(o.xmlVersion || 0, minXml);

    var bytes = writePck({
      pckType: o.pckType == null ? 3 : o.pckType,
      xmlVersion: xmlVersion,
      littleEndian: !!o.littleEndian,
      assets: assets
    });
    return { bytes: bytes, assets: assets, packId: packId, skins: skinAssets, xmlVersion: xmlVersion };
  }

  /**
   * Extrae las skins de un .pck ya existente (para poder editarlo/ampliarlo).
   */
  /** OFFSET "HELMET Y -2" -> {HELMET: -2} */
  function parseOffsets(params) {
    var out = {};
    (params || []).forEach(function (pr) {
      if (pr[0] !== 'OFFSET') return;
      var m = /^([A-Z0-9]+)\s+[Yy]\s+(-?\d+)$/.exec(String(pr[1]).trim());
      if (m) out[m[1]] = parseInt(m[2], 10);
    });
    return out;
  }

  function extractSkins(pck) {
    var loc = null;
    pck.assets.forEach(function (a) {
      if (a.type === ASSET_TYPE.LocalisationFile && !loc) {
        try { loc = readLoc(a.data); } catch (e) { loc = null; }
      }
    });
    var skins = [];
    pck.assets.forEach(function (a) {
      if (a.type !== ASSET_TYPE.SkinFile) return;
      var idMatch = /dlcskin(\d+)/i.exec(a.filename);
      var displayKey = a.get('DISPLAYNAMEID');
      var name = a.get('DISPLAYNAME') || '';
      if ((!name || name === '') && loc && displayKey && loc.keys[displayKey]) {
        name = loc.keys[displayKey]['en-EN'] || Object.values(loc.keys[displayKey])[0] || '';
      }
      var animStr = a.get('ANIM') || '0x0';
      skins.push({
        id: idMatch ? parseInt(idMatch[1], 10) : null,
        name: name,
        theme: a.get('THEMENAME') || '',
        png: a.data,
        anim: parseInt(animStr, 16) || 0,
        gameFlags: parseInt(a.get('GAME_FLAGS') || '0x18', 16) || 0x18,
        params: a.params,
        offsets: parseOffsets(a.params),
        hideArmor: !!(parseInt(a.get('ANIM') || '0x0', 16) & ANIM.HIDE_ARMOR),
        unfair: !!(parseInt(a.get('GAME_FLAGS') || '0x18', 16) & GAME_FLAGS.UNFAIR),
        xmlVersion: a.xmlVersion,
        filename: a.filename
      });
    });
    return { skins: skins, loc: loc };
  }

  return {
    ASSET_TYPE: ASSET_TYPE,
    ASSET_TYPE_NAME: ASSET_TYPE_NAME,
    ANIM: ANIM,
    GAME_FLAGS: GAME_FLAGS,
    writePck: writePck,
    readPck: readPck,
    writeLoc: writeLoc,
    readLoc: readLoc,
    buildSkinPack: buildSkinPack,
    extractSkins: extractSkins,
    BOX_PIVOT: BOX_PIVOT,
    BOX_TYPES: BOX_TYPES,
    OVERLAY_BOX_TYPES: OVERLAY_BOX_TYPES,
    ARMOR: ARMOR,
    OFFSET_TYPES: OFFSET_TYPES,
    parseOffsets: parseOffsets,
    armorLabel: armorLabel,
    boxToString: boxToString,
    parseBox: parseBox,
    cubeToBox: cubeToBox,
    boxToModelSpace: boxToModelSpace,
    randomSkinId: randomSkinId,
    randomPackId: randomPackId,
    pad8: pad8,
    hex: hex
  };
});
