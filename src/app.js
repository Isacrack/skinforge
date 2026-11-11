/* ============================================================
   app.js — UI de SkinForge (Java/Bedrock → .pck de PS3)
   ============================================================ */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const MAX_SAFE_SKIN_BYTES = 0x7fff; // 32767 — por encima, algunos packs crashean

  /* ------------------------------- estado ------------------------------- */
  const state = {
    skins: [],           // {key,id,name,theme,model,png,w,h,bytes,src,thumbUrl,warn}
    packName: 'Mis skins PS3',
    packId: PCK.randomPackId(),
    packVersion: 0,
    target: 'ps3',       // 'ps3' (big endian) | 'modern' (little endian)
    resolution: 'auto',  // 'auto' | '64x64' | '64x32' | 'orig'
    xmlVersion: 0,
    showArmor: false,
    showBase: true,
    showCapas: true,
    lastBuild: null,
    busy: false
  };

  let keySeq = 1;

  /* ------------------------------- helpers ------------------------------ */
  function toast(msg, kind) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || 'info');
    el.innerHTML = msg;
    while (box.children.length > 2) box.removeChild(box.firstChild);
    box.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 400);
    }, kind === 'error' ? 7000 : 4200);
  }

  function humanSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function loadImageBitmap(blob) {
    if (window.createImageBitmap) {
      return createImageBitmap(blob).catch(() => loadImageElement(blob));
    }
    return loadImageElement(blob);
  }

  function loadImageElement(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen')); };
      img.src = url;
    });
  }

  function canvasToPngBytes(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) return reject(new Error('No se pudo codificar el PNG'));
        resolve(new Uint8Array(await blob.arrayBuffer()));
      }, 'image/png');
    });
  }

  function canvasToUrl(canvas) {
    return canvas.toDataURL('image/png');
  }

  /* --------------------------- lectura de ZIP --------------------------- */
  async function unzip(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    const dv = new DataView(arrayBuffer);
    let eocd = -1;
    const min = Math.max(0, u8.length - 22 - 65535);
    for (let i = u8.length - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('El ZIP no es válido');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('Directorio central del ZIP corrupto');
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = new TextDecoder('utf-8').decode(u8.subarray(off + 46, off + 46 + nameLen));
      entries.push({ name: name.replace(/\\/g, '/'), method, compSize, localOff });
      off += 46 + nameLen + extraLen + commentLen;
    }
    const out = [];
    for (const e of entries) {
      if (e.name.endsWith('/')) continue;
      if (!e.name) continue;
      if (dv.getUint32(e.localOff, true) !== 0x04034b50) throw new Error('Entrada ZIP corrupta: ' + e.name);
      const nlen = dv.getUint16(e.localOff + 26, true);
      const elen = dv.getUint16(e.localOff + 28, true);
      const start = e.localOff + 30 + nlen + elen;
      const raw = u8.subarray(start, start + e.compSize);
      let data;
      if (e.method === 0) {
        data = raw.slice();
      } else if (e.method === 8) {
        if (typeof DecompressionStream === 'undefined') {
          throw new Error('Tu navegador no soporta descompresión ZIP. Usa Chrome/Edge/Firefox recientes.');
        }
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } else {
        throw new Error('Compresión ZIP no soportada (método ' + e.method + ')');
      }
      out.push({ name: e.name, data });
    }
    return out;
  }

  function decodeText(data) {
    if (!data) return '';
    try { return new TextDecoder('utf-8').decode(data).replace(/^\uFEFF/, ''); } catch (e) { return ''; }
  }

  function parseLang(text) {
    const map = {};
    text.split(/\r?\n/).forEach((line) => {
      const idx = line.indexOf('=');
      if (idx <= 0 || line.trim().startsWith('#')) return;
      map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    return map;
  }

  /* ------------------------ añadir skins a la lista --------------------- */
  async function addSkinFromBlob(blob, opts) {
    opts = opts || {};
    const img = await loadImageBitmap(blob);
    const sw = img.width, sh = img.height;
    if (!sw || !sh) throw new Error('Imagen sin dimensiones');

    // resolución de destino
    let tw, th;
    if (state.resolution === '64x64') { tw = 64; th = 64; }
    else if (state.resolution === '64x32') { tw = 64; th = 32; }
    else if (state.resolution === 'orig') { tw = sw; th = sh; }
    else { // auto: respeta 2:1 (clásica) o cuadrada
      if (Math.abs(sw / sh - 2) < 0.02) { tw = 64; th = 32; }
      else { tw = 64; th = 64; }
    }

    const canvas = document.createElement('canvas');
    canvas.width = tw; canvas.height = th;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, tw, th);
    ctx.drawImage(img, 0, 0, tw, th);

    const png = await canvasToPngBytes(canvas);
    const model = opts.model || (th === 32 ? 'classic' : (Math.abs(sw / sh - 2) < 0.02 ? 'classic' : 'wide'));

    const skin = {
      key: 'k' + (keySeq++),
      id: opts.id || null,
      name: opts.name || 'Skin ' + state.skins.length + 1,
      theme: opts.theme || '',
      model: model, // 'wide' | 'slim' | 'classic'
      png: png,
      w: tw, h: th,
      srcW: sw, srcH: sh,
      src: opts.src || '',
      thumbUrl: canvasToUrl(canvas),
      warn: png.length > MAX_SAFE_SKIN_BYTES ? 'PNG grande (' + humanSize(png.length) + '): puede fallar en consola' : ''
    };
    state.skins.push(skin);
    if (opts.thumbFromUpscaled) { /* noop */ }
    return skin;
  }

  async function addSkinFromFile(file) {
    const nameHint = file.name.replace(/\.[a-z0-9]+$/i, '');
    return addSkinFromBlob(file, { name: nameHint, src: file.name });
  }

  /* --------------------------- importar .pck ---------------------------- */
  async function importPck(file) {
    const buf = await file.arrayBuffer();
    const pck = PCK.readPck(buf);
    const ext = PCK.extractSkins(pck);
    if (!ext.skins.length) {
      toast('Ese .pck no contiene skins (tipo 0). ¿Es un pack de texturas?', 'warn');
    }
    let added = 0;
    for (const s of ext.skins) {
      const blob = new Blob([s.png], { type: 'image/png' });
      const model = (s.anim & PCK.ANIM.SLIM_MODEL) ? 'slim' : ((s.anim & PCK.ANIM.MODERN_WIDE_MODEL) ? 'wide' : 'classic');
      const skin = await addSkinFromBlob(blob, { name: s.name || ('Skin ' + s.id), theme: s.theme, id: s.id, model, src: file.name });
      if (skin) {
        skin.offsets = s.offsets && Object.keys(s.offsets).length ? Object.assign({}, s.offsets) : {};
        skin.hideArmor = !!s.hideArmor;
        skin.unfair = !!s.unfair;
      }
      // recupera la geometría personalizada (parámetros BOX) del pack original
      const boxParams = (s.params || []).filter((pr) => pr[0] === 'BOX').map((pr) => PCK.parseBox(pr[1])).filter(Boolean);
      if (boxParams.length && skin) {
        skin.model3d = {
          fileName: file.name, boxes: boxParams, parts: boxParams.map((b) => ({ type: b.type })),
          warnings: [], xmlVersion: pck.xmlVersion || 0, cubes: boxParams.length
        };
      }
      added++;
    }
    // PACKID del pack original, si lo hay
    const info = pck.assets.find((a) => a.type === PCK.ASSET_TYPE.InfoFile && a.get('PACKID'));
    if (info && state.packId !== Number(info.get('PACKID'))) {
      state.packId = Number(info.get('PACKID')) || state.packId;
    }
    if (pck.xmlVersion) state.xmlVersion = pck.xmlVersion;
    toast('Importadas <b>' + added + '</b> skins de <code>' + file.name + '</code> (' +
      (pck.littleEndian ? 'little endian' : 'big endian') + ', tipo ' + pck.pckType + ')', 'ok');
    render();
  }

  /* --------------------- importar .zip / .mcpack ------------------------ */
  async function importZip(file) {
    const buf = await file.arrayBuffer();
    const entries = await unzip(buf);
    const byName = {};
    entries.forEach((e) => { byName[e.name.toLowerCase()] = e; });

    // textos de idioma (Bedrock)
    let lang = {};
    const enLang = entries.find((e) => /(^|\/)texts\/en_us\.lang$/i.test(e.name)) ||
      entries.find((e) => /(^|\/)texts\/[a-z_]+\.lang$/i.test(e.name));
    if (enLang) lang = parseLang(decodeText(enLang.data));

    // skins.json (formato clásico de skin packs de Bedrock/PE)
    const skinJsonEntries = entries.filter((e) => /(^|\/)skins\.json$/i.test(e.name));
    let added = 0;

    if (skinJsonEntries.length) {
      for (const sj of skinJsonEntries) {
        let json;
        try { json = JSON.parse(decodeText(sj.data)); } catch (e) { continue; }
        const list = Array.isArray(json.skins) ? json.skins : [];
        const baseDir = sj.name.slice(0, sj.name.lastIndexOf('/') + 1);
        for (const item of list) {
          const texRel = (item.texture || '').replace(/^\.\//, '');
          if (!texRel) continue;
          const full = (baseDir + texRel).toLowerCase();
          const entry = byName[full] || byName[texRel.toLowerCase()];
          if (!entry) continue;
          const locName = item.localization_name || '';
          const display = lang[locName] || locName || texRel.replace(/\.[a-z0-9]+$/i, '');
          const geo = String(item.geometry || '').toLowerCase();
          const model = geo.includes('slim') ? 'slim' : (geo.includes('classic') || geo.includes('custom') ? 'wide' : 'wide');
          const theme = json.localization_name ? (lang[json.localization_name] || json.localization_name) : '';
          await addSkinFromBlob(new Blob([entry.data], { type: 'image/png' }), {
            name: display, theme: theme, model: model, src: file.name + ' › ' + entry.name
          });
          added++;
        }
      }
    }

    if (!added) {
      // sin skins.json: todas las PNG del zip, en orden
      const pngs = entries.filter((e) => /\.png$/i.test(e.name) && !/(^|\/)(pack_icon|icon|comparison)\.png$/i.test(e.name));
      pngs.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
      for (const p of pngs) {
        const base = p.name.split('/').pop().replace(/\.png$/i, '');
        // intenta usar el nombre del .lang si coincide con una clave
        await addSkinFromBlob(new Blob([p.data], { type: 'image/png' }), {
          name: lang[base] || lang['skin.' + base + '.name'] || base,
          src: file.name + ' › ' + p.name,
          model: 'wide'
        });
        added++;
      }
    }

    if (!added) throw new Error('No se encontraron skins (.png / skins.json) dentro del ZIP');
    toast('Importadas <b>' + added + '</b> skins desde <code>' + file.name + '</code>', 'ok');
    render();
  }

  /**
   * Importa un .bbmodel. Manda la PNG que sueltes junto al modelo (es la skin
   * que quieres ver en 3D); si no hay PNG, se usa la textura incrustada en el
   * .bbmodel o, si solo apunta a una ruta, el PNG que ya esté cargado.
   */
  async function importBbmodel(file, pngDelLote, consumidos) {
    const parsed = parseBbModel(await file.text());
    const base = (n) => String(n || '').replace(/\.[a-z0-9]+$/i, '').trim().toLowerCase();
    const nombreTex = base(parsed.textureName);
    const baseModelo = base(file.name);

    // ¿viene una PNG en el mismo lote? entonces ELLA es la textura del modelo
    const libres = (pngDelLote || []).filter((f) => !consumidos.has(f));
    const png = libres.find((f) => base(f.name) === baseModelo) ||          // mismo nombre que el modelo
      libres.find((f) => base(f.name) === nombreTex) ||                    // mismo nombre que su textura
      (libres.length === 1 ? libres[0] : null);                            // única PNG del lote

    let skin = null;
    if (png) {
      consumidos.add(png);
      skin = state.skins.find((x) => x.src === png.name) || null;
      if (!skin) skin = await addSkinFromBlob(png, { name: parsed.name || base(png.name) || baseModelo, src: png.name });
      if (parsed.textureUrl) {
        toast('Modelo + PNG: se usa <code>' + escapeHtml(png.name) + '</code> como textura (no la incrustada en el .bbmodel)', 'ok');
      }
    } else if (parsed.textureUrl) {
      // si ya hay una skin con el mismo nombre (el del modelo o el de su textura), el modelo va a ella
      skin = state.skins.find((x) => !x.model3d &&
        (base(x.name) === baseModelo || (nombreTex && base(x.name) === nombreTex))) || null;
      if (!skin) {
        skin = await addSkinFromBlob(dataUrlToBlob(parsed.textureUrl), { name: parsed.name || baseModelo, src: file.name });
        if (state.skins.filter((x) => !x.model3d).length) {
          toast('Modelo con su propia textura. Para ver <b>tu PNG</b> con esta geometría, suéltalos <b>juntos</b> ' +
            '(o carga la PNG antes de soltar el <code>.bbmodel</code>).', 'info');
        }
      }
    } else {
      // solo apunta a una ruta: busca esa skin ya cargada
      if (nombreTex) {
        skin = state.skins.find((x) => (x.name || '').toLowerCase() === nombreTex) ||
          state.skins.find((x) => base((x.src || '').split('›').pop()) === nombreTex) || null;
      }
      // o la única skin que aún no tiene modelo (soltar la PNG primero y el .bbmodel después)
      if (!skin) {
        const candidatas = state.skins.filter((x) => !x.model3d);
        if (candidatas.length === 1) {
          skin = candidatas[0];
          toast('Modelo aplicado a <b>' + escapeHtml(skin.name) + '</b>', 'ok');
        }
      }
      if (!skin) {
        const c = document.createElement('canvas');
        c.width = 64; c.height = 64;
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        skin = await addSkinFromBlob(blob, { name: parsed.name || baseModelo, src: file.name });
        toast('El <code>.bbmodel</code> apunta a <code>' + escapeHtml(parsed.textureName || 'una textura externa') +
          '</code>: suéltala junto al modelo, o carga la PNG antes', 'warn');
      }
    }
    await applyBbModelToSkin(skin, file);
  }

  /* ---------------------------- entrada ficheros ------------------------ */
  async function handleFiles(fileList) {
    if (state.busy) return;
    const files = Array.from(fileList || []);
    if (!files.length) return;
    state.busy = true;
    setBusy(true);
    let errors = 0;
    // las PNG del mismo lote sirven de textura si el .bbmodel solo trae una ruta
    const pngDelLote = files.filter((f) => /\.png$/i.test(f.name));
    const consumidos = new Set();
    for (const file of files) {
      if (consumidos.has(file)) continue;
      const lower = file.name.toLowerCase();
      try {
        if (/\.pck$/.test(lower)) await importPck(file);
        else if (/\.(zip|mcpack|mcaddon|mcskin)$/.test(lower)) await importZip(file);
        else if (/\.(png|jpe?g|webp)$/.test(lower)) { await addSkinFromFile(file); render(); }
        else if (/\.bbmodel$/.test(lower)) { await importBbmodel(file, pngDelLote, consumidos); render(); }
        else toast('Formato no soportado: <code>' + file.name + '</code>', 'warn');
      } catch (err) {
        errors++;
        console.error(err);
        toast('<b>' + file.name + '</b>: ' + err.message, 'error');
      }
    }
    state.busy = false;
    setBusy(false);
    render();
    if (!errors) toast('Listo: ' + state.skins.length + ' skin(s) en el pack', 'ok');
  }

  function setBusy(b) {
    document.body.classList.toggle('busy', b);
  }

  /* -------------------------------- render ------------------------------ */
  function animFor(skin) {
    if (skin.model === 'slim') return PCK.ANIM.SLIM_MODEL;
    if (skin.model === 'wide') return PCK.ANIM.MODERN_WIDE_MODEL;
    return 0;
  }

  function render() {
    renderList();
    renderSettings();
    renderSummary();
  }

  function renderList() {
    const list = $('#skinList');
    list.innerHTML = '';
    $('#emptyState').style.display = state.skins.length ? 'none' : 'block';
    $('#skinCount').textContent = state.skins.length;

    state.skins.forEach((skin, i) => {
      const card = document.createElement('div');
      card.className = 'skin-card';
      card.innerHTML = `
        <div class="skin-thumb"><img alt="" src="${skin.thumbUrl}"><span class="badge">${skin.w}×${skin.h}</span></div>
        <div class="skin-fields">
          <label class="field">
            <span>Nombre visible</span>
            <input type="text" data-role="name" value="${escapeAttr(skin.name)}" maxlength="60" placeholder="Nombre de la skin">
          </label>
          <label class="field">
            <span>Tema (opcional)</span>
            <input type="text" data-role="theme" value="${escapeAttr(skin.theme)}" maxlength="60" placeholder="Ej. Clásico">
          </label>
          <div class="field-row">
            <label class="field">
              <span>Modelo</span>
              <select data-role="model">
                <option value="classic"${skin.model === 'classic' ? ' selected' : ''}>Clásico (64×32, brazos anchos)</option>
                <option value="wide"${skin.model === 'wide' ? ' selected' : ''}>Moderno ancho (Steve)</option>
                <option value="slim"${skin.model === 'slim' ? ' selected' : ''}>Moderno fino (Alex)</option>
              </select>
            </label>
            <label class="field narrow">
              <span>ID</span>
              <input type="text" data-role="id" value="${skin.id ? skin.id : 'auto'}" inputmode="numeric" title="8 dígitos; se autorrellena si lo dejas en 'auto'">
            </label>
          </div>
          <div class="model-row">
            <span class="pill${skin.model3d ? ' model-on' : ''}">${skin.model3d
              ? 'Modelo: ' + skin.model3d.boxes.length + ' cajas · ' + (skin.model3d.xmlVersion ? 'XMLVERSION ' + skin.model3d.xmlVersion : 'sin XMLVERSION')
              : 'Modelo 3D: no'}</span>
            <button class="btn sm ghost" data-role="bbmodel">${skin.model3d ? 'Cambiar .bbmodel' : '+ .bbmodel'}</button>
            ${skin.model3d && skin.model3d.boxes.some((b) => b.armor) ? '<span class="pill warn-pill" title="Cajas que se ocultan al llevar armadura">armadura: ' + skin.model3d.boxes.filter((b) => b.armor).length + ' ocultables</span>' : ''}
            ${skin.model3d ? '<button class="icon-btn del" data-role="bbclear" title="Quitar modelo 3D">✕</button>' : ''}
          </div>
          <div class="skin-meta">
            <span class="pill">PNG ${humanSize(skin.png.length)}</span>
            <span class="pill">origen ${skin.srcW}×${skin.srcH}</span>
            ${skin.warn ? '<span class="pill danger">' + escapeHtml(skin.warn) + '</span>' : ''}
          </div>
        </div>
        <div class="skin-actions">
          <button class="icon-btn doll-btn" title="Ver modelo">3D</button>
          <button class="icon-btn up" title="Subir">↑</button>
          <button class="icon-btn down" title="Bajar">↓</button>
          <button class="icon-btn del" title="Quitar">✕</button>
        </div>`;

      // eventos
      $('[data-role="name"]', card).addEventListener('input', (e) => { skin.name = e.target.value; renderSummary(); });
      $('[data-role="theme"]', card).addEventListener('input', (e) => { skin.theme = e.target.value; });
      $('[data-role="model"]', card).addEventListener('change', (e) => {
        skin.model = e.target.value;
        if (skin.model !== 'classic' && skin.h === 32) {
          toast('Ojo: una skin 64×32 con modelo moderno se verá mal. Cambia la resolución a 64×64 al importar.', 'warn');
        }
      });
      $('[data-role="id"]', card).addEventListener('change', (e) => {
        const v = parseInt(e.target.value.replace(/\D/g, ''), 10);
        if (!v || v < 1000 || v > 99999998) { skin.id = null; e.target.value = 'auto'; return; }
        const dup = state.skins.some((s) => s !== skin && s.id === v);
        if (dup) { toast('Ese ID ya está en uso', 'warn'); skin.id = null; e.target.value = 'auto'; return; }
        skin.id = v;
      });
      const bbBtn = $('[data-role="bbmodel"]', card);
      if (bbBtn) bbBtn.addEventListener('click', () => pickBbModel(skin));
      const bbClear = $('[data-role="bbclear"]', card);
      if (bbClear) bbClear.addEventListener('click', () => { skin.model3d = null; render(); });

      $('.del', card).addEventListener('click', () => {
        state.skins.splice(i, 1);
        render();
      });
      $('.up', card).addEventListener('click', () => {
        if (i === 0) return;
        state.skins.splice(i - 1, 0, state.skins.splice(i, 1)[0]);
        render();
      });
      $('.down', card).addEventListener('click', () => {
        if (i === state.skins.length - 1) return;
        state.skins.splice(i + 1, 0, state.skins.splice(i, 1)[0]);
        render();
      });
      $('.doll-btn', card).addEventListener('click', () => openDoll(skin));

      list.appendChild(card);
    });
  }

  function renderSettings() {
    const nameEl = $('#packName');
    if (document.activeElement !== nameEl) nameEl.value = state.packName;
    const idEl = $('#packId');
    if (document.activeElement !== idEl) idEl.value = String(state.packId);
    const verEl = $('#packVersion');
    if (document.activeElement !== verEl) verEl.value = String(state.packVersion);
    $$('input[name="target"]').forEach((r) => { r.checked = r.value === state.target; });
    $('#resolution').value = state.resolution;
    if ($('#xmlVersion')) $('#xmlVersion').value = String(state.xmlVersion);
  }

  function renderSummary() {
    const skins = state.skins;
    let total = 0;
    skins.forEach((s) => { total += s.png.length; });
    $('#sumSkins').textContent = skins.length;
    $('#sumPng').textContent = humanSize(total);
    const est = 4 + 4 + 40 * 2 + 12 + skins.length * 60 + 8 + total + 4096;
    $('#sumEst').textContent = '≈ ' + humanSize(est);
    const btn = $('#downloadBtn');
    btn.disabled = skins.length === 0;
    const withModel = skins.filter((s) => s.model3d).length;
    const maxXml = Math.max.apply(null, skins.map((s) => (s.model3d ? s.model3d.xmlVersion || 0 : 0)).concat([state.xmlVersion || 0]));
    const fmtEl = $('#sumFormat');
    if (fmtEl) {
      fmtEl.textContent = 'PCK 3 · ' + (state.target === 'ps3' ? 'BE' : 'LE') + (maxXml ? ' · XMLVERSION ' + maxXml : '');
    }
    let hint = '';
    if (skins.length === 0) hint = 'Añade al menos una skin para poder exportar.';
    else if (withModel) {
      hint = withModel + ' skin(s) con modelo 3D → el pack saldrá con XMLVERSION ' + maxXml + '.';
      if (withModel < skins.length) hint += ' Mezclar skins con y sin modelo puede dar problemas: pruébalo en la consola.';
    }
    $('#buildHint').textContent = hint;
  }

  /* --------------------------- previsualización ------------------------- */
  const DOLL = {
    // regiones de la textura clásica (64x64 y 64x32)
    head: [8, 8, 8, 8],
    hat: [40, 8, 8, 8],
    body: [20, 20, 8, 12],
    jacket: [20, 36, 8, 12],
    armR: [44, 20, 4, 12],
    armRsleeve: [44, 36, 4, 12],
    armL: [36, 52, 4, 12],
    armLsleeve: [52, 52, 4, 12],
    legR: [4, 20, 4, 12],
    legRpants: [0, 36, 4, 12],
    legL: [20, 52, 4, 12],
    legLpants: [0, 52, 4, 12]
  };

  function drawDoll(canvas, skin, scale) {
    const s = scale || 10;
    const modern = skin.h === 64;
    const slim = skin.model === 'slim';
    const armW = slim ? 3 : 4;
    const W = (8 + 2 * armW) * s, H = 32 * s;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);

    const img = new Image();
    img.onload = () => {
      ctx.imageSmoothingEnabled = false;
      const blit = (region, dx, dy, dw, dh, mirror) => {
        if (!region) return;
        const [sx, sy, sw, sh] = region;
        if (sy + sh > img.height || sx + sw > img.width) return;
        if (mirror) {
          ctx.save();
          ctx.translate((2 * dx + dw) * s, 0); // espejo en el mismo sitio
          ctx.scale(-1, 1);
          ctx.drawImage(img, sx, sy, sw, sh, dx * s, dy * s, dw * s, dh * s);
          ctx.restore();
        } else {
          ctx.drawImage(img, sx, sy, sw, sh, dx * s, dy * s, dw * s, dh * s);
        }
      };
      const cx = armW; // x del cuerpo: los brazos ocupan los extremos
      // piernas
      if (modern) {
        blit(DOLL.legR, cx, 20, 4, 12);
        blit(DOLL.legL, cx + 4, 20, 4, 12);
        blit(DOLL.legRpants, cx, 20, 4, 12);
        blit(DOLL.legLpants, cx + 4, 20, 4, 12);
      } else {
        blit(DOLL.legR, cx, 20, 4, 12);
        blit(DOLL.legR, cx + 4, 20, 4, 12, true);
      }
      // cuerpo
      blit(DOLL.body, cx, 8, 8, 12);
      if (modern) blit(DOLL.jacket, cx, 8, 8, 12);
      // brazos (el derecho del jugador queda a la izquierda de la imagen)
      if (modern) {
        blit(slim ? [44, 20, 3, 12] : DOLL.armR, cx - armW, 8, armW, 12);
        blit(slim ? [44, 36, 3, 12] : DOLL.armRsleeve, cx - armW, 8, armW, 12);
        blit(slim ? [36, 52, 3, 12] : DOLL.armL, cx + 8, 8, armW, 12);
        blit(slim ? [52, 52, 3, 12] : DOLL.armLsleeve, cx + 8, 8, armW, 12);
      } else {
        blit(DOLL.armR, cx - armW, 8, armW, 12);
        blit(DOLL.armR, cx + 8, 8, armW, 12, true);
      }
      // cabeza (encima de todo)
      blit(DOLL.head, cx, 0, 8, 8);
      blit(DOLL.hat, cx, 0, 8, 8);
    };
    img.src = skin.thumbUrl;
  }

  let armorSeleccionada = null;   // pieza de armadura elegida en el editor
  let repintar3D = null;          // la pone openDoll para refrescar la vista

  const PIEZAS_ARMADURA = [
    ['HELMET', 'Casco'], ['CHEST', 'Peto'], ['SHOULDER0', 'Hombro der.'], ['SHOULDER1', 'Hombro izq.'],
    ['WAIST', 'Cintura'], ['PANTS0', 'Gregüesco der.'], ['PANTS1', 'Gregüesco izq.'],
    ['BOOT0', 'Bota der.'], ['BOOT1', 'Bota izq.']
  ];

  /** editor completo del modal: cajas (máscara) + armadura (OFFSET y flags) */
  function renderEditor(skin) {
    const host = $('#boxEditor');
    if (!host) return;
    host.innerHTML = '';

    if (skin.model3d) {
      const boxes = skin.model3d.boxes;
      const piezas = [[1, 'Casco'], [2, 'Peto'], [4, 'Gregüesco'], [8, 'Botas']];
      const wrap = document.createElement('div');
      wrap.className = 'be-boxes';
      wrap.innerHTML =
        '<div class="be-head"><span>Se oculta la caja al llevar:</span>' +
          '<button class="btn sm ghost" data-preset="all">Todo</button>' +
          '<button class="btn sm ghost" data-preset="overlay">Solo capas</button>' +
          '<button class="btn sm ghost" data-preset="none">Ninguna</button>' +
        '</div>' +
        boxes.map((b, i) => {
          const ms = PCK.boxToModelSpace(b);
          const size = [ms.max[0] - ms.min[0], ms.max[1] - ms.min[1], ms.max[2] - ms.min[2]]
            .map((v) => Math.round(v)).join('×');
          const parte = (skin.model3d.parts && skin.model3d.parts[i]) || {};
          const etiqueta = parte.name && parte.name !== b.type ? '«' + escapeHtml(parte.name) + '» ' : '';
          return '<div class="box-row" data-i="' + i + '">' +
            '<div><div><span class="be-type">' + b.type + '</span> <span class="be-size">' + etiqueta + size + '</span></div>' +
            '<div class="be-size" data-role="label">' + PCK.armorLabel(b.armor || 0) + '</div></div>' +
            '<div class="be-mask">' + piezas.map(([bit, txt]) =>
              '<label class="arm"><input type="checkbox" data-bit="' + bit + '"' +
              ((b.armor || 0) & bit ? ' checked' : '') + '>' + txt + '</label>').join('') +
            '</div></div>';
        }).join('');
      host.appendChild(wrap);

      const refresh = () => {
        drawModel3D($('#dollCanvas'), skin);
        boxes.forEach((b, i) => {
          const row = wrap.querySelector('.box-row[data-i="' + i + '"] [data-role="label"]');
          if (row) row.textContent = PCK.armorLabel(b.armor || 0);
        });
      };
      wrap.querySelectorAll('.box-row').forEach((row) => {
        const i = Number(row.dataset.i);
        row.querySelectorAll('input[data-bit]').forEach((chk) => {
          chk.addEventListener('change', () => {
            let mask = 0;
            row.querySelectorAll('input[data-bit]').forEach((c) => { if (c.checked) mask |= Number(c.dataset.bit); });
            boxes[i].armor = mask;
            refresh();
          });
        });
      });
      wrap.querySelectorAll('[data-preset]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const modo = btn.dataset.preset;
          boxes.forEach((b) => {
            if (modo === 'all') b.armor = 15;
            else if (modo === 'none') b.armor = 0;
            else b.armor = ARMOR_OF_TYPE[b.type] || 0;
          });
          renderEditor(skin);
        });
      });
    }

    // ---------- armadura del jugador: OFFSET + flags ----------
    const off = document.createElement('div');
    off.className = 'armor-offsets';
    off.innerHTML =
      '<div class="be-head"><span>Mover la armadura <code>OFFSET</code> (negativo = más arriba):</span></div>' +
      '<div class="off-grid">' +
        PIEZAS_ARMADURA.map(([tipo, txt]) =>
          '<label class="off"><span>' + txt + '</span>' +
          '<input type="number" step="1" inputmode="numeric" data-off="' + tipo + '" value="' +
          Math.round(Number((skin.offsets || {})[tipo]) || 0) + '"></label>').join('') +
      '</div>' +
      '<div class="be-flags">' +
        '<label class="arm"><input type="checkbox" id="hideArmorChk"' + (skin.hideArmor ? ' checked' : '') +
          '> Ocultar toda la armadura</label>' +
        '<label class="arm"><input type="checkbox" id="unfairChk"' + (skin.unfair ? ' checked' : '') +
          '> No válida en Battle Mode</label>' +
      '</div>' +
      '<div class="armor-hint">' +
        (skin.model3d
          ? 'Si la armadura se hunde en tu geometría, súbela con el valor de esa pieza (p. ej. casco <b>-2</b> en una cabeza de 10). Funciona desde <b>TU33</b> (TU58 para las partes base).'
          : 'El <code>OFFSET</code> mueve la armadura del jugador; se aplica a la skin aunque no tenga modelo.') +
      '</div>';
    host.appendChild(off);

    skin.offsets = skin.offsets || {};
    off.querySelectorAll('.off').forEach((fila) => {
      const inp = fila.querySelector('input[data-off]');
      fila.addEventListener('click', (ev) => {
        if (ev.target === inp) return;
        armorSeleccionada = armorSeleccionada === inp.dataset.off ? null : inp.dataset.off;
        const chkArmor = $('#showArmorChk');
        if (armorSeleccionada && chkArmor && !chkArmor.checked) {
          chkArmor.checked = true;
          state.showArmor = true;
        }
        if (repintar3D) repintar3D();
      });
    });
    off.querySelectorAll('input[data-off]').forEach((inp) => {
      inp.addEventListener('focus', () => { armorSeleccionada = inp.dataset.off; if (repintar3D) repintar3D(); });
      inp.addEventListener('change', () => {
        const v = Math.round(Number(inp.value) || 0);
        if (v) skin.offsets[inp.dataset.off] = v;
        else delete skin.offsets[inp.dataset.off];
        inp.value = String(v);
        render();
      });
    });
    const hideChk = off.querySelector('#hideArmorChk');
    if (hideChk) hideChk.addEventListener('change', () => { skin.hideArmor = hideChk.checked; render(); });
    const unfairChk = off.querySelector('#unfairChk');
    if (unfairChk) unfairChk.addEventListener('change', () => { skin.unfair = unfairChk.checked; render(); });
  }

  function openDoll(skin) {
    const overlay = $('#dollOverlay');
    overlay.classList.add('show', 'with-boxes');
    $('#dollName').textContent = skin.name || 'Skin';
    const c = $('#dollCanvas');
    const note = $('#dollNote');
    const boxes = skin.model3d ? skin.model3d.boxes : standardBoxesFor(skin);
    armorSeleccionada = null;

    const verArmadura = () => {
      const chk = $('#showArmorChk');
      return !!(chk && chk.checked);
    };

    const pintar = (sel) => {
      const chkB = $('#showBaseChk'), chkC = $('#showCapasChk');
      drawModel3D(c, skin, {
        boxes: boxes,
        selected: sel,
        base: chkB ? chkB.checked : true,
        capas: chkC ? chkC.checked : true,
        piezas: verArmadura() ? undefined : []   // la armadura solo si la pides
      });
      repintar3D = () => pintar(armorSeleccionada);
      document.querySelectorAll('input[data-off]').forEach((inp) => {
        const fila = inp.closest('.off');
        if (fila) fila.classList.toggle('sel', inp.dataset.off === sel);
      });
    };

    if (skin.model3d) {
      $('#dollMeta').textContent = skin.w + '×' + skin.h + ' · modelo 3D: ' + boxes.length +
        ' cajas · XMLVERSION ' + skin.model3d.xmlVersion;
      if (note) {
        const w = skin.model3d.warnings || [];
        note.innerHTML = (w.length
          ? '<b>Avisos del modelo</b><ul>' + w.slice(0, 6).map((x) => '<li>' + escapeHtml(x.text) + '</li>').join('') + '</ul>'
          : '') +
          '<span class="muted">Arrastra las piezas azules de la vista 3D para mover la armadura.</span>';
      }
    } else {
      $('#dollMeta').textContent = skin.w + '×' + skin.h + ' · ' + skin.model + ' · ' + humanSize(skin.png.length);
      if (note) {
        note.innerHTML = '<span class="muted">Vista 3D con el modelo estándar y su armadura. ' +
          'Añade un <code>.bbmodel</code> para geometría personalizada.</span>';
      }
    }

    const chk = $('#showArmorChk');
    if (chk) {
      chk.checked = !!state.showArmor;
      chk.onchange = () => {
        state.showArmor = chk.checked;
        pintar(armorSeleccionada);
        render();
      };
    }
    const chkBase = $('#showBaseChk');
    if (chkBase) {
      chkBase.checked = state.showBase !== false;
      chkBase.onchange = () => { state.showBase = chkBase.checked; pintar(armorSeleccionada); };
    }
    const chkCapas = $('#showCapasChk');
    if (chkCapas) {
      chkCapas.checked = state.showCapas !== false;
      chkCapas.onchange = () => { state.showCapas = chkCapas.checked; pintar(armorSeleccionada); };
    }

    renderEditor(skin);
    pintar(null);

    // arrastrar piezas de armadura
    initArmorDrag(c, skin, (tipo, valor, inicioArrastre) => {
      armorSeleccionada = tipo;
      if (inicioArrastre) {
        pintar(tipo);
        return;
      }
      skin.offsets = skin.offsets || {};
      if (valor) skin.offsets[tipo] = valor; else delete skin.offsets[tipo];
      const inp = document.querySelector('input[data-off="' + tipo + '"]');
      if (inp) inp.value = String(valor);
      pintar(tipo);
      render();
    });

    $('#dollClose').onclick = () => overlay.classList.remove('show');
    overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.remove('show'); };
  }


  /* ------------------------------ construir ----------------------------- */
  function buildPack() {
    const skins = state.skins.map((s) => ({
      id: s.id || undefined,
      name: s.name || 'Skin',
      theme: s.theme || '',
      png: s.png,
      anim: animFor(s),
      gameFlags: PCK.GAME_FLAGS.HUMAN,
      boxes: s.model3d ? s.model3d.boxes : null,
      xmlVersion: s.model3d ? s.model3d.xmlVersion : 0,
      offsets: s.offsets || null,
      hideArmor: !!s.hideArmor,
      unfair: !!s.unfair
    }));
    const packId = clampInt(state.packId, 0, 0x00ffffff, PCK.randomPackId());
    return PCK.buildSkinPack({
      packName: state.packName || 'Mi skin pack',
      packId: packId,
      packVersion: clampInt(state.packVersion, 0, 0xffffff, 0),
      skins: skins,
      littleEndian: state.target === 'modern',
      pckType: 3,
      xmlVersion: state.xmlVersion,
      locVersion: 2
    });
  }

  function clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function verify(bytes) {
    const p = PCK.readPck(bytes);
    const skins = p.assets.filter((a) => a.type === PCK.ASSET_TYPE.SkinFile);
    const ok = skins.length === state.skins.length;
    return {
      ok: ok,
      pck: p,
      text: ok
        ? '✓ Estructura verificada: ' + p.assets.length + ' archivos, ' + skins.length + ' skins, ' +
          (p.littleEndian ? 'little' : 'big') + ' endian, tipo ' + p.pckType
        : '✗ La verificación no cuadra'
    };
  }

  function download(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function safeFileName(name) {
    return (name || 'skinpack').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'skinpack';
  }

  /* -------------------------------- eventos ----------------------------- */
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(str) { return escapeHtml(str).replace(/\n/g, ' '); }

  let bbInput = null;
  let bbPendingKey = null;

  function pickBbModel(skin) {
    if (!bbInput) {
      bbInput = document.createElement('input');
      bbInput.type = 'file';
      bbInput.accept = '.bbmodel,application/json';
      bbInput.style.display = 'none';
      document.body.appendChild(bbInput);
      bbInput.addEventListener('change', async () => {
        const file = bbInput.files[0];
        bbInput.value = '';
        if (!file || !bbPendingKey) return;
        const skin = state.skins.find((x) => x.key === bbPendingKey);
        if (!skin) return;
        try {
          await applyBbModelToSkin(skin, file);
          render();
        } catch (err) {
          console.error(err);
          toast('<b>' + file.name + '</b>: ' + err.message, 'error');
        }
      });
    }
    bbPendingKey = skin.key;
    bbInput.click();
  }

  /** .bbmodel de ejemplo con la textura de la skin actual (o una plantilla vacía) */
  function exampleBbmodel(skin) {
    const w = skin ? skin.w : 64, h = skin ? skin.h : 64;
    const classic = h === 32;
    const tex = skin ? skin.thumbUrl : blankSkinDataUrl(64, 64);
    const name = (skin && skin.name) ? skin.name : 'Jugador';
    const nuevoUuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID()
      : 'u' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10));
    // desplegado estándar de caja (box UV): sin esto la textura se ve mal en Blockbench
    const caras = (from, to, uv) => {
      const w = Math.abs(to[0] - from[0]), h = Math.abs(to[1] - from[1]), d = Math.abs(to[2] - from[2]);
      const u = uv[0], v = uv[1];
      return {
        north: { uv: [u + d, v + d, u + d + w, v + d + h] },
        east: { uv: [u, v + d, u + d, v + d + h] },
        south: { uv: [u + d + w, v + d, u + 2 * d + w, v + d + h] },
        west: { uv: [u + 2 * d + w, v + d, u + 2 * (d + w), v + d + h] },
        up: { uv: [u + d, v, u + d + w, v + d] },
        down: { uv: [u + d + w, v, u + 2 * d + w, v + d] }
      };
    };
    const cubo = (nombre, from, to, uv, armor, inflate) => ({
      uuid: nuevoUuid(), type: 'cube',
      name: nombre, from, to, origin: [0, 24, 0], uv_offset: uv, box_uv: true,
      rotation: [0, 0, 0], inflate: inflate || 0, lce_armor: armor || 0,
      faces: caras(from, to, uv)
    });
    // en 64x32 el brazo y la pierna izquierdos reutilizan la textura del derecho
    const uvArm1 = classic ? [40, 16] : [32, 48];
    const uvLeg1 = classic ? [0, 16] : [16, 48];
    const elements = [
        cubo('head', [-4, 24, -4], [4, 32, 4], [0, 0], 0),
        cubo('hat', [-4, 24, -4], [4, 32, 4], [32, 0], 1, 0.5),
        cubo('body', [-4, 12, -2], [4, 24, 2], [16, 16], 0),
        cubo('jacket', [-4, 12, -2], [4, 24, 2], [16, 32], 2, 0.25),
        cubo('right_arm', [-8, 12, -2], [-4, 24, 2], [40, 16], 0),
        cubo('right_sleeve', [-8, 12, -2], [-4, 24, 2], [40, 32], 2, 0.25),
        cubo('left_arm', [4, 12, -2], [8, 24, 2], uvArm1, 0),
        cubo('left_sleeve', [4, 12, -2], [8, 24, 2], [48, 48], 2, 0.25),
        cubo('right_leg', [-4, 0, -2], [0, 12, 2], [0, 16], 0),
        cubo('right_pants', [-4, 0, -2], [0, 12, 2], [0, 32], 4, 0.25),
        cubo('left_leg', [0, 0, -2], [4, 12, 2], uvLeg1, 0),
        cubo('left_pants', [0, 0, -2], [4, 12, 2], [0, 48], 4, 0.25)
    ];
    // carpetas del outliner, como el modelo de jugador de Blockbench
    const carpetas = {
      head: ['head', 'hat'], body: ['body', 'jacket'],
      right_arm: ['right_arm', 'right_sleeve'], left_arm: ['left_arm', 'left_sleeve'],
      right_leg: ['right_leg', 'right_pants'], left_leg: ['left_leg', 'left_pants']
    };
    const grupos = Object.keys(carpetas).map((nombre) => ({
      uuid: nuevoUuid(),
      name: nombre,
      origin: [0, 24, 0],
      rotation: [0, 0, 0],
      children: elements.filter((e) => carpetas[nombre].includes(e.name)).map((e) => e.uuid)
    }));
    return {
      meta: { format_version: '5.0', model_format: 'java_block', box_uv: true },
      name: name + ' (modelo)',
      resolution: { width: w, height: h },
      // Blockbench 5.0: datos del grupo en `groups`, árbol en `outliner`
      groups: grupos.map((g) => ({ uuid: g.uuid, name: g.name, origin: g.origin, rotation: [0, 0, 0] })),
      elements: elements,
      outliner: grupos.map((g) => ({ uuid: g.uuid, isOpen: true, children: g.children })),
      textures: [{
        name: safeFileName(name) + '.png', id: '0', source: tex,
        uv_width: w, uv_height: h, particle: false
      }],
      lce: {
        nota: 'Modelo de ejemplo de SkinForge. Renombra los cubos como head, hat, body, jacket, right_arm, right_sleeve, left_arm, left_sleeve, right_leg, right_pants, left_leg, left_pants.',
        armor_hint: 'lce_armor: 1 casco · 2 peto · 4 gregüesco · 8 botas (se suman)'
      }
    };
  }

  function blankSkinDataUrl(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return canvasToUrl(c);
  }

  function downloadExampleModel() {
    const skin = state.skins.find((x) => x.model3d) || state.skins[0] || null;
    const json = exampleBbmodel(skin);
    const nombre = safeFileName(skin ? skin.name : 'jugador-estandar') + '-modelo.bbmodel';
    download(new TextEncoder().encode(JSON.stringify(json, null, '\t')), nombre);
    toast('Descargado <b>' + nombre + '</b>: ábrelo en Blockbench, edítalo y vuelve a soltarlo aquí', 'ok');
  }

  function dataUrlToBlob(url) {
    const comma = url.indexOf(',');
    const head = url.slice(0, comma);
    const b64 = url.slice(comma + 1);
    const mime = (/data:([^;]+)/.exec(head) || [])[1] || 'image/png';
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }

  function init() {
    initTabs();
    initTex();

    // dropzone + input
    const input = $('#fileInput');
    $('#pickBtn').addEventListener('click', () => input.click());
    input.addEventListener('change', () => { handleFiles(input.files); input.value = ''; });

    const dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.remove('over');
    }));
    dz.addEventListener('drop', (e) => { if (e.dataTransfer) handleFiles(e.dataTransfer.files); });

    // drop en toda la ventana
    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      if (texActive()) return; // la pestaña de texturas ya gestiona su propio drop
      handleFiles(e.dataTransfer.files);
    });

    // ajustes del pack
    $('#packName').addEventListener('input', (e) => { state.packName = e.target.value; });
    $('#packId').addEventListener('change', (e) => {
      state.packId = clampInt(e.target.value, 0, 0x00ffffff, PCK.randomPackId());
      e.target.value = state.packId;
    });
    $('#packVersion').addEventListener('change', (e) => {
      state.packVersion = clampInt(e.target.value, 0, 0xffffff, 0);
      e.target.value = state.packVersion;
    });
    $('#rerollId').addEventListener('click', () => {
      state.packId = PCK.randomPackId();
      $('#packId').value = state.packId;
    });
    $$('input[name="target"]').forEach((r) => r.addEventListener('change', () => {
      state.target = r.value;
      renderSummary();
    }));
    $('#resolution').addEventListener('change', (e) => {
      state.resolution = e.target.value;
      toast('La resolución se aplica a las skins que añadas a partir de ahora.', 'info');
    });
    $('#xmlVersion').addEventListener('change', (e) => { state.xmlVersion = Number(e.target.value); });

    // acciones
    $('#buildTestBtn').addEventListener('click', () => {
      const built = buildPack();
      const v = verify(built.bytes);
      toast(v.text + ' · ' + humanSize(built.bytes.length), v.ok ? 'ok' : 'error');
      showLog(built, v);
    });

    $('#downloadBtn').addEventListener('click', () => {
      if (!state.skins.length) { toast('Añade al menos una skin', 'warn'); return; }
      const built = buildPack();
      const v = verify(built.bytes);
      if (!v.ok) { toast(v.text, 'error'); return; }
      state.lastBuild = built;
      const fname = safeFileName(state.packName) + '.pck';
      download(built.bytes, fname);
      showLog(built, v);
      toast('Descargado <b>' + fname + '</b> (' + humanSize(built.bytes.length) + ')', 'ok');
    });

    const ejemploBtn = $('#exampleModelBtn');
    if (ejemploBtn) ejemploBtn.addEventListener('click', downloadExampleModel);

    $('#clearBtn').addEventListener('click', () => {
      if (!state.skins.length) return;
      if (!confirm('¿Vaciar la lista de skins?')) return;
      state.skins = [];
      render();
    });

    // navegación suave
    $$('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => {
      const el = document.querySelector(a.getAttribute('href'));
      if (!el) return;
      e.preventDefault();
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));

    render();
  }

  function showLog(built, v) {
    const wrap = $('#logWrap');
    const p = v.pck;
    const rows = p.assets.map((a) => {
      const params = a.params.map((x) => x[0] + '=' + x[1]).join(' · ');
      return '<div class="log-row">' +
        '<div class="log-name"><code>' + escapeHtml(a.filename) + '</code>' +
        '<span class="t">tipo ' + a.type + ' · ' + humanSize(a.data.length) + '</span></div>' +
        (params ? '<div class="log-params">' + escapeHtml(params) + '</div>' : '') +
        '</div>';
    }).join('');
    wrap.innerHTML = `
      <div class="log-head">
        <strong>${v.ok ? '✓' : '✗'} ${escapeHtml(v.text)}</strong>
        <span class="muted">PCK tipo ${p.pckType} · XMLVERSION ${p.xmlVersion} · ${p.assets.length} entradas · ${humanSize(built.bytes.length)}</span>
      </div>
      <div class="log-rows">${rows}</div>`;
    wrap.classList.add('show');
  }



  /* ============================================================
     MODELOS 3D (.bbmodel de Blockbench → parámetros BOX de LCE)
     ============================================================ */

  const BOX_ALIASES = {
    // inglés (Java / Blockbench)
    head: 'HEAD', headwear: 'HEADWEAR', hat: 'HEADWEAR', helmet: 'HEADWEAR', headoverlay: 'HEADWEAR',
    body: 'BODY', torso: 'BODY', chest: 'BODY', upperbody: 'BODY',
    jacket: 'JACKET', bodyoverlay: 'JACKET', torsooverlay: 'JACKET',
    waist: 'WAIST', hips: 'WAIST',
    arm0: 'ARM0', rightarm: 'ARM0', armright: 'ARM0', rarm: 'ARM0',
    arm1: 'ARM1', leftarm: 'ARM1', armleft: 'ARM1', larm: 'ARM1',
    sleeve0: 'SLEEVE0', rightsleeve: 'SLEEVE0', rightsleeveoverlay: 'SLEEVE0',
    sleeve1: 'SLEEVE1', leftsleeve: 'SLEEVE1', leftsleeveoverlay: 'SLEEVE1',
    leg0: 'LEG0', rightleg: 'LEG0', legright: 'LEG0', rleg: 'LEG0',
    leg1: 'LEG1', leftleg: 'LEG1', legleft: 'LEG1', lleg: 'LEG1',
    pants0: 'PANTS0', rightpants: 'PANTS0', rightlegpants: 'PANTS0',
    pants1: 'PANTS1', leftpants: 'PANTS1', leftlegpants: 'PANTS1',
    bodyarmor: 'BODYARMOR', belt: 'BELT',
    rightpad: 'ARM0', leftpad: 'ARM1', rightshoulder: 'ARM0', leftshoulder: 'ARM1',
    shoulderpad: 'ARM0', pad0: 'ARM0', pad1: 'ARM1',
    crest: 'HEADWEAR', cresta: 'HEADWEAR', plume: 'HEADWEAR', plume2: 'HEADWEAR',
    armarmor0: 'ARMARMOR0', rightarmarmor: 'ARMARMOR0',
    armarmor1: 'ARMARMOR1', leftarmarmor: 'ARMARMOR1',
    sock0: 'SOCK0', rightsock: 'SOCK0', sock1: 'SOCK1', leftsock: 'SOCK1',
    boot0: 'BOOT0', rightboot: 'BOOT0', boot1: 'BOOT1', leftboot: 'BOOT1',
    legging0: 'LEGGING0', rightlegging: 'LEGGING0', legging1: 'LEGGING1', leftlegging: 'LEGGING1',
    // castellano, por si el modelo está nombrado así
    cabeza: 'HEAD', sombrero: 'HEADWEAR', cuerpo: 'BODY', torso2: 'BODY', chaqueta: 'JACKET',
    cintura: 'WAIST', brazo0: 'ARM0', brazoderecho: 'ARM0', brazoder: 'ARM0',
    brazo1: 'ARM1', brazoizquierdo: 'ARM1', brazoizq: 'ARM1',
    manga0: 'SLEEVE0', manga1: 'SLEEVE1',
    pierna0: 'LEG0', piernaderecha: 'LEG0', piernader: 'LEG0',
    pierna1: 'LEG1', piernaizquierda: 'LEG1', piernaizq: 'LEG1',
    pantalon0: 'PANTS0', pantalon1: 'PANTS1'
  };

  function normName(str) {
    return String(str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  }

  function guessBoxType(cubeName) {
    const n = normName(cubeName);
    if (!n) return null;
    if (BOX_ALIASES[n]) return BOX_ALIASES[n];
    // heurísticas por subcadena, de lo más específico a lo más genérico
    const has = (w) => n.includes(w);
    const left = has('left') || has('izq');
    const right = has('right') || has('der') || !left;
    if (has('headwear') || has('hat') || has('sombrero') || has('crest') || has('cresta') || has('plume') ||
        (has('head') && has('overlay'))) return 'HEADWEAR';
    if (has('head') || has('cabeza')) return 'HEAD';
    if (has('jacket') || has('chaqueta') || (has('body') && has('overlay'))) return 'JACKET';
    if (has('waist') || has('cintura')) return 'WAIST';
    if (has('body') || has('torso') || has('cuerpo')) return 'BODY';
    // hombreras y similares: se dibujan como una caja más del brazo
    if (has('pad') || has('shoulder') || has('hombro')) return left ? 'ARM1' : 'ARM0';
    if (has('sleeve') || has('manga')) return left ? 'SLEEVE1' : 'SLEEVE0';
    if (has('arm') || has('brazo')) return left ? 'ARM1' : 'ARM0';
    if (has('pants') || has('pantalon')) return left ? 'PANTS1' : 'PANTS0';
    if (has('leg') || has('pierna')) return left ? 'LEG1' : 'LEG0';
    return null;
  }

  /** qué pieza de armadura oculta cada tipo de caja (comportamiento de Java) */
  const ARMOR_OF_TYPE = {
    HEADWEAR: 1,              // casco
    JACKET: 2, SLEEVE0: 2, SLEEVE1: 2, BODYARMOR: 2, ARMARMOR0: 2, ARMARMOR1: 2, BELT: 6,
    PANTS0: 4, PANTS1: 4, LEGGING0: 4, LEGGING1: 4, SOCK0: 12, SOCK1: 12,
    BOOT0: 8, BOOT1: 8
  };

  /** tamaño estándar de cada parte: la armadura se dibuja EN ESTE tamaño */
  const STANDARD_SIZE = {
    HEAD: [8, 8, 8], HEADWEAR: [8, 8, 8],
    BODY: [8, 12, 4], JACKET: [8, 12, 4], WAIST: [8, 4, 4], BODYARMOR: [8, 12, 4], BELT: [8, 1, 4],
    ARM0: [4, 12, 4], ARM1: [4, 12, 4], SLEEVE0: [4, 12, 4], SLEEVE1: [4, 12, 4],
    ARMARMOR0: [4, 12, 4], ARMARMOR1: [4, 12, 4],
    LEG0: [4, 12, 4], LEG1: [4, 12, 4], PANTS0: [4, 12, 4], PANTS1: [4, 12, 4],
    LEGGING0: [4, 12, 4], LEGGING1: [4, 12, 4], SOCK0: [4, 12, 4], SOCK1: [4, 12, 4],
    BOOT0: [4, 12, 4], BOOT1: [4, 12, 4]
  };

  /** pieza de armadura que "tapa" cada parte base (para el aviso) */
  const ARMOR_FOR_PART = { HEAD: 1, BODY: 2, ARM0: 2, ARM1: 2, LEG0: 4, LEG1: 4 };

  const AUTO_INFLATE = { HEADWEAR: 0.5, JACKET: 0.25, SLEEVE0: 0.25, SLEEVE1: 0.25, PANTS0: 0.25, PANTS1: 0.25, WAIST: 0.25 };

  function parseBbModel(text) {
    let json;
    try { json = JSON.parse(text); } catch (e) { throw new Error('El .bbmodel no es un JSON válido'); }
    const elements = Array.isArray(json.elements) ? json.elements : [];
    if (!elements.length) throw new Error('El .bbmodel no tiene cubos (elements)');
    let textureUrl = null;
    const textures = Array.isArray(json.textures) ? json.textures : [];
    const withImage = textures.find((t) => t && typeof t.source === 'string' && t.source.startsWith('data:image'));
    if (withImage) textureUrl = withImage.source;
    const conNombre = textures.find((t) => t && typeof t.name === 'string' && /\.(png|jpe?g)$/i.test(t.name));
    const textureName = conNombre ? conNombre.name : (textures[0] && textures[0].name) || null;
    // carpetas del outliner: uuid del cubo -> nombre del grupo más cercano.
    // Se aceptan los tres esquemas que existen:
    //   5.0  → outliner con {uuid, isOpen, children} + names en `groups`
    //   4.x  → outliner con el grupo entero en línea (name incluido)
    //   viejo → groups[].children con los uuid de los cubos
    const defs = {};
    (Array.isArray(json.groups) ? json.groups : []).forEach((g) => {
      if (g && g.uuid) defs[g.uuid] = g.name || '';
    });
    const groupOf = {};
    const nombres = [];
    const walk = (nodo, padre) => {
      if (typeof nodo === 'string') {
        if (padre) groupOf[nodo] = padre;
        return;
      }
      if (!nodo || typeof nodo !== 'object') return;
      const nombre = nodo.name || defs[nodo.uuid] || padre || '';
      if (nodo.name || defs[nodo.uuid]) nombres.push(nombre);
      (nodo.children || []).forEach((hijo) => {
        if (typeof hijo === 'string' && nombre) groupOf[hijo] = nombre;
        else walk(hijo, nombre);
      });
    };
    (Array.isArray(json.outliner) ? json.outliner : []).forEach((n) => walk(n, ''));
    (Array.isArray(json.groups) ? json.groups : []).forEach((g) => {
      (g.children || []).forEach((c) => {
        if (typeof c === 'string' && !groupOf[c]) groupOf[c] = g.name || '';
      });
    });
    return {
      name: json.name || '',
      resolution: json.resolution || null,
      elements: elements,
      textureUrl: textureUrl,
      textureName: textureName,
      hasEmbeddedTexture: !!textureUrl,
      groupOf: groupOf,
      groupNames: nombres.filter(Boolean)
    };
  }

  /** convierte un .bbmodel a cajas BOX de LCE */
  function bbToBoxes(parsed, skin) {
    const warnings = [];
    const boxes = [];
    const usedTypes = {};
    let needsV3 = false;
    let slim = false;
    let hasArmorHint = false;

    parsed.elements.forEach((el) => {
      const name = el.name || '';
      const grupo = (parsed.groupOf && parsed.groupOf[el.uuid]) || '';
      const type = guessBoxType(name) || (grupo ? guessBoxType(grupo) : null);
      if (!type) {
        warnings.push({
          level: 'warn',
          text: 'Cubo «' + (name || 'sin nombre') + '»' + (grupo ? ' (grupo «' + grupo + '»)' : '') +
            ': no corresponde a ninguna parte del jugador (se ignora)'
        });
        return;
      }
      const from = el.from, to = el.to;
      if (!Array.isArray(from) || !Array.isArray(to)) {
        warnings.push({ level: 'warn', text: 'Cubo «' + name + '»: no tiene from/to (se ignora)' });
        return;
      }
      const rot = el.rotation;
      if (Array.isArray(rot) && rot.some((v) => Math.abs(v) > 0.001)) {
        warnings.push({ level: 'warn', text: 'Cubo «' + name + '»: tiene rotación; LCE no puede rotar cajas (se coloca sin rotar)' });
      }
      // el juego trunca posiciones y tamaños a enteros: redondeamos ya aquí
      const rawMin = [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.min(from[2], to[2])];
      const rawMax = [Math.max(from[0], to[0]), Math.max(from[1], to[1]), Math.max(from[2], to[2])];
      const min = rawMin.map(Math.round);
      const max = rawMax.map(Math.round);
      if (min.some((v, i) => Math.abs(v - rawMin[i]) > 1e-6) || max.some((v, i) => Math.abs(v - rawMax[i]) > 1e-6)) {
        warnings.push({ level: 'info', text: 'Cubo «' + name + '»: valores con decimales, LCE los trunca a enteros (se redondea)' });
      }
      const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
      if (size.some((v) => v <= 0)) {
        warnings.push({ level: 'warn', text: 'Cubo «' + name + '»: tamaño 0 (se ignora)' });
        return;
      }
      if ((type === 'ARM0' || type === 'ARM1') && Math.round(size[0]) === 3) slim = true;

      let uv = el.uv_offset;
      if (!Array.isArray(uv) || el.box_uv === false) {
        // UV por cara: aproximamos con la esquina mínima de las caras
        const faces = el.faces || {};
        let minU = Infinity, minV = Infinity;
        Object.keys(faces).forEach((k) => {
          const f = faces[k];
          if (f && Array.isArray(f.uv) && f.uv.length === 4) {
            minU = Math.min(minU, f.uv[0], f.uv[2]);
            minV = Math.min(minV, f.uv[1], f.uv[3]);
          }
        });
        if (isFinite(minU) && isFinite(minV)) {
          uv = [minU, minV];
          warnings.push({ level: 'info', text: 'Cubo «' + name + '»: UV por cara, se aproxima con la esquina ' + minU + ',' + minV });
        } else {
          uv = [0, 0];
          warnings.push({ level: 'warn', text: 'Cubo «' + name + '»: sin UV, se usa 0,0' });
        }
      }

      // por defecto, las capas overlay se ocultan con la armadura igual que en Java
      // el .bbmodel puede traer su propia máscara en `lce_armor` (lo usan los ejemplos)
      const armored = el.lce_armor == null ? null : Number(el.lce_armor);
      const armor = armored != null && isFinite(armored) ? (armored | 0) : (ARMOR_OF_TYPE[type] || 0);
      if (armored != null) hasArmorHint = true;
      const std = STANDARD_SIZE[type];
      if (std && (Math.round(size[0]) > std[0] || Math.round(size[1]) > std[1] || Math.round(size[2]) > std[2])) {
        const pieza = ARMOR_FOR_PART[type];
        warnings.push({
          level: 'info',
          text: 'Caja «' + name + '» (' + type + ') es más grande que la estándar (' + std.join('×') +
            '): la armadura se dibuja en el modelo estándar y quedará dentro' +
            (pieza ? ' — puede ocultarla con la pieza de armadura en el editor de cajas' : '')
        });
      }

      const inflate = Number(el.inflate) || 0;
      const auto = AUTO_INFLATE[type] || 0;
      if (inflate && Math.abs(inflate - auto) > 0.001) needsV3 = true;

      if (usedTypes[type]) {
        warnings.push({ level: 'info', text: 'Cubo «' + name + '»: segunda caja del tipo ' + type + ' (se añade como caja extra)' });
      }
      usedTypes[type] = true;

      boxes.push({ el, type, min, max, uv, inflate, name: name || grupo, armor, grupo });
    });

    if (!boxes.length) throw new Error('Ningún cubo del modelo coincide con una parte del jugador');

    // 64x32: las cajas izquierdas reutilizan la textura y van espejadas
    const classic = skin && skin.h === 32;

    const finalBoxes = boxes.map((b) => {
      const pivot = PCK.BOX_PIVOT[b.type];
      // con XMLVERSION 3 las cajas overlay ya no se inflan solas: escribimos su
      // inflado estándar (0.5 sombrero, 0.25 resto) si el modelo no trae otro
      const inflate = needsV3 ? (b.inflate || AUTO_INFLATE[b.type] || 0) : 0;
      const box = PCK.cubeToBox(b.type, b.min, b.max, b.uv, {
        armor: b.armor,
        inflate: inflate,
        mirror: classic && (b.type === 'ARM1' || b.type === 'LEG1' || b.type === 'SLEEVE1' || b.type === 'PANTS1')
      });
      if (classic && (b.type === 'ARM1' || b.type === 'SLEEVE1')) box.uv = [40, 16];
      if (classic && (b.type === 'LEG1' || b.type === 'PANTS1')) box.uv = [0, 16];
      void pivot;
      return { box: box, name: b.name, type: b.type, grupo: b.grupo };
    });

    return {
      boxes: finalBoxes.map((f) => f.box),
      parts: finalBoxes.map((f) => ({ type: f.type, name: f.name, grupo: f.grupo })),
      warnings: warnings,
      xmlVersion: needsV3 ? 3 : 2,
      slim: slim,
      hasArmorHint: hasArmorHint
    };
  }

  async function applyBbModelToSkin(skin, file) {
    const text = await file.text();
    const parsed = parseBbModel(text);
    const res = bbToBoxes(parsed, skin);
    skin.model3d = {
      fileName: file.name,
      boxes: res.boxes,
      armorHint: !!res.hasArmorHint,
      parts: res.parts,
      warnings: res.warnings,
      xmlVersion: res.xmlVersion,
      cubes: parsed.elements.length
    };
    if (res.slim && skin.model === 'wide') skin.model = 'slim';
    if (!res.slim && skin.model === 'slim') skin.model = 'wide';
    toast('Modelo <b>' + escapeHtml(file.name) + '</b>: ' + res.boxes.length + ' cajas · XMLVERSION ' + res.xmlVersion, 'ok');
    if (res.warnings.length) toast(res.warnings.length + ' aviso(s) del modelo: <span class="muted">' + escapeHtml(res.warnings[0].text) + '</span>', 'warn');
    return { skin, parsed, res };
  }

  /* ------------------------- vista 3D (isométrica) ----------------------- */
  /** cajas estándar de armadura (se usan si el modelo no trae esa parte) */
  const ARMOR_STD = {
    HELMET: [[-4.5, 23.5, -4.5], [4.5, 32.5, 4.5]],
    CHEST: [[-4.75, 11.25, -2.75], [4.75, 24.25, 2.75]],
    SHOULDER0: [[-8.75, 11.5, -2.75], [-3.4, 20, 2.75]],
    SHOULDER1: [[3.4, 11.5, -2.75], [8.75, 20, 2.75]],
    WAIST: [[-4.5, 11.5, -2.5], [4.5, 16.5, 2.5]],
    PANTS0: [[-4.4, -0.4, -2.4], [0.4, 11.6, 2.4]],
    PANTS1: [[-0.4, -0.4, -2.4], [4.4, 11.6, 2.4]],
    BOOT0: [[-4.5, -0.5, -2.5], [0.5, 4, 2.5]],
    BOOT1: [[-0.5, -0.5, -2.5], [4.5, 4, 2.5]]
  };

  /** a qué parte de la skin corresponde cada pieza de armadura */
  const ARMOR_SOURCE = {
    HELMET: 'HEAD', CHEST: 'BODY', WAIST: 'BODY',
    SHOULDER0: 'ARM0', SHOULDER1: 'ARM1',
    PANTS0: 'LEG0', PANTS1: 'LEG1', BOOT0: 'LEG0', BOOT1: 'LEG1'
  };

  /** las 12 cajas del jugador estándar (para poder mover la armadura en cualquier skin) */
  function standardBoxesFor(skin) {
    const slim = skin.model === 'slim';
    const classic = skin.model === 'classic' || skin.h === 32;
    const anchoBrazo = slim ? 3 : 4;
    const lista = [
      ['HEAD', [-4, 24, -4], [4, 32, 4], [0, 0], 0],
      ['HEADWEAR', [-4, 24, -4], [4, 32, 4], [32, 0], 1],
      ['BODY', [-4, 12, -2], [4, 24, 2], [16, 16], 0],
      ['JACKET', [-4, 12, -2], [4, 24, 2], [16, 32], 2],
      ['ARM0', [-4 - anchoBrazo, 12, -2], [-4, 24, 2], [40, 16], 0],
      ['SLEEVE0', [-4 - anchoBrazo, 12, -2], [-4, 24, 2], [40, 32], 2],
      ['ARM1', [4, 12, -2], [4 + anchoBrazo, 24, 2], classic ? [40, 16] : [32, 48], 0],
      ['SLEEVE1', [4, 12, -2], [4 + anchoBrazo, 24, 2], [48, 48], 2],
      ['LEG0', [-4, 0, -2], [0, 12, 2], [0, 16], 0],
      ['PANTS0', [-4, 0, -2], [0, 12, 2], [0, 32], 4],
      ['LEG1', [0, 0, -2], [4, 12, 2], classic ? [0, 16] : [16, 48], 0],
      ['PANTS1', [0, 0, -2], [4, 12, 2], [0, 48], 4]
    ];
    return lista.map(([type, min, max, uv, armor]) => PCK.cubeToBox(type, min, max, uv, {
      armor: armor,
      mirror: classic && /^(ARM1|LEG1|SLEEVE1|PANTS1)$/.test(type)
    }));
  }

  /** caja de la pieza de armadura en coordenadas del modelo (y arriba) */
  function armorPieceBox(tipo, boxes) {
    const base = ARMOR_SOURCE[tipo];
    const deLaSkin = (boxes || []).filter((b) => b.type === base)
      .map((b) => PCK.boxToModelSpace(b))[0];
    if (!deLaSkin) return ARMOR_STD[tipo];
    const inf = 0.6;
    let min = [deLaSkin.min[0] - inf, deLaSkin.min[1] - inf, deLaSkin.min[2] - inf];
    let max = [deLaSkin.max[0] + inf, deLaSkin.max[1] + inf, deLaSkin.max[2] + inf];
    if (tipo === 'BOOT0' || tipo === 'BOOT1') max = [max[0], deLaSkin.min[1] + 4, max[2]];
    if (tipo === 'WAIST') min = [min[0], deLaSkin.max[1] - 5, min[2]];
    if (tipo === 'SHOULDER0' || tipo === 'SHOULDER1') max = [max[0], deLaSkin.max[1] - 3, max[2]];
    return [min, max];
  }

  /**
   * Vista 3D isométrica con la skin y, encima, las piezas de armadura.
   * Deja en canvas._lce3d lo necesario para poder arrastrarlas.
   */
  function drawModel3D(canvas, skin, opts) {
    opts = opts || {};
    const boxes = opts.boxes || (skin.model3d ? skin.model3d.boxes : []);
    const scale = 9;
    const W = 420, H = 420;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    canvas._lce3d = null;
    if (!boxes.length) return;

    const yaw = Math.PI - 0.6, pitch = 0.34;   // de frente: se ve la cara y el lado derecho
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
    const cx = 8, cy = 16;
    const project = (x, y, z) => {
      const px = x - cx, py = y - cy, pz = z;
      const rx = px * cosY - pz * sinY;
      const rz = px * sinY + pz * cosY;
      const ry = py * cosP - rz * sinP;
      const depth = rz * cosP + py * sinP;
      return { x: W / 2 + rx * scale, y: H / 2 - ry * scale, depth: depth };
    };

    const img = new Image();
    img.onload = () => {
      const off = document.createElement('canvas');
      off.width = img.width; off.height = img.height;
      const octx = off.getContext('2d');
      octx.imageSmoothingEnabled = false;
      octx.drawImage(img, 0, 0);
      let pixels = null;
      try { pixels = octx.getImageData(0, 0, off.width, off.height).data; } catch (e) { pixels = null; }
      /** color medio y alfa media de un trozo de textura (alfa 0 = transparente) */
      const media = (u, v, w, h) => {
        if (!pixels) return { r: 150, g: 150, b: 150, a: 1 };
        let r = 0, g = 0, b = 0, n = 0, aSum = 0, total = 0;
        const x0 = Math.max(0, Math.floor(u)), y0 = Math.max(0, Math.floor(v));
        const x1 = Math.min(off.width - 1, Math.ceil(u + w)), y1 = Math.min(off.height - 1, Math.ceil(v + h));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const o = (y * off.width + x) * 4;
            const a = pixels[o + 3];
            aSum += a; total++;
            if (a < 12) continue;
            r += pixels[o]; g += pixels[o + 1]; b += pixels[o + 2]; n++;
          }
        }
        if (!n) return { r: 0, g: 0, b: 0, a: 0 };
        return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), a: total ? aSum / total / 255 : 1 };
      };

      /**
       * Rectángulo de textura de cada cara (desplegado estándar de caja):
       *   [este][norte][oeste][sur]  arriba de todo, y [arriba][abajo] encima.
       *   x: 0..2(d+w)   y: 0..d+h
       */
      const carasUV = (uv, w, h, d) => {
        const u = uv[0], v = uv[1];
        return {
          east: [u, v + d, d, h],
          north: [u + d, v + d, w, h],
          west: [u + d + w, v + d, d, h],
          south: [u + 2 * d + w, v + d, w, h],
          up: [u + d, v, w, d],
          down: [u + d + w, v, w, d]
        };
      };

      // cada cara: esquina de origen + vector U + vector V (en el modelo, y arriba)
      const CARAS = [
        { key: 'north', shade: 0.92, o: (b) => [b[1][0], b[1][1], b[0][2]], u: (b) => [b[0][0] - b[1][0], 0, 0], v: (b) => [0, b[0][1] - b[1][1], 0] },
        { key: 'south', shade: 0.78, o: (b) => [b[0][0], b[1][1], b[1][2]], u: (b) => [b[1][0] - b[0][0], 0, 0], v: (b) => [0, b[0][1] - b[1][1], 0] },
        { key: 'east', shade: 0.86, o: (b) => [b[1][0], b[1][1], b[1][2]], u: (b) => [0, 0, b[0][2] - b[1][2]], v: (b) => [0, b[0][1] - b[1][1], 0] },
        { key: 'west', shade: 0.86, o: (b) => [b[0][0], b[1][1], b[0][2]], u: (b) => [0, 0, b[1][2] - b[0][2]], v: (b) => [0, b[0][1] - b[1][1], 0] },
        { key: 'up', shade: 1.0, o: (b) => [b[0][0], b[1][1], b[0][2]], u: (b) => [b[1][0] - b[0][0], 0, 0], v: (b) => [0, 0, b[1][2] - b[0][2]] },
        { key: 'down', shade: 0.66, o: (b) => [b[0][0], b[0][1], b[1][2]], u: (b) => [b[1][0] - b[0][0], 0, 0], v: (b) => [0, 0, b[0][2] - b[1][2]] }
      ];

      /** pinta un trozo de textura deformado sobre un cuadrilátero en pantalla */
      const pintarCara = (pts, sx, sy, sw, sh, shade) => {
        if (sw <= 0 || sh <= 0 || !pixels) return false;
        const p0 = pts[0], p1 = pts[1], p3 = pts[3];
        ctx.save();
        ctx.beginPath();
        pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.closePath();
        ctx.clip();
        ctx.transform((p1.x - p0.x) / sw, (p1.y - p0.y) / sw, (p3.x - p0.x) / sh, (p3.y - p0.y) / sh, p0.x, p0.y);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, sx, sy, Math.max(0.01, sw), Math.max(0.01, sh), 0, 0, sw, sh);
        if (shade < 1) {
          ctx.fillStyle = 'rgba(0,0,0,' + (1 - shade).toFixed(2) + ')';
          ctx.fillRect(0, 0, sw, sh);
        }
        ctx.restore();
        return true;
      };

      /** las cuatro esquinas de una cara de la caja b (en espacio del modelo) */
      const esquinas = (c, b) => {
        const o = c.o(b), du = c.u(b), dv = c.v(b);
        return [o,
          [o[0] + du[0], o[1] + du[1], o[2] + du[2]],
          [o[0] + du[0] + dv[0], o[1] + du[1] + dv[1], o[2] + du[2] + dv[2]],
          [o[0] + dv[0], o[1] + dv[1], o[2] + dv[2]]];
      };

      const faces = [];

      // --- skin: base y capas por separado ---
      const dibujadas = { base: 0, capas: 0, armadura: 0 };
      boxes.forEach((box) => {
        const esCapa = PCK.OVERLAY_BOX_TYPES.indexOf(box.type) >= 0;
        if (esCapa && opts.capas === false) return;
        if (!esCapa && opts.base === false) return;
        dibujadas[esCapa ? 'capas' : 'base']++;
        const ms = PCK.boxToModelSpace(box);
        const inf = (box.inflate || 0) / 2;
        const b = [[ms.min[0] - inf, ms.min[1] - inf, ms.min[2] - inf], [ms.max[0] + inf, ms.max[1] + inf, ms.max[2] + inf]];
        const w = ms.max[0] - ms.min[0], h = ms.max[1] - ms.min[1], d = ms.max[2] - ms.min[2];
        const uvs = carasUV(box.uv, w, h, d);
        CARAS.forEach((c) => {
          const pts = esquinas(c, b).map((q) => project(q[0], q[1], q[2]));
          const rect = uvs[c.key];
          const col = media(rect[0], rect[1], rect[2], rect[3]);
          if (col.a <= 0.02) return;                       // cara transparente
          faces.push({
            pts: pts,
            depth: pts.reduce((a, q) => a + q.depth, 0) / 4,
            tex: rect,
            shade: c.shade,
            stroke: 'rgba(6,10,18,' + (esCapa ? 0.22 : 0.5) + ')'
          });
        });
      });

      // --- armadura (encima, semitransparente y arrastrable) ---
      const piezas = [];
      const offsets = skin.offsets || {};
      const listaPiezas = Array.isArray(opts.piezas) ? opts.piezas : Object.keys(ARMOR_STD);
      listaPiezas.forEach((tipo) => {
        const off = -(Number(offsets[tipo]) || 0);   // OFFSET negativo = más arriba
        const alto = ARMOR_STD[tipo] ? (armorPieceBox(tipo, boxes)[1][1] - armorPieceBox(tipo, boxes)[0][1]) : 0;
        const base = [];
        base[0] = b0(tipo, boxes)[0].map((v, i) => (i === 1 ? v + off : v));
        base[1] = b0(tipo, boxes)[1].map((v, i) => (i === 1 ? v + off : v));
        void alto;
        const sel = opts.selected === tipo;
        const color = sel ? [255, 186, 84] : [148, 178, 224];
        const alpha = sel ? 0.30 : 0.13;
        const proyectadas = [];
        CARAS.forEach((c) => {
          const pts = esquinas(c, base).map((q) => project(q[0], q[1], q[2]));
          proyectadas.push(pts);
          faces.push({
            pts: pts,
            depth: pts.reduce((a, q) => a + q.depth, 0) / 4 - 0.001,
            solid: true,
            fill: 'rgba(' + Math.round(color[0] * c.shade) + ',' + Math.round(color[1] * c.shade) + ',' + Math.round(color[2] * c.shade) + ',' + alpha + ')',
            stroke: sel ? 'rgba(255,196,110,0.95)' : 'rgba(148,178,224,0.62)'
          });
        });
        dibujadas.armadura++;
        const xs = proyectadas.flat().map((q) => q.x), ys = proyectadas.flat().map((q) => q.y);
        piezas.push({
          tipo: tipo,
          x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs),
          y0: Math.min.apply(null, ys), y1: Math.max.apply(null, ys),
          centro: { x: (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2,
                    y: (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2 }
        });
      });

      faces.sort((a, b) => a.depth - b.depth);
      faces.forEach((f) => {
        if (f.solid) {
          ctx.beginPath();
          f.pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
          ctx.closePath();
          ctx.fillStyle = f.fill;
          ctx.fill();
          if (f.stroke) { ctx.strokeStyle = f.stroke; ctx.lineWidth = 1; ctx.stroke(); }
          return;
        }
        if (!pintarCara(f.pts, f.tex[0], f.tex[1], f.tex[2], f.tex[3], f.shade)) return;
        ctx.beginPath();
        f.pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.closePath();
        ctx.strokeStyle = f.stroke;
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      // etiqueta de la pieza elegida
      if (opts.selected) {
        const val = (skin.offsets || {})[opts.selected] || 0;
        ctx.font = '600 13px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(255,196,110,0.95)';
        ctx.textAlign = 'left';
        ctx.fillText(opts.selected + ' · Y ' + val, 12, 22);
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(200,214,235,0.75)';
        ctx.fillText('arrastra arriba/abajo', 12, 38);
      }

      canvas._lce3d = { piezas: piezas, dibujadas: dibujadas, escala: scale, alto: H, ancho: W };
    };
    img.src = skin.thumbUrl;

    function b0(tipo, bx) { return armorPieceBox(tipo, bx); }
  }

  /** arrastrar las piezas de armadura en la vista 3D */
  function initArmorDrag(canvas, skin, onChange) {
    // el contexto se actualiza en cada apertura; los listeners se ponen una sola vez
    canvas._lceCtx = { skin: skin, onChange: onChange, sel: () => armorSeleccionada };
    if (canvas._lceBound) return;
    canvas._lceBound = true;
    let activa = null;
    let y0 = 0;
    let off0 = 0;
    const punto = (ev) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: (ev.clientX - r.left) * (canvas.width / r.width),
        y: (ev.clientY - r.top) * (canvas.height / r.height)
      };
    };
    const piezaEn = (p) => {
      const st = canvas._lce3d;
      if (!st) return null;
      // la más pequeña que contenga el punto = la que está delante
      const dentro = st.piezas.filter((z) => p.x >= z.x0 && p.x <= z.x1 && p.y >= z.y0 && p.y <= z.y1);
      dentro.sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0));
      return dentro[0] || null;
    };
    canvas.addEventListener('pointerdown', (ev) => {
      if (!canvas._lceCtx) return;
      const p = punto(ev);
      const elegida = canvas._lceCtx.sel && canvas._lceCtx.sel();
      const pieza = elegida ? { tipo: elegida } : piezaEn(p);
      if (!pieza) return;
      activa = pieza.tipo;
      y0 = ev.clientY;
      off0 = Number((canvas._lceCtx.skin.offsets || {})[activa]) || 0;
      canvas.setPointerCapture(ev.pointerId);
      canvas.style.cursor = 'ns-resize';
      canvas._lceCtx.onChange(activa, off0, true);
      ev.preventDefault();
    });
    canvas.addEventListener('pointermove', (ev) => {
      const p = punto(ev);
      if (!activa) {
        canvas.style.cursor = piezaEn(p) ? 'ns-resize' : 'default';
        return;
      }
      const r = canvas.getBoundingClientRect();
      const escalaPx = (canvas._lce3d ? canvas._lce3d.escala : 9) * (r.height / canvas.height);
      const delta = Math.round((ev.clientY - y0) / escalaPx);   // bajar el ratón = bajar la pieza
      const valor = off0 + delta;
      if (canvas._lceCtx) canvas._lceCtx.onChange(activa, valor, false);
      ev.preventDefault();
    });
    const fin = (ev) => {
      if (!activa) return;
      activa = null;
      canvas.style.cursor = 'default';
      try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* noop */ }
    };
    canvas.addEventListener('pointerup', fin);
    canvas.addEventListener('pointercancel', fin);
  }

  /* ============================================================
     PESTAÑA 2 — TEXTURE PACKS  (.zip → .pck de PS3)
     ============================================================ */
  const tex = {
    base: null,        // {fileName, pckType, xmlVersion, littleEndian, assets, name, packId}
    patched: new Set(),
    report: [],
    target: 'ps3',
    running: false
  };

  const PNG_TYPES = [0, 1, 2]; // SkinFile, CapeFile, TextureFile

  function pngDims(u8) {
    if (!u8 || u8.length < 24) return null;
    if (!(u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47)) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return { w: dv.getUint32(16), h: dv.getUint32(20) };
  }

  /* Traduce rutas de Java/Bedrock a las rutas que usa Legacy Console Edition */
  function normalizePath(path) {
    let p = String(path).toLowerCase().replace(/\\/g, '/').replace(/^\.?\//, '');
    const i = p.indexOf('assets/minecraft/');
    if (i >= 0) p = p.slice(i + 'assets/minecraft/'.length);
    p = p.replace(/^assets\/[^/]+\//, '');
    if (/^textures\/(models|gui|font|misc\/pumpkinblur|environment|colormap|effect)\//.test(p)) return '';
    p = p.replace(/^textures\/block\//, 'textures/blocks/');
    p = p.replace(/^textures\/item\//, 'textures/items/');
    p = p.replace(/^textures\/entity\//, 'mob/');
    p = p.replace(/^textures\/entities\//, 'mob/');
    p = p.replace(/^textures\/mob_effect\//, 'mob/');
    return p;
  }

  function texPngIndexes() {
    const out = [];
    tex.base.assets.forEach((a, i) => { if (pngDims(a.data)) out.push(i); });
    return out;
  }

  function findMatches(srcPath) {
    const key = normalizePath(srcPath);
    const baseName = String(srcPath).split('/').pop().toLowerCase();
    const idx = texPngIndexes();
    // 1) coincidencia exacta de ruta
    if (key) {
      const exact = idx.filter((i) => tex.base.assets[i].filename.toLowerCase() === key);
      if (exact.length) return { indexes: exact, how: 'ruta' };
    }
    // 2) misma ruta pero sin prefijo (p. ej. "textures/blocks/stone.png" dentro del zip)
    if (key) {
      const suffix = idx.filter((i) => {
        const n = tex.base.assets[i].filename.toLowerCase();
        return n.endsWith('/' + key) || key.endsWith('/' + n);
      });
      if (suffix.length === 1) return { indexes: suffix, how: 'ruta parcial' };
    }
    // 3) mismo nombre de archivo
    const byName = idx.filter((i) => tex.base.assets[i].filename.split('/').pop().toLowerCase() === baseName);
    if (byName.length === 1) return { indexes: byName, how: 'nombre de archivo' };
    return { indexes: [], how: null };
  }

  /* Reescala respetando las tiras de animación verticales */
  async function resample(srcBytes, dw, dh) {
    const img = await loadImageBitmap(new Blob([srcBytes], { type: 'image/png' }));
    const sw = img.width, sh = img.height;
    if (sw === dw && sh === dh) return { bytes: srcBytes, note: '' };

    const canvas = document.createElement('canvas');
    canvas.width = dw; canvas.height = dh;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, dw, dh);

    const dstFrames = dh % dw === 0 ? dh / dw : 1;
    const srcFrames = sh % sw === 0 ? sh / sw : 1;
    let note = sw + '×' + sh + ' → ' + dw + '×' + dh;
    if (dstFrames > 1 && dstFrames === srcFrames) {
      for (let f = 0; f < dstFrames; f++) {
        ctx.drawImage(img, 0, f * sw, sw, sw, 0, f * dw, dw, dw);
      }
      note += ' (' + dstFrames + ' fotogramas, reescalado por fotograma)';
    } else {
      ctx.drawImage(img, 0, 0, sw, sh, 0, 0, dw, dh);
      if (dstFrames > 1) note += ' ⚠ el destino es una animación de ' + dstFrames + ' fotogramas';
    }
    return { bytes: await canvasToPngBytes(canvas), note: note };
  }

  async function texApplyOne(srcPath, data) {
    const dims = pngDims(data);
    if (!dims) {
      tex.report.push({ kind: 'err', src: srcPath, dst: '', note: 'no es un PNG válido' });
      return;
    }
    const m = findMatches(srcPath);
    if (!m.indexes.length) {
      tex.report.push({
        kind: 'none', src: srcPath, dst: '',
        note: 'ese archivo no existe en el pack base (no se añaden archivos nuevos para no romper el pack)'
      });
      return;
    }
    for (const i of m.indexes) {
      const asset = tex.base.assets[i];
      const target = pngDims(asset.data);
      try {
        const res = await resample(data, target.w, target.h);
        asset.data = res.bytes;
        tex.patched.add(asset.filename);
        tex.report.push({
          kind: res.note ? 'warn' : 'ok',
          src: srcPath,
          dst: asset.filename,
          note: (m.how ? 'emparejado por ' + m.how : '') + (res.note ? ' · ' + res.note : '')
        });
      } catch (err) {
        tex.report.push({ kind: 'err', src: srcPath, dst: asset.filename, note: err.message });
      }
    }
  }

  async function texFromFiles(fileList) {
    if (!tex.base) { toast('Carga primero un pack base <code>.pck</code>', 'warn'); return; }
    const files = Array.from(fileList || []);
    if (!files.length) return;
    tex.running = true;
    setBusy(true);
    for (const file of files) {
      const lower = file.name.toLowerCase();
      try {
        let entries = [];
        if (/\.(zip|jar|mcpack|mcaddon)$/.test(lower)) {
          const list = await unzip(await file.arrayBuffer());
          entries = list.filter((e) => /\.png$/i.test(e.name)).map((e) => ({ name: e.name, data: e.data }));
          if (!entries.length) toast('<code>' + file.name + '</code> no contiene PNG', 'warn');
        } else if (/\.png$/i.test(lower)) {
          entries = [{ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }];
        } else {
          toast('Formato no soportado en esta pestaña: <code>' + file.name + '</code>', 'warn');
          continue;
        }
        for (const e of entries) await texApplyOne(e.name, e.data);
      } catch (err) {
        console.error(err);
        toast('<b>' + file.name + '</b>: ' + err.message, 'error');
      }
    }
    tex.running = false;
    setBusy(false);
    renderTex();
    const ok = tex.report.filter((r) => r.kind !== 'none' && r.kind !== 'err').length;
    if (ok) toast('Texturas aplicadas: <b>' + tex.patched.size + '</b>', 'ok');
  }

  async function texLoadBase(file) {
    try {
      const buf = await file.arrayBuffer();
      const pck = PCK.readPck(buf);
      const assets = pck.assets.map((a) => ({
        filename: a.filename,
        type: a.type,
        data: a.data,
        params: a.params.map((p) => p.slice())
      }));
      let name = '';
      const loc = assets.find((a) => a.type === PCK.ASSET_TYPE.LocalisationFile);
      if (loc) {
        try {
          const parsed = PCK.readLoc(loc.data);
          const k = parsed.keys['IDS_DISPLAY_NAME'];
          if (k) name = k['en-EN'] || Object.values(k)[0] || '';
        } catch (e) { /* loc no parseable, da igual */ }
      }
      const info = assets.find((a) => a.type === PCK.ASSET_TYPE.InfoFile);
      let packId = info ? info.params.find((p) => p[0] === 'PACKID') : null;
      tex.base = {
        fileName: file.name,
        pckType: pck.pckType,
        xmlVersion: pck.xmlVersion,
        littleEndian: pck.littleEndian,
        assets: assets,
        name: name,
        packId: packId ? Number(packId[1]) : null
      };
      tex.patched = new Set();
      tex.report = [];
      // el destino por defecto es siempre PS3 (big endian): si el pack base viene
      // de PS4/Vita/Switch se convierte al vuelo.
      tex.target = 'ps3';
      $('#texPackId').value = tex.base.packId != null ? String(tex.base.packId) : '';
      $$('input[name="texTarget"]').forEach((r) => { r.checked = r.value === tex.target; });
      toast('Pack base cargado: <b>' + (name || file.name) + '</b> (' + pck.assets.length + ' archivos' +
        (pck.littleEndian ? ', se convertirá a big endian para PS3' : '') + ')', 'ok');
      renderTex();
    } catch (err) {
      console.error(err);
      toast('<b>' + file.name + '</b>: ' + err.message, 'error');
    }
  }

  function texBuild() {
    const base = tex.base;
    const assets = base.assets.map((a) => ({
      filename: a.filename,
      type: a.type,
      data: a.data,
      params: a.params.map((p) => p.slice())
    }));

    // PACKID editable
    const rawId = $('#texPackId').value.trim();
    if (rawId !== '') {
      const pid = clampInt(rawId, 0, 0x00ffffff, null);
      if (pid != null) {
        const info = assets.find((a) => a.type === PCK.ASSET_TYPE.InfoFile);
        if (info) {
          const p = info.params.find((x) => x[0] === 'PACKID');
          if (p) p[1] = String(pid); else info.params.push(['PACKID', String(pid)]);
        }
      }
    }

    const littleEndian = tex.target === 'modern';

    // Los sub-PCK incrustados (tipo 5/8/11) deben usar el mismo endianness
    if (littleEndian !== base.littleEndian) {
      assets.forEach((a) => {
        if (a.type !== 5 && a.type !== 8 && a.type !== 11) return;
        try {
          const sub = PCK.readPck(a.data);
          a.data = PCK.writePck({
            pckType: sub.pckType,
            xmlVersion: sub.xmlVersion,
            littleEndian: littleEndian,
            assets: sub.assets
          });
        } catch (e) { /* no era un PCK: se deja tal cual */ }
      });
    }

    return PCK.writePck({
      pckType: base.pckType,
      xmlVersion: base.xmlVersion,
      littleEndian: littleEndian,
      assets: assets
    });
  }

  function renderTex() {
    const has = !!tex.base;
    $('#baseState').textContent = has ? 'cargado' : 'sin cargar';
    $('#baseState').className = 'pill' + (has ? ' ok-pill' : '');

    const info = $('#baseInfo');
    const list = $('#baseAssets');
    if (!has) {
      info.innerHTML = '';
      list.innerHTML = '';
      $('#texSumAssets').textContent = '0';
      $('#texSumPatched').textContent = '0';
      $('#texSumSize').textContent = '—';
      $('#texHint').textContent = 'Carga primero un pack base .pck.';
      ['#texDownloadBtn', '#texZipBtn', '#texVerifyBtn'].forEach((sel) => { $(sel).disabled = true; });
      renderTexReport();
      return;
    }

    const pngCount = texPngIndexes().length;
    info.innerHTML = `
      <div class="base-info">
        <div class="row"><span>Archivo</span><b>${escapeHtml(tex.base.fileName)}</b></div>
        <div class="row"><span>Nombre del pack</span><b>${escapeHtml(tex.base.name || '—')}</b></div>
        <div class="row"><span>Formato</span><b>PCK ${tex.base.pckType} · ${tex.base.littleEndian ? 'little endian' : 'big endian'}${tex.base.xmlVersion ? ' · BOX ' + tex.base.xmlVersion : ''}</b></div>
        <div class="row"><span>Texturas PNG</span><b>${pngCount} de ${tex.base.assets.length} archivos</b></div>
        <div class="row"><span>PACKID</span><b>${tex.base.packId != null ? tex.base.packId : '—'}</b></div>
      </div>`;

    const pngs = texPngIndexes().slice(0, 60).map((i) => {
      const a = tex.base.assets[i];
      const d = pngDims(a.data);
      const patched = tex.patched.has(a.filename);
      return `<div class="a-row${patched ? ' patched' : ''}"><code>${escapeHtml(a.filename)}</code>
        <span class="t">${d.w}×${d.h}${patched ? ' · sustituida' : ''}</span></div>`;
    }).join('');
    const extra = pngCount > 60 ? `<div class="a-row"><span class="t">… y ${pngCount - 60} más</span></div>` : '';
    list.innerHTML = pngs + extra;

    let totalBytes = 0;
    tex.base.assets.forEach((a) => { totalBytes += a.data.length; });
    $('#texSumAssets').textContent = String(tex.base.assets.length);
    $('#texSumPatched').textContent = String(tex.patched.size);
    $('#texSumSize').textContent = '≈ ' + humanSize(totalBytes + 512);
    $('#texSumFormat').textContent = 'PCK ' + tex.base.pckType + ' · ' + (tex.target === 'ps3' ? 'BE' : 'LE');
    const conv = tex.target === 'ps3' && tex.base.littleEndian;
    $('#texHint').textContent = (tex.patched.size
      ? 'Se sustituirán ' + tex.patched.size + ' texturas al exportar.'
      : 'Aún no has sustituido ninguna textura: el .pck saldrá igual que el pack base (útil para cambiarle el endianness o el PACKID).') +
      (conv ? ' El pack base es little endian: se convertirá a big endian (PS3).' : '');
    ['#texDownloadBtn', '#texZipBtn', '#texVerifyBtn'].forEach((sel) => { $(sel).disabled = false; });
    renderTexReport();
  }

  function renderTexReport() {
    const box = $('#texReport');
    if (!tex.report.length) { box.innerHTML = ''; return; }
    const icon = { ok: '✓', warn: '⚠', err: '✕', none: '·' };
    box.innerHTML = tex.report.slice(-120).map((r) => `
      <div class="r-row ${r.kind}">
        <div class="r-ico">${icon[r.kind] || '·'}</div>
        <div class="r-main">
          ${r.dst ? '<div class="r-dst">→ <code>' + escapeHtml(r.dst) + '</code></div>' : ''}
          <div class="r-src">${escapeHtml(r.src)}</div>
          ${r.note ? '<div class="r-note">' + escapeHtml(r.note) + '</div>' : ''}
        </div>
      </div>`).join('');
  }

  /* ---------- ZIP de salida (sin compresión: los PNG ya van comprimidos) ---------- */
  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = -1;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  function makeZip(files) {
    const enc = new TextEncoder();
    const locals = [];
    const centrals = [];
    let offset = 0;
    files.forEach((f) => {
      const name = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const lh = new Uint8Array(30 + name.length);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, 0, true);          // método 0 = store
      dv.setUint16(10, 0, true);         // hora
      dv.setUint16(12, 0x21, true);      // fecha (1980-01-01)
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, name.length, true);
      lh.set(name, 30);
      locals.push(lh, data);

      const ch = new Uint8Array(46 + name.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      ch.set(name, 46);
      centrals.push(ch);
      offset += lh.length + data.length;
    });
    const centralSize = centrals.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    const all = locals.concat(centrals, [eocd]);
    const total = all.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    all.forEach((c) => { out.set(c, p); p += c.length; });
    return out;
  }

  function texVerifyAndLog(bytes, label) {
    const p = PCK.readPck(bytes);
    if (p.assets.length !== tex.base.assets.length) {
      throw new Error('el número de archivos no cuadra (' + p.assets.length + ' vs ' + tex.base.assets.length + ')');
    }
    const rows = p.assets.map((a) => {
      const d = pngDims(a.data);
      return '<div class="log-row"><div class="log-name"><code>' + escapeHtml(a.filename) +
        '</code><span class="t">tipo ' + a.type + (d ? ' · ' + d.w + '×' + d.h : '') + ' · ' + humanSize(a.data.length) +
        '</span></div>' + (a.params.length ? '<div class="log-params">' +
          escapeHtml(a.params.map((x) => x[0] + '=' + x[1]).join(' · ')) + '</div>' : '') + '</div>';
    }).join('');
    $('#texLog').innerHTML = `
      <div class="log-head">
        <strong>✓ Estructura verificada: ${p.assets.length} archivos, ${p.littleEndian ? 'little' : 'big'} endian, tipo ${p.pckType}</strong>
        <span class="muted">${escapeHtml(label)} · ${humanSize(bytes.length)}</span>
      </div>
      <div class="log-rows">${rows}</div>`;
    $('#texLog').classList.add('show');
  }

  function initTabs() {
    const tabs = [
      { btn: '#tabBtnSkins', panel: '#panel-skins' },
      { btn: '#tabBtnTex', panel: '#panel-tex' }
    ];
    tabs.forEach((t) => {
      $(t.btn).addEventListener('click', () => {
        tabs.forEach((o) => {
          const active = o === t;
          $(o.btn).classList.toggle('active', active);
          $(o.btn).setAttribute('aria-selected', active ? 'true' : 'false');
          const panel = $(o.panel);
          panel.classList.toggle('active', active);
          panel.hidden = !active;
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  function texActive() {
    const p = $('#panel-tex');
    return p && !p.hidden;
  }

  function initTex() {
    const baseInput = $('#baseInput');
    $('#baseDrop').addEventListener('click', () => baseInput.click());
    baseInput.addEventListener('change', () => {
      if (baseInput.files[0]) texLoadBase(baseInput.files[0]);
      baseInput.value = '';
    });

    const texInput = $('#texInput');
    $('#texPickBtn').addEventListener('click', () => texInput.click());
    texInput.addEventListener('change', () => { texFromFiles(texInput.files); texInput.value = ''; });

    ['#baseDrop', '#texDrop'].forEach((sel) => {
      const dz = $(sel);
      ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
      dz.addEventListener('drop', (e) => {
        if (!e.dataTransfer) return;
        const files = Array.from(e.dataTransfer.files);
        if (sel === '#baseDrop') { if (files[0]) texLoadBase(files[0]); }
        else texFromFiles(files);
      });
    });

    $('#texClearBtn').addEventListener('click', () => {
      tex.patched = new Set();
      tex.report = [];
      renderTex();
    });

    $$('input[name="texTarget"]').forEach((r) => r.addEventListener('change', () => {
      tex.target = r.value;
      renderTex();
    }));

    $('#texDownloadBtn').addEventListener('click', () => {
      if (!tex.base) return;
      try {
        const bytes = texBuild();
        texVerifyAndLog(bytes, tex.base.fileName);
        const fname = safeFileName((tex.base.name || 'texturepack')) + '.pck';
        download(bytes, fname);
        toast('Descargado <b>' + fname + '</b> (' + humanSize(bytes.length) + ')', 'ok');
      } catch (err) {
        console.error(err);
        toast('Error al construir el pack: ' + err.message, 'error');
      }
    });

    $('#texVerifyBtn').addEventListener('click', () => {
      if (!tex.base) return;
      try {
        const bytes = texBuild();
        texVerifyAndLog(bytes, tex.base.fileName);
        toast('✓ Estructura verificada · ' + humanSize(bytes.length), 'ok');
      } catch (err) {
        toast('✗ ' + err.message, 'error');
      }
    });

    $('#texZipBtn').addEventListener('click', () => {
      if (!tex.base) return;
      const idx = texPngIndexes();
      const files = idx.map((i) => ({ name: tex.base.assets[i].filename, data: tex.base.assets[i].data }));
      files.push({
        name: 'LEEME.txt',
        data: new TextEncoder().encode(
          'Texturas extraidas del pack base ' + tex.base.fileName + '\n\n' +
          '1. Edita estos PNG manteniendo el tamano exacto (o usa el mismo layout de atlas).\n' +
          '2. Vuelve a subir este zip en la pestana "Texture packs" de SkinForge.\n' +
          '3. Descarga el .pck e instalalo en la PS3 (USRDIR/DLC/<carpeta>/).\n'
        )
      });
      const zip = makeZip(files);
      download(zip, safeFileName((tex.base.name || 'texturas')) + '-png.zip');
      toast('Exportados <b>' + idx.length + '</b> PNG en un .zip', 'ok');
    });

    renderTex();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
