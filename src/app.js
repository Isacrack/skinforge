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
    showCape: true,
    yaw: null,
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
        skin.hideBase = !!s.hideBase;
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
          <button class="icon-btn edit-btn" title="Editar píxeles y capas" aria-label="Editar"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L20 8l-4-4L4 16v4z"/></svg></button>
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
      $('.edit-btn', card).addEventListener('click', () => edOpen(skin));

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
      '<div class="be-head"><span>Mover la armadura <code>OFFSET</code>: tócala en la vista 3D y arrástrala</span></div>' +
      '<div class="off-grid">' +
        PIEZAS_ARMADURA.map(([tipo, txt]) => {
          const val = Math.round(Number((skin.offsets || {})[tipo]) || 0);
          return '<div class="off" data-off="' + tipo + '" tabindex="0" role="button" ' +
            'title="Toca la pieza en la vista 3D y arrástrala (arriba/abajo). Aquí puedes marcarla para moverla.">' +
            '<span>' + txt + '</span><b data-val>' + (val ? (val > 0 ? '+' + val : val) : '0') + '</b></div>';
        }).join('') +
      '</div>' +
      '<div class="be-flags">' +
        '<label class="arm"><input type="checkbox" id="hideArmorChk"' + (skin.hideArmor ? ' checked' : '') +
          '> Ocultar toda la armadura</label>' +
        '<label class="arm"><input type="checkbox" id="hideBaseChk"' + (skin.hideBase ? ' checked' : '') +
          ' title="Oculta el muñeco de Steve en el juego: la skin es solo tu modelo (ANIM bits 11-16)"> Sin cuerpo base (modelo propio)</label>' +
        '<label class="arm"><input type="checkbox" id="unfairChk"' + (skin.unfair ? ' checked' : '') +
          '> No válida en Battle Mode</label>' +
      '</div>' +
      '<div class="armor-hint">' +
        (skin.hideBase
          ? 'Marcado <b>sin cuerpo base</b>: en el juego solo se ve tu geometría, sin el muñeco de Steve.'
          : 'Marca <b>sin cuerpo base</b> y desaparece el muñeco de Steve: solo queda tu modelo (para skins tipo personaje).') +
        '<div style="height:6px"></div>' +
        (skin.model3d
          ? 'Si la armadura se hunde en tu geometría, súbela con el valor de esa pieza (p. ej. casco <b>-2</b> en una cabeza de 10). Funciona desde <b>TU33</b> (TU58 para las partes base).'
          : 'El <code>OFFSET</code> mueve la armadura del jugador; se aplica a la skin aunque no tenga modelo.') +
      '</div>';
    host.appendChild(off);

    skin.offsets = skin.offsets || {};
    const ponerOffset = (tipo, valor) => {
      const v = Math.round(valor) || 0;
      if (v) skin.offsets[tipo] = v; else delete skin.offsets[tipo];
      const fila = document.querySelector('.off[data-off="' + tipo + '"] [data-val]');
      if (fila) fila.textContent = v ? (v > 0 ? '+' + v : String(v)) : '0';
      if (repintar3D) repintar3D();
      render();
    };
    off.querySelectorAll('.off').forEach((fila) => {
      fila.addEventListener('click', () => {
        armorSeleccionada = armorSeleccionada === fila.dataset.off ? null : fila.dataset.off;
        const chkArmor = $('#showArmorChk');
        if (armorSeleccionada && chkArmor && !chkArmor.checked) {
          chkArmor.checked = true;
          state.showArmor = true;
        }
        if (repintar3D) repintar3D();
      });
      // con el teclado: flechas suben/bajan la pieza, Supr la deja en 0
      fila.addEventListener('keydown', (ev) => {
        const tipo = fila.dataset.off;
        const actual = Math.round(Number(skin.offsets[tipo]) || 0);
        if (ev.key === 'ArrowUp') { ev.preventDefault(); ponerOffset(tipo, actual - 1); }
        else if (ev.key === 'ArrowDown') { ev.preventDefault(); ponerOffset(tipo, actual + 1); }
        else if (ev.key === 'Delete' || ev.key === 'Backspace' || ev.key === 'Home') { ev.preventDefault(); ponerOffset(tipo, 0); }
      });
    });
    const hideChk = off.querySelector('#hideArmorChk');
    if (hideChk) hideChk.addEventListener('change', () => { skin.hideArmor = hideChk.checked; render(); });
    const hideBaseChk = off.querySelector('#hideBaseChk');
    if (hideBaseChk) hideBaseChk.addEventListener('change', () => {
      skin.hideBase = hideBaseChk.checked;
      render();
      toast(skin.hideBase
        ? 'El muñeco base desaparece: la skin será <b>solo tu modelo</b> (ANIM 0x' + (PCK.ANIM.HIDE_BASE_ALL | PCK.ANIM.HIDE_ARMOR).toString(16).toUpperCase() + ')'
        : 'Vuelve el muñeco base de Steve', 'info');
    });
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

    const actualizarMeta = () => {
      const m = $('#dollMeta');
      if (!m) return;
      m.textContent = skin.model3d
        ? skin.w + '×' + skin.h + ' · modelo 3D: ' + boxes.length + ' cajas · XMLVERSION ' + skin.model3d.xmlVersion
        : skin.w + '×' + skin.h + ' · ' + skin.model + ' · ' + humanSize(skin.png.length);
    };

    const verArmadura = () => {
      const chk = $('#showArmorChk');
      return !!(chk && chk.checked);
    };

    // ---------- animación (andar, correr, nadar…) y arrastrar para girar ----------
    let pose = { rot: {}, bob: 0 };
    let animNombre = 'quieto';
    let jugando = false;
    let rafAnim = null;
    let t0 = 0;
    let velocidad = 1;
    let giroAuto = false;
    // modos de la vista 3D: girar el muñeco, mover una caja o mover un pivote
    let modo = 'girar';
    let cajaSel = null;
    let pivoteSel = 'HEAD';
    let verPivotes = false;
    let fondo = false;      // en modo «cajas»: el arrastre mueve en profundidad (Z)

    const pasoAnim = (ts) => {
      if (!jugando) return;
      if (!t0) t0 = ts;
      const t = ((ts - t0) / 1000) * velocidad;
      pose = ANIMACIONES[animNombre] ? ANIMACIONES[animNombre](t) : { rot: {}, bob: 0 };
      if (giroAuto) {
        state.yaw = (state.yaw == null ? Math.PI - 0.6 : state.yaw) + 0.018;
        const sl = $('#yawRange');
        if (sl) sl.value = String(Math.round((state.yaw - (Math.PI - 0.6)) * 180 / Math.PI) % 360);
      }
      pintar(armorSeleccionada);
      rafAnim = requestAnimationFrame(pasoAnim);
    };
    const pararAnim = () => {
      jugando = false;
      giroAuto = false;
      if (rafAnim) cancelAnimationFrame(rafAnim);
      rafAnim = null;
      const b = $('#animPlay');
      if (b) { b.classList.remove('on'); b.textContent = '▶ Reproducir'; }
    };
    const arrancarAnim = () => {
      if (jugando) { pararAnim(); return; }
      jugando = true;
      t0 = 0;
      const b = $('#animPlay');
      if (b) { b.classList.add('on'); b.textContent = '⏸ Parar'; }
      rafAnim = requestAnimationFrame(pasoAnim);
    };

    const pintar = (sel) => {
      const chkB = $('#showBaseChk'), chkC = $('#showCapasChk');
      const chkCape = $('#showCapeChk');
      drawModel3D(c, skin, {
        boxes: boxes,
        selected: sel,
        modo: modo,
        cajaSel: cajaSel,
        verPivotes: modo === 'pivote' || verPivotes,
        pivoteSel: pivoteSel,
        pivotes: skin.pivotes,
        base: chkB ? chkB.checked : true,
        capas: chkC ? chkC.checked : true,
        capa: chkCape ? chkCape.checked : true,
        yaw: state.yaw == null ? undefined : state.yaw,
        pitch: state.pitch,
        rot: pose.rot,
        bob: pose.bob,
        piezas: verArmadura() ? undefined : []   // la armadura solo si la pides
      });
      repintar3D = () => pintar(armorSeleccionada);
      document.querySelectorAll('.off[data-off]').forEach((fila) => {
        fila.classList.toggle('sel', fila.dataset.off === sel);
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
    const chkCape2 = $('#showCapeChk');
    if (chkCape2) {
      chkCape2.checked = state.showCape !== false;
      chkCape2.onchange = () => { state.showCape = chkCape2.checked; pintar(armorSeleccionada); };
    }
    const yawInp = $('#yawRange');
    if (yawInp) {
      yawInp.value = String(Math.round(((state.yaw == null ? Math.PI - 0.6 : state.yaw) - (Math.PI - 0.6)) * 180 / Math.PI));
      yawInp.oninput = () => {
        state.yaw = (Math.PI - 0.6) + Number(yawInp.value) * Math.PI / 180;
        pintar(armorSeleccionada);
      };
    }

    const animSel = $('#animSel');
    if (animSel) {
      animSel.value = 'quieto';
      animSel.onchange = () => {
        animNombre = animSel.value;
        if (!jugando) arrancarAnim();
        else { t0 = 0; }
        if (animNombre === 'quieto') pararAnim();
      };
    }
    const animPlay = $('#animPlay');
    if (animPlay) {
      animPlay.onclick = () => {
        if (!jugando && animNombre === 'quieto' && animSel) { animSel.value = 'andar'; animNombre = 'andar'; }
        arrancarAnim();
      };
    }
    const animVel = $('#animVel');
    if (animVel) animVel.oninput = () => { velocidad = Number(animVel.value) || 1; };
    const animRot = $('#animRotate');
    if (animRot) {
      animRot.onclick = () => {
        giroAuto = !giroAuto;
        animRot.classList.toggle('on', giroAuto);
        if (giroAuto && !jugando) arrancarAnim();
      };
    }
    // arrastrar el lienzo para girar el muñeco
    c._lceCtx = c._lceCtx || {};
    c._lceCtx.rotar = (dx, dy) => {
      state.yaw = (state.yaw == null ? Math.PI - 0.6 : state.yaw) + dx * 0.012;
      state.pitch = Math.max(-0.15, Math.min(1.1, (state.pitch == null ? 0.34 : state.pitch) + dy * 0.008));
      const sl = $('#yawRange');
      if (sl) sl.value = String(Math.round((state.yaw - (Math.PI - 0.6)) * 180 / Math.PI) % 360);
      pintar(armorSeleccionada);
    };

    const chkCapas = $('#showCapasChk');
    if (chkCapas) {
      chkCapas.checked = state.showCapas !== false;
      chkCapas.onchange = () => { state.showCapas = chkCapas.checked; pintar(armorSeleccionada); };
    }

    renderEditor(skin);
    renderGeo(skin, boxes, () => { pintar(null); actualizarMeta(); }, (i) => {
      cajaSel = i;
      setModo('caja');
      marcarCaja();
      pintar(armorSeleccionada);
    });
    pintar(null);

    // --- arrastrar en la vista 3D (girar, mover cajas, pivotes y armadura) ---
    const persistirModelo = () => {
      if (!skin.model3d) {
        skin.model3d = { fileName: '(editado en SkinForge)', boxes: boxes, parts: [], warnings: [],
          xmlVersion: 2, cubes: boxes.length };
      }
      skin.model3d.boxes = boxes;
      skin.model3d.xmlVersion = boxes.some((b) => b.inflate) ? 3 : 2;
      skin.model3d.cubes = boxes.length;
      if (skin.pivotes) skin.model3d.pivotes = skin.pivotes;
    };

    const api = {
      skin: skin,
      getModo: () => modo,
      getCaja: () => cajaSel,
      setCaja: (i) => {
        cajaSel = i;
        marcarCaja();
        pintar(armorSeleccionada);
      },
      getCajaModelo: (i) => {
        const b = boxes[i];
        if (!b) return null;
        const ms = PCK.boxToModelSpace(b);
        return {
          min: ms.min.map((v) => Math.round(v)),
          max: ms.max.map((v) => Math.round(v))
        };
      },
      colocarCaja: (i, min, max) => {
        const b = boxes[i];
        if (!b) return;
        const minL = min.slice(), maxL = max.slice();
        for (let k = 0; k < 3; k++) if (maxL[k] <= minL[k]) maxL[k] = minL[k] + 1;
        Object.assign(b, PCK.cubeToBox(b.type, minL, maxL, b.uv, {
          armor: b.armor, inflate: b.inflate, mirror: b.mirror
        }));
        persistirModelo();
        pintar(armorSeleccionada);
      },
      getArmor: () => armorSeleccionada,
      onArmor: (tipo, valor, inicioArrastre) => {
        armorSeleccionada = tipo;
        if (inicioArrastre) {
          pintar(tipo);
          marcarArmadura();
          return;
        }
        skin.offsets = skin.offsets || {};
        if (valor) skin.offsets[tipo] = valor; else delete skin.offsets[tipo];
        pintar(tipo);
        marcarArmadura();
      },
      rotar: (dx, dy) => c._lceCtx.rotar(dx, dy),
      getFondo: () => fondo,
      setPivoteSel: (tipo) => {
        pivoteSel = tipo;
        renderPivotes();
        pintar(armorSeleccionada);
      },
      colocarPivote: (tipo, pv) => {
        skin.pivotes = skin.pivotes || {};
        skin.pivotes[tipo] = pv.slice();
        persistirModelo();
        pintar(armorSeleccionada);
      },
      finArrastre: (tipo) => {
        if (tipo === 'armadura') { marcarArmadura(); render(); return; }
        persistirModelo();
        renderPivotes();
        marcarCaja();
        actualizarFilasGeo(boxes);
        render();
      }
    };
    initDrag3D(c, api);

    // botones de modo
    const modoBtns = Array.from(document.querySelectorAll('#dollModes [data-modo]'));
    const setModo = (m) => {
      modo = m;
      modoBtns.forEach((b) => {
        const act = b.dataset.modo === m;
        b.classList.toggle('ghost', !act);
        b.classList.toggle('on', act);
      });
      const hint = $('#modoHint');
      if (hint) {
        hint.innerHTML = m === 'girar'
          ? 'arrastra para girar · las piezas azules de armadura se mueven'
          : m === 'caja'
            ? 'toca una caja y arrástrala · <b>A</b> ancho · <b>H</b> alto · <b>F</b> fondo'
            : 'toca un pivote y arrástralo al hombro o la cadera';
      }
      pintar(armorSeleccionada);
    };
    modoBtns.forEach((b) => { b.onclick = () => setModo(b.dataset.modo); });
    setModo('girar');

    const btnFondo = $('#cajaFondo');
    if (btnFondo) {
      btnFondo.onclick = () => {
        fondo = !fondo;
        btnFondo.classList.toggle('on', fondo);
        btnFondo.classList.toggle('ghost', !fondo);
      };
    }

    /** marca en la lista la caja que se está moviendo */
    function marcarCaja() {
      document.querySelectorAll('.geo-row').forEach((fila) => {
        fila.classList.toggle('sel', Number(fila.dataset.i) === cajaSel);
      });
    }
    /** marca la pieza de armadura elegida y enseña su OFFSET */
    function marcarArmadura() {
      document.querySelectorAll('.off').forEach((fila) => {
        const tipo = fila.dataset.off;
        const val = Math.round(Number((skin.offsets || {})[tipo]) || 0);
        fila.classList.toggle('sel', tipo === armorSeleccionada);
        const num = fila.querySelector('[data-val]');
        if (num) num.textContent = val ? (val > 0 ? '+' + val : String(val)) : '0';
      });
    }

    /** panel de pivotes: una fila por carpeta, arrastrable en la vista */
    function renderPivotes() {
      const host = $('#pivotePanel');
      if (!host) return;
      host.innerHTML = '';
      const cab = document.createElement('div');
      cab.className = 'be-head';
      cab.innerHTML = '<span>Pivote de cada carpeta (dónde gira)</span>' +
        '<button class="btn sm ghost" id="pivVer" title="Enseñar u ocultar las cruces en la vista 3D">' +
          (verPivotes ? 'Ocultar' : 'Ver') + '</button>' +
        '<button class="btn sm ghost" id="pivReset" title="Volver a los pivotes del juego">Juego</button>';
      host.appendChild(cab);
      const grid = document.createElement('div');
      grid.className = 'piv-grid';
      CARPETAS.forEach(([carpeta, tipo, txt]) => {
        const hay = boxes.some((b) => FOLDER_OF_TYPE[b.type] === carpeta);
        if (!hay && !skin.model3d) return;
        const pv = pivoteDe(skin, tipo);
        const propio = pivotePropio(skin, tipo);
        const fila = document.createElement('div');
        fila.className = 'piv' + (pivoteSel === tipo ? ' sel' : '');
        fila.dataset.pivote = tipo;
        fila.title = carpeta + ' · ' + txt + (propio ? ': giro en ' + pv.map((v) => Math.round(v)).join(', ') +
          ' (el juego gira en ' + (PCK.BOX_PIVOT[tipo] || [0, 24, 0]).join(', ') + ')' : ': pivote del juego');
        fila.innerHTML = '<b>' + carpeta + '</b>' +
          '<em>' + (propio ? pv.map((v) => Math.round(v)).join(', ') : txt) + '</em>' +
          (propio ? '<button class="btn sm ghost" data-cuadrar="' + tipo + '" ' +
            'title="Mueve estas cajas para que el juego gire desde el punto que has puesto">Cuadrar</button>' : '');
        grid.appendChild(fila);
      });
      host.appendChild(grid);
      const nota = document.createElement('div');
      nota.className = 'muted piv-nota';
      nota.innerHTML = 'Toca un pivote en la vista 3D y arrástralo al hombro o la cadera de esa carpeta. ' +
        'El <code>.pck</code> no guarda pivotes (el juego gira en el hombro y la cadera fijos): ' +
        'si lo mueves, <b>Cuadrar</b> desplaza las cajas de esa carpeta para que en la PS3 gire igual.';
      host.appendChild(nota);
      host.querySelectorAll('.piv').forEach((fila) => {
        fila.onclick = (ev) => {
          const btn = ev.target.closest('[data-cuadrar]');
          if (btn) { cuadrarPivote(btn.dataset.cuadrar); return; }
          pivoteSel = fila.dataset.pivote;
          setModo('pivote');
          verPivotes = true;
          renderPivotes();
        };
      });
      const ver = host.querySelector('#pivVer');
      if (ver) {
        ver.onclick = () => {
          verPivotes = !verPivotes;
          if (verPivotes && modo !== 'pivote') setModo('pivote');
          renderPivotes();
          pintar(armorSeleccionada);
        };
      }
      const reset = host.querySelector('#pivReset');
      if (reset) {
        reset.onclick = () => {
          if (!skin.pivotes || !Object.keys(skin.pivotes).length) return;
          skin.pivotes = {};
          persistirModelo();
          renderPivotes();
          pintar(armorSeleccionada);
          render();
          toast('Pivotes del juego restaurados (hombro y cadera estándar)', 'info');
        };
      }
    }
    /**
     * El .pck no guarda pivotes: el juego gira siempre en el hombro y la cadera del
     * modelo estándar. Si has movido el pivote, esto desplaza las cajas de esa carpeta
     * para que el giro del juego caiga donde tú quieres (la parte queda dibujada ahí).
     */
    function cuadrarPivote(tipo) {
      const F = (PCK.BOX_PIVOT[tipo] || [0, 24, 0]).slice();
      const C = pivoteDe(skin, tipo);
      if (!pivotePropio(skin, tipo)) return;
      const t = [F[0] - C[0], F[1] - C[1], F[2] - C[2]];
      const carpeta = FOLDER_OF_TYPE[tipo];
      const afectadas = boxes.filter((b) => FOLDER_OF_TYPE[b.type] === carpeta);
      if (!afectadas.length) { toast('Esa carpeta no tiene cajas', 'warn'); return; }
      const texto = 'Se moverán ' + afectadas.length + ' caja(s) de «' + carpeta + '» ' +
        t.map((v) => (v > 0 ? '+' + v : v)).join(', ') +
        ' px para que el juego gire desde el punto que has puesto.\n\n' +
        'La parte quedará dibujada ahí (el .pck no tiene pivotes propios). ¿Seguir?';
      if (!window.confirm(texto)) return;
      afectadas.forEach((b) => {
        const ms = PCK.boxToModelSpace(b);
        const min = ms.min.map((v, k) => Math.round(v + t[k]));
        const max = ms.max.map((v, k) => Math.round(v + t[k]));
        Object.assign(b, PCK.cubeToBox(b.type, min, max, b.uv, {
          armor: b.armor, inflate: b.inflate, mirror: b.mirror
        }));
      });
      skin.pivotes = skin.pivotes || {};
      skin.pivotes[tipo] = F;
      persistirModelo();
      renderPivotes();
      renderGeo(skin, boxes, () => { pintar(null); actualizarMeta(); });
      pintar(cajaSel);
      render();
      toast('«' + carpeta + '» cuadrada con el pivote del juego (y=' + F[1] + ')', 'ok');
    }

    renderPivotes();
    marcarArmadura();

    $('#dollClose').onclick = () => { pararAnim(); overlay.classList.remove('show'); };
    overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.remove('show'); };
  }


  /** refresca el texto (tamaño, inflado, armadura) de las filas sin rehacerlas */
  function actualizarFilasGeo(boxes) {
    document.querySelectorAll('.geo-row').forEach((fila) => {
      const b = boxes[Number(fila.dataset.i)];
      if (!b) return;
      const ms = PCK.boxToModelSpace(b);
      const t = fila.querySelector('[data-size]');
      if (t) t.textContent = [ms.max[0] - ms.min[0], ms.max[1] - ms.min[1], ms.max[2] - ms.min[2]]
        .map((v) => Math.round(v)).join('×');
      const inf = fila.querySelector('[data-inf]');
      if (inf) inf.textContent = String(b.inflate || 0);
      const arm = fila.querySelector('.geo-arm');
      if (arm) arm.textContent = b.armor ? PCK.armorLabel(b.armor) : 'siempre visible';
    });
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
      hideBase: !!s.hideBase,
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
        armor_hint: 'lce_armor: 1 casco · 2 peto · 4 gregüesco · 8 botas (se suman)',
        pivot_hint: 'el origin de cada grupo es el punto de giro que has puesto en la vista 3D'
      }
    };
  }

  /** carpetas del outliner para cada tipo de caja */
  const FOLDER_OF_TYPE = {
    HEAD: 'head', HEADWEAR: 'head',
    BODY: 'body', JACKET: 'body', WAIST: 'body', BODYARMOR: 'body', BELT: 'body',
    ARM0: 'right_arm', SLEEVE0: 'right_arm', ARMARMOR0: 'right_arm',
    ARM1: 'left_arm', SLEEVE1: 'left_arm', ARMARMOR1: 'left_arm',
    LEG0: 'right_leg', PANTS0: 'right_leg', LEGGING0: 'right_leg', SOCK0: 'right_leg', BOOT0: 'right_leg',
    LEG1: 'left_leg', PANTS1: 'left_leg', LEGGING1: 'left_leg', SOCK1: 'left_leg', BOOT1: 'left_leg'
  };

  /**
   * .bbmodel (Blockbench 5.0) a partir de las cajas LCE que hay ahora mismo,
   * para poder retocar la geometría fuera de la página.
   */
  function bbmodelFromBoxes(skin, boxes) {
    const nuevoUuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID()
      : 'u' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10));
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
    const pivoteDeCarpeta = (carpeta) => {
      const tipo = TIPO_DE_CARPETA[carpeta];
      return tipo ? pivoteDe(skin, tipo) : [0, 24, 0];
    };
    const elements = boxes.map((box) => {
      const ms = PCK.boxToModelSpace(box);
      const from = [Math.round(ms.min[0]), Math.round(ms.min[1]), Math.round(ms.min[2])];
      const to = [Math.round(ms.max[0]), Math.round(ms.max[1]), Math.round(ms.max[2])];
      const uv = [Math.round(ms.uv[0]), Math.round(ms.uv[1])];
      return {
        uuid: nuevoUuid(), type: 'cube', name: box.type.toLowerCase(),
        from: from, to: to, origin: pivoteDeCarpeta(FOLDER_OF_TYPE[box.type] || 'body'),
        uv_offset: uv, box_uv: true, rotation: [0, 0, 0],
        inflate: box.inflate || 0, lce_armor: box.armor || 0,
        faces: caras(from, to, uv)
      };
    });
    const nombres = ['head', 'body', 'right_arm', 'left_arm', 'right_leg', 'left_leg'];
    const grupos = nombres.map((nombre) => ({
      uuid: nuevoUuid(), name: nombre, origin: pivoteDeCarpeta(nombre), rotation: [0, 0, 0],
      miembros: elements.filter((e) => FOLDER_OF_TYPE[e.name.toUpperCase()] === nombre).map((e) => e.uuid)
    })).filter((g) => g.miembros.length);
    const nombre = (skin && skin.name) ? skin.name : 'Jugador';
    return {
      meta: { format_version: '5.0', model_format: 'java_block', box_uv: true },
      name: nombre + ' (geometría)',
      resolution: { width: skin ? skin.w : 64, height: skin ? skin.h : 64 },
      groups: grupos.map((g) => ({ uuid: g.uuid, name: g.name, origin: g.origin, rotation: [0, 0, 0] })),
      elements: elements,
      outliner: grupos.map((g) => ({ uuid: g.uuid, isOpen: true, children: g.miembros })),
      textures: [{
        name: safeFileName(nombre) + '.png', id: '0',
        source: skin ? skin.thumbUrl : blankSkinDataUrl(64, 64),
        uv_width: skin ? skin.w : 64, uv_height: skin ? skin.h : 64, particle: false
      }],
      lce: {
        nota: 'Geometría exportada desde SkinForge: cada cubo es una caja BOX de Legacy Console Edition.',
        armor_hint: 'lce_armor: 1 casco · 2 peto · 4 gregüesco · 8 botas (se suman)'
      }
    };
  }

  /* --------------------- editor de geometría (cajas) -------------------- */
  function renderGeo(skin, boxes, onPaint, onSelect) {
    const host = $('#geoEditor');
    if (!host) return;
    host.innerHTML = '';
    const sum = $('#geoSummary');
    if (sum) sum.textContent = 'Geometría: ' + boxes.length + ' cajas · .bbmodel';
    const cuenta = {};
    boxes.forEach((b) => { cuenta[b.type] = (cuenta[b.type] || 0) + 1; });
    const partesTxt = ['HEAD', 'BODY', 'ARM0', 'ARM1', 'LEG0', 'LEG1']
      .filter((t) => cuenta[t]).map((t) => t + ' ' + cuenta[t]).join(' · ');

    const head = document.createElement('div');
    head.className = 'geo-head';
    head.innerHTML = '<b>Geometría (' + boxes.length + ' cajas)</b>' +
      '<button class="btn sm ghost" id="geoDl" title="Descargar esta geometría como .bbmodel">Descargar .bbmodel</button>' +
      '<button class="btn sm ghost" id="geoDetect" title="Reparte las cajas en cabeza, cuerpo, brazos y piernas según su posición">Detectar partes</button>' +
      '<span class="muted">toca una caja y arrástrala en la vista · flechas = mover, Mayús+flechas = tamaño</span>';
    host.appendChild(head);
    if (partesTxt) {
      const resumen = document.createElement('div');
      resumen.className = 'geo-parts';
      resumen.textContent = 'Partes: ' + partesTxt;
      host.appendChild(resumen);
    }

    boxes.forEach((box, i) => {
      const row = document.createElement('div');
      row.className = 'geo-row';
      row.dataset.i = String(i);
      row.tabIndex = 0;
      const ms = PCK.boxToModelSpace(box);
      const size = [ms.max[0] - ms.min[0], ms.max[1] - ms.min[1], ms.max[2] - ms.min[2]]
        .map((v) => Math.round(v)).join('×');
      const parte = (skin.model3d && skin.model3d.parts && skin.model3d.parts[i]) || {};
      row.innerHTML =
        '<label class="geo-f geo-part"><span>Parte</span>' +
          '<select data-i="' + i + '" data-act="type" title="A qué parte del muñeco pertenece: de ella depende cómo se mueve">' +
            PCK.BOX_TYPES.map((t) => '<option value="' + t + '"' + (t === box.type ? ' selected' : '') + '>' + t + '</option>').join('') +
          '</select>' +
          '<span class="geo-arm">' + (box.armor ? PCK.armorLabel(box.armor) : 'siempre visible') + '</span>' +
        '</label>' +
        '<span class="geo-nombre">' + (parte.name && parte.name !== box.type ? '«' + escapeHtml(parte.name) + '» ' : '') +
          '<b data-size>' + size + '</b></span>' +
        '<span class="geo-inf">inflado ' +
          '<button class="icon-btn" data-i="' + i + '" data-act="inf-" title="Menos inflado">−</button>' +
          '<b data-inf>' + (box.inflate || 0) + '</b>' +
          '<button class="icon-btn" data-i="' + i + '" data-act="inf+" title="Más inflado">＋</button></span>' +
        '<button class="icon-btn pick" data-i="' + i + '" data-act="sel" title="Coger esta caja para arrastrarla en la vista 3D">✥</button>' +
        '<button class="icon-btn del" data-i="' + i + '" data-act="del" title="Quitar caja">✕</button>';
      host.appendChild(row);
    });

    const add = document.createElement('div');
    add.className = 'geo-add';
    add.innerHTML = '<select id="geoAddType">' +
      PCK.BOX_TYPES.map((t) => '<option value="' + t + '">' + t + '</option>').join('') +
      '</select><button class="btn sm" id="geoAddBtn">＋ Añadir caja</button>';
    host.appendChild(add);

    const persistir = () => {
      if (!skin.model3d) {
        skin.model3d = { fileName: '(editado en SkinForge)', boxes: boxes, parts: [], warnings: [],
          xmlVersion: 2, cubes: boxes.length };
      }
      skin.model3d.boxes = boxes;
      skin.model3d.xmlVersion = boxes.some((b) => b.inflate) ? 3 : 2;
      skin.model3d.cubes = boxes.length;
      if (onPaint) onPaint();
      render();
    };

    host.oninput = (e) => {
      const inp = e.target;
      if (!inp.dataset || !inp.dataset.act || inp.dataset.act === 'del') return;
      const i = Number(inp.dataset.i);
      const box = boxes[i];
      if (!box) return;
      if (inp.dataset.act === 'type') {
        // cambiar de parte sin que la caja se mueva de sitio
        const ms = PCK.boxToModelSpace(box);
        const nueva = PCK.cubeToBox(inp.value, ms.min, ms.max, box.uv, {
          armor: box.armor, inflate: box.inflate, mirror: box.mirror
        });
        Object.assign(box, nueva);
        persistir();
        renderGeo(skin, boxes, onPaint, onSelect);
        toast('Caja ' + (i + 1) + ' ahora es <b>' + inp.value + '</b>: se moverá con esa parte', 'info');
        return;
      }
    };
    host.onclick = (e) => {
      const sel = e.target.closest('[data-act="sel"]');
      if (sel) {
        if (onSelect) onSelect(Number(sel.dataset.i));
        return;
      }
      const inf = e.target.closest('[data-act="inf-"], [data-act="inf+"]');
      if (inf) {
        const i = Number(inf.dataset.i);
        const caja = boxes[i];
        if (!caja) return;
        const suma = inf.dataset.act === 'inf+' ? 1 : -1;
        caja.inflate = Math.max(0, Math.min(4, (caja.inflate || 0) + suma));
        persistir();
        actualizarFilasGeo(boxes);
        if (onSelect) onSelect(i, true);
        return;
      }
      const b = e.target.closest('[data-act="del"]');
      if (b) {
        if (boxes.length === 1) { toast('Tiene que quedar al menos una caja', 'warn'); return; }
        boxes.splice(Number(b.dataset.i), 1);
        persistir();
        renderGeo(skin, boxes, onPaint, onSelect);
        return;
      }
      if (e.target.id === 'geoAddBtn') {
        const tipo = $('#geoAddType').value;
        const std = STANDARD_SIZE[tipo] || [4, 4, 4];
        const nueva = PCK.cubeToBox(tipo, [-Math.round(std[0] / 2), 24 - std[1], -Math.round(std[2] / 2)],
          [Math.round(std[0] / 2), 24, Math.round(std[2] / 2)], [0, 0], {
            armor: ARMOR_OF_TYPE[tipo] || 0, inflate: 0, mirror: false
          });
        boxes.push(nueva);
        persistir();
        renderGeo(skin, boxes, onPaint, onSelect);
        toast('Caja <b>' + tipo + '</b> añadida (' + std.join('×') + '). Arrástrala en la vista 3D para colocarla.', 'ok');
        return;
      }
      if (e.target.id === 'geoDetect') {
        const absolutas = boxes.map((b) => {
          const ms = PCK.boxToModelSpace(b);
          return { min: ms.min, max: ms.max };
        });
        const tipos = detectarPartes(absolutas);
        let cambiadas = 0;
        boxes.forEach((b, i) => {
          if (b.type === tipos[i]) return;
          const nueva = PCK.cubeToBox(tipos[i], absolutas[i].min, absolutas[i].max, b.uv, {
            armor: b.armor, inflate: b.inflate, mirror: b.mirror
          });
          Object.assign(b, nueva);
          cambiadas++;
        });
        persistir();
        renderGeo(skin, boxes, onPaint, onSelect);
        const cuenta2 = {};
        tipos.forEach((t) => { cuenta2[t] = (cuenta2[t] || 0) + 1; });
        toast('Partes detectadas por posición: <b>' +
          Object.keys(cuenta2).map((t) => t + ' ' + cuenta2[t]).join(' · ') + '</b>' +
          (cambiadas ? ' (' + cambiadas + ' caja(s) cambiadas)' : ' (no había nada que cambiar)'), 'ok');
        return;
      }
      if (e.target.id === 'geoDl') {
        const json = bbmodelFromBoxes(skin, boxes);
        const bytes = new TextEncoder().encode(JSON.stringify(json, null, 2));
        download(bytes, safeFileName(skin.name || 'skin') + '-geometria.bbmodel');
        toast('Descargado el <code>.bbmodel</code> con las ' + boxes.length + ' cajas', 'ok');
        return;
      }
      // tocar la fila (sin botones) elige la caja para arrastrarla en la vista
      const fila = e.target.closest('.geo-row');
      if (fila && onSelect) onSelect(Number(fila.dataset.i));
    };

    // con el teclado: flechas mueven la caja, Mayús+flechas la estiran
    host.onkeydown = (e) => {
      const fila = e.target.closest('.geo-row');
      if (!fila || e.target.tagName === 'SELECT') return;
      const i = Number(fila.dataset.i);
      const caja = boxes[i];
      if (!caja) return;
      const paso = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowDown: [0, -1], ArrowUp: [0, 1] }[e.key];
      if (!paso) return;
      e.preventDefault();
      const ms = PCK.boxToModelSpace(caja);
      const min = ms.min.map((v) => Math.round(v)), max = ms.max.map((v) => Math.round(v));
      if (e.shiftKey) {
        // el eje vertical del teclado manda en el tamaño (arriba/abajo = alto, izq/der = ancho)
        const eje = paso[1] ? 1 : 0;
        max[eje] = Math.max(min[eje] + 1, max[eje] + paso[eje]);
      } else {
        min[0] += paso[0]; max[0] += paso[0];
        min[1] += paso[1]; max[1] += paso[1];
      }
      Object.assign(caja, PCK.cubeToBox(caja.type, min, max, caja.uv, {
        armor: caja.armor, inflate: caja.inflate, mirror: caja.mirror
      }));
      persistir();
      actualizarFilasGeo(boxes);
      if (onSelect) onSelect(i, true);
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

  /**
   * Reparte cajas en las partes del jugador (HEAD, BODY, ARM0/1, LEG0/1) por su POSICIÓN,
   * que es lo que hace que en el juego se muevan: la cabeza gira, los brazos y las piernas
   * oscilan al andar. Se usa cuando el nombre del cubo no dice nada (Cube.001, mesh_3…).
   *
   * @param {Array<{min:number[],max:number[]}>} cajas  en espacio de modelo (y arriba)
   * @returns {string[]} un tipo por caja
   */
  function detectarPartes(cajas) {
    if (!cajas || !cajas.length) return [];
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    cajas.forEach((c) => {
      for (let i = 0; i < 3; i++) {
        mn[i] = Math.min(mn[i], c.min[i]);
        mx[i] = Math.max(mx[i], c.max[i]);
      }
    });
    const alto = Math.max(1, mx[1] - mn[1]);
    const ancho = Math.max(1, mx[0] - mn[0]);
    const cx = (mn[0] + mx[0]) / 2;
    return cajas.map((c) => {
      const cy = (c.min[1] + c.max[1]) / 2;
      const bx = (c.min[0] + c.max[0]) / 2;
      const u = ((cy - mn[1]) / alto) * 32;      // altura llevada a la escala del jugador (0..32)
      const dx = (bx - cx) / (ancho / 2);        // -1 borde izquierdo … +1 borde derecho
      if (u >= 23) return 'HEAD';                // por encima del cuello
      if (u <= 12.5) return bx < cx ? 'LEG0' : 'LEG1';   // por debajo de la cintura
      if (Math.abs(dx) >= 0.55) return bx < cx ? 'ARM0' : 'ARM1'; // columnas de los lados
      return 'BODY';
    });
  }

  /** tipos precalculados por posición (uno por elemento, alineado con parsed.elements) */
  function tiposPorPosicion(elements) {
    const indices = [];
    const utiles = [];
    elements.forEach((el, i) => {
      const from = el && el.from, to = el && el.to;
      if (!Array.isArray(from) || !Array.isArray(to)) return;
      indices.push(i);
      utiles.push({
        min: [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.min(from[2], to[2])],
        max: [Math.max(from[0], to[0]), Math.max(from[1], to[1]), Math.max(from[2], to[2])]
      });
    });
    const tipos = detectarPartes(utiles);
    const porIndice = new Array(elements.length).fill(null);
    indices.forEach((idx, k) => { porIndice[idx] = tipos[k]; });
    return porIndice;
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
    const originOf = {};   // nombre del grupo -> punto de giro (origin de Blockbench)
    (Array.isArray(json.groups) ? json.groups : []).forEach((g) => {
      if (g && g.uuid) defs[g.uuid] = g.name || '';
      if (g && g.name && Array.isArray(g.origin)) originOf[g.name] = g.origin;
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
      const ori = Array.isArray(nodo.origin) ? nodo.origin : null;
      if (ori && nombre) originOf[nombre] = ori;
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
      originOf: originOf,
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
    // plan B: reparto por geometría, solo si el modelo no trae nombres de parte
    // (así una skin de jugador con un cubo suelto sigue comportándose como antes)
    const porPosicion = tiposPorPosicion(parsed.elements);
    const conNombre = parsed.elements.filter((el) => (el.name && guessBoxType(el.name)) ||
      ((parsed.groupOf && parsed.groupOf[el.uuid]) && guessBoxType(parsed.groupOf[el.uuid]))).length;
    const validos = parsed.elements.filter((el) => Array.isArray(el.from) && Array.isArray(el.to)).length;
    const sinNombre = validos - conNombre;
    const usarPosicion = sinNombre >= 2 && sinNombre >= validos * 0.5;
    let detectados = 0;

    parsed.elements.forEach((el, idx) => {
      const name = el.name || '';
      const grupo = (parsed.groupOf && parsed.groupOf[el.uuid]) || '';
      let type = guessBoxType(name) || (grupo ? guessBoxType(grupo) : null);
      let porGeometria = false;
      if (!type && usarPosicion) {
        type = porPosicion[idx] || null;
        porGeometria = !!type;
      }
      if (!type) {
        warnings.push({
          level: 'warn',
          text: 'Cubo «' + (name || 'sin nombre') + '»' + (grupo ? ' (grupo «' + grupo + '»)' : '') +
            ': no corresponde a ninguna parte del jugador (se ignora)'
        });
        return;
      }
      if (porGeometria) {
        detectados++;
        void 0;
        warnings.push({
          level: 'info',
          text: 'Cubo «' + (name || 'sin nombre') + '»: parte detectada por su posición → ' + type
        });
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

  /** ¿el modelo sustituye al jugador (personaje) o solo le añade adornos? */
  function modeloPropio(boxes) {
    if (!boxes || !boxes.length) return false;
    if (boxes.length > 20) return true;
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    boxes.forEach((b) => {
      const ms = PCK.boxToModelSpace(b);
      for (let i = 0; i < 3; i++) {
        mn[i] = Math.min(mn[i], ms.min[i]);
        mx[i] = Math.max(mx[i], ms.max[i]);
      }
    });
    return mx[1] - mn[1] > 34 || mx[0] - mn[0] > 20 || mx[2] - mn[2] > 10;
  }

  async function applyBbModelToSkin(skin, file) {
    const text = await file.text();
    const parsed = parseBbModel(text);
    const res = bbToBoxes(parsed, skin);
    // pivotes de las carpetas: si el .bbmodel trae `origin` en los grupos, se usan
    const pivotes = {};
    const origenes = parsed.originOf || {};
    Object.keys(origenes).forEach((nombreGrupo) => {
      const tipo = TIPO_DE_CARPETA[String(nombreGrupo).toLowerCase()] || guessBoxType(nombreGrupo);
      if (!tipo) return;
      const ori = origenes[nombreGrupo];
      if (!Array.isArray(ori) || ori.length < 3) return;
      const pv = ori.slice(0, 3).map((v) => Math.round(Number(v) || 0));
      // [0,24,0] es el origin por defecto de Blockbench: no significa «pivote propio»
      if (pv.every((v, i) => Math.abs(v - [0, 24, 0][i]) < 0.01)) return;
      pivotes[tipo] = pv;
    });
    if (Object.keys(pivotes).length) skin.pivotes = pivotes;

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
    // ¿es un personaje con su propia geometría o una skin de jugador con adornos?
    const propio = modeloPropio(res.boxes);
    if (propio && !skin.hideBase) {
      skin.hideBase = true;
      toast('Parece un <b>modelo propio</b> (' + res.boxes.length + ' cajas): activo «sin cuerpo base» ' +
        'para que en el juego solo se vea tu modelo. Se puede desmarcar en las opciones de la skin.', 'info');
    }
    toast('Modelo <b>' + escapeHtml(file.name) + '</b>: ' + res.boxes.length + ' cajas · XMLVERSION ' + res.xmlVersion, 'ok');
    if (res.warnings.length) toast(res.warnings.length + ' aviso(s) del modelo: <span class="muted">' + escapeHtml(res.warnings[0].text) + '</span>', 'warn');
    return { skin, parsed, res };
  }

  /* ------------------------- capa de la espalda (cape) ------------------- */
  /** capas de ejemplo dibujadas aquí mismo (no hacen falta archivos) */
  const CAPE_PRESETS = [
    { id: 'roja', name: 'Roja clásica', base: '#a3141e', det: '#f2e9d8', tipo: 'franja' },
    { id: 'naranja', name: 'Naranja', base: '#c8641c', det: '#f8d9a0', tipo: 'logo' },
    { id: 'verde', name: 'Verde bosque', base: '#2f6b2f', det: '#8fd08f', tipo: 'franja' },
    { id: 'morada', name: 'Morada', base: '#4b2a7a', det: '#c9a6f0', tipo: 'logo' },
    { id: 'azul', name: 'Azul hielo', base: '#1f4f8a', det: '#a8d5f5', tipo: 'franja' },
    { id: 'negra', name: 'Negra', base: '#20232a', det: '#7d8590', tipo: 'logo' }
  ];

  /** dibuja una capa 64×32 (delantera en 1,1 y trasera en 12,1) */
  function capePresetCanvas(p) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 32;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 64, 32);
    [[1, 1], [12, 1]].forEach(([ox, oy]) => {
      x.fillStyle = p.base;
      x.fillRect(ox, oy, 10, 16);
      x.fillStyle = p.det;
      if (p.tipo === 'franja') {
        x.fillRect(ox, oy + 1, 10, 1);
        x.fillRect(ox, oy + 13, 10, 1);
        x.fillRect(ox + 4, oy + 4, 2, 6);
      } else {
        x.fillRect(ox + 3, oy + 4, 4, 4);
        x.fillRect(ox + 4, oy + 3, 2, 6);
        x.fillRect(ox + 2, oy + 14, 6, 1);
      }
      x.strokeStyle = 'rgba(0,0,0,0.35)';
      x.strokeRect(ox + 0.5, oy + 0.5, 9, 15);
    });
    return c;
  }

  /** deja cualquier imagen como capa utilizable (64×32) */
  function capeFromImage(img) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 32;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = false;
    const esTexturaCapa = (img.width === 64 && (img.height === 32 || img.height === 64));
    if (esTexturaCapa) {
      x.drawImage(img, 0, 0);
    } else {
      [[1, 1], [12, 1]].forEach(([ox, oy]) => {
        x.save();
        x.beginPath(); x.rect(ox, oy, 10, 16); x.clip();
        const esc = Math.max(10 / img.width, 16 / img.height);
        const w = img.width * esc, h = img.height * esc;
        x.drawImage(img, ox + (10 - w) / 2, oy + (16 - h) / 2, w, h);
        x.restore();
      });
    }
    return c;
  }

  function capeSet(skin, canvas, name) {
    skin.cape = { canvas: canvas, name: name || 'capa' };
    const sum = $('#capeSummary');
    if (sum) sum.textContent = 'Capa de la espalda: ' + (name || 'puesta');
    if (typeof repintar3D === 'function' && repintar3D) repintar3D();
    toast('Capa <b>' + escapeHtml(name || '') + '</b> puesta. Gira el muñeco en la vista 3D para verla.', 'ok');
  }

  function renderCapeControls(skin) {
    const box = $('#capePresets');
    if (!box) return;
    box.innerHTML = '';
    const chip = (src, name, activa) => {
      const b = document.createElement('button');
      b.className = 'cape-chip' + (activa ? ' on' : '');
      b.title = name;
      const mini = document.createElement('canvas');
      mini.width = 22; mini.height = 36;
      const mx = mini.getContext('2d');
      mx.imageSmoothingEnabled = false;
      mx.drawImage(src, 1, 1, 10, 16, 0, 0, 22, 36);
      b.appendChild(mini);
      return b;
    };
    CAPE_PRESETS.forEach((p) => {
      const b = chip(capePresetCanvas(p), p.name, false);
      b.addEventListener('click', () => { capeSet(skin, capePresetCanvas(p), p.name); renderCapeControls(skin); });
      box.appendChild(b);
    });
    if (skin.cape) {
      const b = chip(skin.cape.canvas, skin.cape.name, true);
      b.addEventListener('click', () => toast('Capa actual: <b>' + escapeHtml(skin.cape.name) + '</b>', 'info'));
      box.appendChild(b);
    }
  }

  /** busca en Openverse (fotos/arte con licencia) */
  async function buscarOpenverse(q) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 7000);
    try {
      const res = await fetch('https://api.openverse.org/v1/images/?q=' + encodeURIComponent(q) + '&page_size=12',
        { headers: { Accept: 'application/json' }, signal: ctl.signal });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.results || []).filter((r) => r.url).map((r) => ({
        titulo: r.title || 'imagen',
        miniatura: r.thumbnail || r.url,
        origen: r.url
      }));
    } catch (e) { return []; } finally { clearTimeout(t); }
  }

  /** busca en Wikimedia Commons (miniaturas con CORS permitido) */
  async function buscarCommons(q) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 7000);
    try {
      const url = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search' +
        '&gsrsearch=' + encodeURIComponent(q) + '&gsrnamespace=6&gsrlimit=8' +
        '&prop=imageinfo&iiprop=url&iiurlwidth=400&format=json&origin=*';
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) return [];
      const data = await res.json();
      const pages = data.query && data.query.pages ? Object.values(data.query.pages) : [];
      return pages.map((p) => {
        const info = (p.imageinfo && p.imageinfo[0]) || {};
        return {
          titulo: (p.title || '').replace(/^File:/, '').replace(/\.[a-z]+$/i, ''),
          miniatura: info.thumburl || info.url,
          origen: info.thumburl || info.url
        };
      }).filter((r) => r.origen);
    } catch (e) { return []; } finally { clearTimeout(t); }
  }

  async function capeBuscar(skin, q) {
    const box = $('#capeResults');
    if (!box) return;
    box.innerHTML = '<span class="muted">Buscando…</span>';
    if (location.protocol === 'file:') {
      box.innerHTML = '<span class="muted">El buscador necesita la página abierta desde el servidor (http/https): ' +
        'en <b>isacrack.github.io/skinforge</b> funciona. Aquí usa las capas de arriba o «Subir PNG».</span>';
      return;
    }

    let puestas = 0;
    const pinta = (lista) => {
      if (!lista.length) return;
      if (!puestas) box.innerHTML = '';
      lista.forEach((it) => {
        puestas++;
        botonResultado(box, skin, it);
      });
    };

    // las dos fuentes a la vez y se van pintando según llegan
    const fuentes = [buscarCommons(q), buscarOpenverse(q)];
    await Promise.all(fuentes.map((f) => f.then(pinta).catch(() => {})));
    if (!puestas) {
      box.innerHTML = '<span class="muted">Sin resultados. Prueba «minecraft cape», «cape png», «ala», «bandera»…</span>';
    }
  }

  function botonResultado(box, skin, it) {
    const b = document.createElement('button');
    b.className = 'cape-res';
    b.title = it.titulo;
    const im = document.createElement('img');
    im.alt = '';
    im.loading = 'lazy';
    im.src = it.miniatura;
    im.addEventListener('error', () => {
      if (im.dataset.ya === '1') { b.style.display = 'none'; return; }
      im.dataset.ya = '1';
      im.src = it.origen;   // si la miniatura falla, la original
    });
    b.appendChild(im);
    b.addEventListener('click', async () => {
      b.classList.add('busy');
      try {
        const img = await new Promise((res2, rej) => {
          const i = new Image();
          i.crossOrigin = 'anonymous';
          i.onload = () => res2(i);
          i.onerror = () => rej(new Error('bloqueada'));
          i.src = it.origen;
        });
        capeSet(skin, capeFromImage(img), (it.titulo || 'capa').slice(0, 28));
        renderCapeControls(skin);
      } catch (err) {
        toast('Esa imagen no deja usarse (su servidor bloquea la descarga). Abre ' +
          '<b>Google Imágenes</b>, guarda el PNG y súbelo con «Subir PNG».', 'warn');
      }
      b.classList.remove('busy');
    });
    box.appendChild(b);
  }

  /** pinta la capa en la espalda de la textura (para que se vea en el juego) */
  async function capeBake(skin) {
    if (!skin.cape) { toast('Primero elige o sube una capa', 'warn'); return; }
    const capa = edNewLayer('capa-espalda', 'png');
    const ctx = capa.canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    // cara trasera del JACKET: uv 16,32 + desplegado (sur) → 32,36, 8×12
    const u = 32, v = 36, w = 8, h = 12;
    if (skin.w >= u + w && skin.h >= v + h) {
      ctx.drawImage(skin.cape.canvas, 1, 1, 10, 16, u, v, w, h);
    }
    const base = skin.layers && skin.layers.length ? skin.layers : [await edBaseLayer(skin)];
    ed.skin = skin;
    ed.layers = base.concat([capa]);
    const flat = edFlatten();
    const bytes = await canvasToPngBytes(flat);
    skin.png = bytes;
    skin.thumbUrl = canvasToUrl(flat);
    skin.warn = bytes.length > MAX_SAFE_SKIN_BYTES ? 'PNG grande (' + humanSize(bytes.length) + '): puede fallar en consola' : '';
    skin.layers = ed.layers;
    if (ed.skin === skin && $('#editOverlay').classList.contains('show')) {
      ed.sel = ed.layers.length - 1;
      edPushUndo();
      edRenderLayers();
      edRender();
    }
    render();
    toast('Capa pintada en la espalda de la skin (' + humanSize(bytes.length) + ')', 'ok');
  }

  /* --------------------- editor de skin: píxeles y capas ----------------- */
  /**
   * Editor por skin pensado también para el móvil: pinta píxeles con el dedo,
   * sube capas PNG (sombrero, chaqueta…) y aplánalas en la textura.
   * Las capas viven en skin.layers: [{id, name, canvas, visible, opacity}].
   */
  const ed = {
    skin: null, zoom: 8, tool: 'pencil', color: '#00afaf',
    sel: 0, undo: [], snapshot: null, bound: false,
    drawing: false, last: null, pointers: new Map(), pinch: null, swatches: []
  };

  const ED_ZOOMS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24];

  function edLayerCanvas(layer) { return layer.canvas; }

  function edClone(layers) {
    return layers.map((l) => {
      const c = document.createElement('canvas');
      c.width = l.canvas.width; c.height = l.canvas.height;
      c.getContext('2d').drawImage(l.canvas, 0, 0);
      return { id: l.id, name: l.name, canvas: c, visible: l.visible, opacity: l.opacity, kind: l.kind };
    });
  }

  function edFlatten() {
    const w = ed.skin.w, h = ed.skin.h;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ed.layers.forEach((l) => {
      if (!l.visible || !l.opacity) return;
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(l.canvas, 0, 0);
    });
    ctx.globalAlpha = 1;
    return out;
  }

  function edNewLayer(name, kind) {
    const c = document.createElement('canvas');
    c.width = ed.skin.w; c.height = ed.skin.h;
    return { id: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: name, canvas: c, visible: true, opacity: 1, kind: kind || 'empty' };
  }

  /** canvas con los píxeles actuales de la skin (capa base) */
  async function edBaseLayer(skin) {
    const base = document.createElement('canvas');
    base.width = skin.w; base.height = skin.h;
    const bctx = base.getContext('2d');
    bctx.imageSmoothingEnabled = false;
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = skin.thumbUrl;
      });
      bctx.drawImage(img, 0, 0, skin.w, skin.h);
    } catch (e) { /* skin vacía */ }
    return { id: 'base', name: 'Skin (base)', canvas: base, visible: true, opacity: 1, kind: 'base' };
  }

  async function edOpen(skin) {
    ed.skin = skin;
    ed.zoom = 8; ed.tool = 'pencil'; ed.sel = 0; ed.undo = []; ed.drawing = false;
    ed.pointers.clear(); ed.pinch = null;
    $('#edTitle').textContent = 'Editar · ' + (skin.name || 'skin');
    $$('#edTools .tool').forEach((b) => b.classList.toggle('sel', b.dataset.tool === 'pencil'));

    if (!skin.layers || !skin.layers.length) {
      skin.layers = [await edBaseLayer(skin)];
    }
    ed.layers = skin.layers;
    ed.sel = ed.layers.length - 1;
    ed.snapshot = edClone(ed.layers);
    $('#editOverlay').classList.add('show');
    edBind();
    renderCapeControls(skin);
    ed.zoom = edFit();
    edRender();
    requestAnimationFrame(() => { ed.zoom = edFit(); edRender(); });
  }

  /** el mayor zoom que cabe entero en el lienzo visible (sin deformar la skin) */
  function edFit() {
    const stage = $('#edStage');
    const skin = ed.skin;
    if (!stage || !skin) return ed.zoom;
    const avail = Math.min(stage.clientWidth - 16, stage.clientHeight - 16);
    if (!(avail > 0)) return ed.zoom;
    let best = ED_ZOOMS[0];
    ED_ZOOMS.forEach((z) => { if (z * skin.w <= avail) best = z; });
    return best;
  }

  function edCurrent() { return ed.layers[ed.sel] || ed.layers[0]; }

  function edRender() {
    const skin = ed.skin;
    if (!skin) return;
    const c = $('#edCanvas');
    const zoom = ed.zoom;
    c.width = skin.w * zoom; c.height = skin.h * zoom;
    c.style.width = (skin.w * zoom) + 'px';
    c.style.height = (skin.h * zoom) + 'px';
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = false;
    ed.layers.forEach((l) => {
      if (!l.visible || !l.opacity) return;
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(l.canvas, 0, 0, c.width, c.height);
    });
    ctx.globalAlpha = 1;
    if ($('#edGridChk').checked && zoom >= 4) {
      ctx.lineWidth = 1;
      for (let x = 1; x < skin.w; x++) {
        ctx.strokeStyle = x % 8 === 0 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.09)';
        ctx.beginPath(); ctx.moveTo(x * zoom + 0.5, 0); ctx.lineTo(x * zoom + 0.5, c.height); ctx.stroke();
      }
      for (let y = 1; y < skin.h; y++) {
        ctx.strokeStyle = y % 8 === 0 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.09)';
        ctx.beginPath(); ctx.moveTo(0, y * zoom + 0.5); ctx.lineTo(c.width, y * zoom + 0.5); ctx.stroke();
      }
    }
    $('#edZoomVal').textContent = zoom + '×';
    edRenderLayers();
  }

  function edRenderLayers() {
    const box = $('#edLayerList');
    box.innerHTML = '';
    ed.layers.forEach((l, i) => {
      const row = document.createElement('div');
      row.className = 'ed-layer' + (i === ed.sel ? ' sel' : '');
      row.dataset.i = String(i);
      row.innerHTML = `
        <button class="eye${l.visible ? '' : ' off'}" data-act="eye" title="Mostrar/ocultar">${l.visible ? '●' : '○'}</button>
        <span class="ln"><b>${escapeHtml(l.name)}</b><span>${l.kind === 'base' ? 'base' : (l.kind === 'png' ? 'capa PNG' : 'capa vacía')} · ${Math.round(l.opacity * 100)}%</span></span>
        <input type="range" min="0" max="100" value="${Math.round(l.opacity * 100)}" data-act="op" title="Opacidad">
        <button class="icon-btn" data-act="up" title="Subir capa">▲</button>
        <button class="icon-btn del" data-act="del" title="Quitar capa">✕</button>`;
      box.appendChild(row);
    });
  }

  function edPoint(ev) {
    const c = $('#edCanvas');
    const r = c.getBoundingClientRect();
    const x = Math.floor((ev.clientX - r.left) / r.width * ed.skin.w);
    const y = Math.floor((ev.clientY - r.top) / r.height * ed.skin.h);
    if (x < 0 || y < 0 || x >= ed.skin.w || y >= ed.skin.h) return null;
    return { x: x, y: y };
  }

  function edPushUndo() {
    const l = edCurrent();
    if (!l) return;
    const ctx = l.canvas.getContext('2d');
    ed.undo.push({ id: l.id, data: ctx.getImageData(0, 0, l.canvas.width, l.canvas.height) });
    if (ed.undo.length > 40) ed.undo.shift();
  }

  function edDot(x, y) {
    const l = edCurrent();
    if (!l || !l.visible) return;
    const ctx = l.canvas.getContext('2d');
    if (ed.tool === 'eraser') ctx.clearRect(x, y, 1, 1);
    else { ctx.fillStyle = ed.color; ctx.fillRect(x, y, 1, 1); }
    edRender();
  }

  function edLine(a, b) {
    let x0 = a.x, y0 = a.y;
    const dx = Math.abs(b.x - x0), dy = Math.abs(b.y - y0);
    const sx = x0 < b.x ? 1 : -1, sy = y0 < b.y ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      edDot(x0, y0);
      if (x0 === b.x && y0 === b.y) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  function edPickColor(p) {
    const ctx = edFlatten().getContext('2d');
    const d = ctx.getImageData(p.x, p.y, 1, 1).data;
    if (d[3] < 8) { toast('Ese píxel está vacío', 'warn'); return; }
    ed.color = '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    $('#edColor').value = ed.color;
  }

  function edAddSwatch(color) {
    if (ed.swatches[0] === color) return;
    ed.swatches = [color].concat(ed.swatches.filter((c) => c !== color)).slice(0, 10);
    const box = $('#edSwatches');
    box.innerHTML = '';
    ed.swatches.forEach((c) => {
      const b = document.createElement('button');
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => { ed.color = c; $('#edColor').value = c; });
      box.appendChild(b);
    });
  }

  function edZoomStep(dir) {
    const i = ED_ZOOMS.indexOf(ed.zoom);
    const next = ED_ZOOMS[Math.max(0, Math.min(ED_ZOOMS.length - 1, (i < 0 ? 3 : i) + dir))];
    ed.zoom = next;
    edRender();
  }

  async function edAddPngLayers(files) {
    let added = 0;
    for (const file of Array.from(files || [])) {
      if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) continue;
      try {
        const img = await loadImageBitmap(file);
        const layer = edNewLayer(file.name.replace(/\.[a-z0-9]+$/i, ''), 'png');
        const ctx = layer.canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, ed.skin.w, ed.skin.h);
        ed.layers.push(layer);
        ed.sel = ed.layers.length - 1;
        added++;
      } catch (err) {
        toast('<b>' + escapeHtml(file.name) + '</b>: ' + err.message, 'error');
      }
    }
    if (added) {
      edRender();
      toast('Añadida' + (added > 1 ? 's ' + added + ' capas' : ' 1 capa') + ' encima. Toca el ojo para ver el antes/después.', 'ok');
    }
  }

  function edBind() {
    if (ed.bound) return;
    ed.bound = true;
    const c = $('#edCanvas');
    const stage = $('#edStage');

    $('#edZoomIn').addEventListener('click', () => edZoomStep(1));
    $('#edZoomOut').addEventListener('click', () => edZoomStep(-1));
    $('#edGridChk').addEventListener('change', () => edRender());
    $$('#edTools .tool').forEach((b) => b.addEventListener('click', () => {
      ed.tool = b.dataset.tool;
      $$('#edTools .tool').forEach((x) => x.classList.toggle('sel', x === b));
    }));
    $('#edColor').addEventListener('input', (e) => { ed.color = e.target.value; });
    $('#edColor').addEventListener('change', (e) => edAddSwatch(e.target.value));
    $('#edUndo').addEventListener('click', () => {
      const snap = ed.undo.pop();
      if (!snap) { toast('Nada que deshacer', 'info'); return; }
      const l = ed.layers.find((x) => x.id === snap.id);
      if (l) l.canvas.getContext('2d').putImageData(snap.data, 0, 0);
      edRender();
    });

    // pintar con ratón o con el dedo
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      ed.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ed.pointers.size === 2) {                     // pellizco para el zoom
        const pts = [...ed.pointers.values()];
        ed.pinch = { dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), zoom: ed.zoom };
        ed.drawing = false;
        return;
      }
      const p = edPoint(e);
      if (!p) return;
      if (ed.tool === 'picker') { edPickColor(p); return; }
      c.setPointerCapture(e.pointerId);
      edPushUndo();
      ed.drawing = true;
      ed.last = p;
      edDot(p.x, p.y);
      if (ed.tool === 'pencil') edAddSwatch(ed.color);
    });
    c.addEventListener('pointermove', (e) => {
      if (ed.pointers.has(e.pointerId)) ed.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ed.pinch && ed.pointers.size === 2) {
        const pts = [...ed.pointers.values()];
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const z = Math.round(ed.pinch.zoom * (d / Math.max(1, ed.pinch.dist)));
        const snap = ED_ZOOMS.reduce((best, v) => (Math.abs(v - z) < Math.abs(best - z) ? v : best), ED_ZOOMS[0]);
        if (snap !== ed.zoom) { ed.zoom = snap; edRender(); }
        return;
      }
      if (!ed.drawing) return;
      const p = edPoint(e);
      if (!p) return;
      edLine(ed.last, p);
      ed.last = p;
    });
    const end = (e) => {
      ed.pointers.delete(e.pointerId);
      if (ed.pointers.size < 2) ed.pinch = null;
      ed.drawing = false;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', (e) => { if (e.buttons === 0) end(e); });

    // rueda del ratón para acercar
    stage.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.shiftKey) return;
      e.preventDefault();
      edZoomStep(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });

    // lista de capas
    $('#edLayerList').addEventListener('click', (e) => {
      const row = e.target.closest('.ed-layer');
      if (!row) return;
      const i = Number(row.dataset.i);
      const act = e.target.closest('[data-act]');
      const what = act ? act.dataset.act : null;
      if (what === 'eye') { ed.layers[i].visible = !ed.layers[i].visible; edRender(); return; }
      if (what === 'del') {
        if (ed.layers.length === 1) { toast('Tiene que quedar al menos una capa', 'warn'); return; }
        ed.layers.splice(i, 1);
        ed.sel = Math.min(ed.sel, ed.layers.length - 1);
        edRender();
        return;
      }
      if (what === 'up') {
        if (i === 0) return;
        const [l] = ed.layers.splice(i, 1);
        ed.layers.splice(i - 1, 0, l);
        ed.sel = i - 1;
        edRender();
        return;
      }
      ed.sel = i;
      edRender();
    });
    $('#edLayerList').addEventListener('input', (e) => {
      const row = e.target.closest('.ed-layer');
      if (!row || !e.target.dataset.act === 'op') return;
      if (e.target.dataset.act !== 'op') return;
      const i = Number(row.dataset.i);
      ed.layers[i].opacity = Number(e.target.value) / 100;
      edRender();
    });

    // subir capas
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,image/webp';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    fileInput.id = 'edFileInput';
    document.body.appendChild(fileInput);
    fileInput.addEventListener('change', async () => {
      await edAddPngLayers(fileInput.files);
      fileInput.value = '';
    });
    $('#edAddLayer').addEventListener('click', () => fileInput.click());
    $('#edAddEmpty').addEventListener('click', () => {
      ed.layers.push(edNewLayer('Capa ' + (ed.layers.length + 1), 'empty'));
      ed.sel = ed.layers.length - 1;
      edRender();
    });
    $('#edFlatten').addEventListener('click', () => {
      const flat = edFlatten();
      const base = ed.layers.find((l) => l.kind === 'base') || ed.layers[0];
      base.canvas.getContext('2d').clearRect(0, 0, base.canvas.width, base.canvas.height);
      base.canvas.getContext('2d').drawImage(flat, 0, 0);
      base.visible = true; base.opacity = 1;
      ed.layers = [base];
      ed.sel = 0;
      edRender();
      toast('Capas aplanadas sobre la base', 'ok');
    });

    // ---- capa de la espalda ----
    const capeUpload = document.createElement('input');
    capeUpload.type = 'file';
    capeUpload.accept = 'image/png,image/jpeg,image/webp';
    capeUpload.style.display = 'none';
    capeUpload.id = 'capeFileInput';
    document.body.appendChild(capeUpload);
    capeUpload.addEventListener('change', async () => {
      const f = capeUpload.files && capeUpload.files[0];
      if (f) {
        try {
          const img = await loadImageBitmap(f);
          capeSet(ed.skin, capeFromImage(img), f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 28));
          renderCapeControls(ed.skin);
        } catch (err) { toast('No se pudo leer el PNG: ' + err.message, 'error'); }
      }
      capeUpload.value = '';
    });
    if ($('#capeUploadBtn')) $('#capeUploadBtn').addEventListener('click', () => capeUpload.click());
    if ($('#capeSearchBtn')) {
      $('#capeSearchBtn').addEventListener('click', () => {
        const q = ($('#capeQuery').value || '').trim() || 'minecraft cape';
        capeBuscar(ed.skin, q);
      });
      $('#capeQuery').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const q = e.target.value.trim() || 'minecraft cape'; capeBuscar(ed.skin, q); }
      });
    }
    if ($('#capeGoogleBtn')) {
      $('#capeGoogleBtn').addEventListener('click', () => {
        const q = ($('#capeQuery').value || '').trim() || 'minecraft cape png';
        window.open('https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(q + ' transparente'), '_blank', 'noopener');
      });
    }
    if ($('#capeClearBtn')) {
      $('#capeClearBtn').addEventListener('click', () => {
        ed.skin.cape = null;
        const sum = $('#capeSummary');
        if (sum) sum.textContent = 'Capa de la espalda (cape)';
        renderCapeControls(ed.skin);
        if (typeof repintar3D === 'function' && repintar3D) repintar3D();
        toast('Capa quitada', 'info');
      });
    }
    if ($('#capeBakeBtn')) $('#capeBakeBtn').addEventListener('click', () => capeBake(ed.skin));
    if ($('#capeDownloadBtn')) {
      $('#capeDownloadBtn').addEventListener('click', () => {
        if (!ed.skin.cape) { toast('Primero elige o sube una capa', 'warn'); return; }
        const c = ed.skin.cape.canvas;
        c.toBlob((blob) => {
          if (!blob) return;
          blob.arrayBuffer().then((buf) => download(new Uint8Array(buf), safeFileName(ed.skin.name || 'skin') + '-capa.png'));
        }, 'image/png');
      });
    }

    $('#edDownload').addEventListener('click', async () => {
      const bytes = await canvasToPngBytes(edFlatten());
      download(bytes, safeFileName(ed.skin.name || 'skin') + '.png');
    });
    $('#edCancel').addEventListener('click', () => {
      ed.skin.layers = ed.snapshot;
      $('#editOverlay').classList.remove('show');
      render();
    });
    $('#edSave').addEventListener('click', async () => {
      const flat = edFlatten();
      const bytes = await canvasToPngBytes(flat);
      const skin = ed.skin;
      skin.png = bytes;
      skin.thumbUrl = canvasToUrl(flat);
      skin.warn = bytes.length > MAX_SAFE_SKIN_BYTES ? 'PNG grande (' + humanSize(bytes.length) + '): puede fallar en consola' : '';
      skin.layers = ed.layers;
      skin.edited = true;
      $('#editOverlay').classList.remove('show');
      render();
      toast('Skin <b>' + escapeHtml(skin.name) + '</b> guardada (' + humanSize(bytes.length) + ')', 'ok');
    });

    if (window.matchMedia && window.matchMedia('(max-width: 700px)').matches) ed.zoom = 6;
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

  /** textura ya volcada a canvas + píxeles (la animación redibuja muchas veces por segundo) */
  const TEXTURAS = new Map();
  function texturaDeSkin(url, img) {
    const ya = TEXTURAS.get(url);
    if (ya) return ya;
    const off = document.createElement('canvas');
    off.width = img.width; off.height = img.height;
    const octx = off.getContext('2d');
    octx.imageSmoothingEnabled = false;
    octx.drawImage(img, 0, 0);
    let pixels = null;
    try { pixels = octx.getImageData(0, 0, off.width, off.height).data; } catch (e) { pixels = null; }
    const datos = { off: off, pixels: pixels, medias: new Map() };
    TEXTURAS.set(url, datos);
    return datos;
  }

  /** imágenes de skin ya decodificadas (la animación redibuja muchas veces por segundo) */
  const IMAGENES_SKIN = new Map();
  function imagenDeSkin(url) {
    let img = IMAGENES_SKIN.get(url);
    if (!img) {
      img = new Image();
      img.src = url;
      IMAGENES_SKIN.set(url, img);
    }
    return img;
  }

  /** animaciones del muñeco: ángulos por parte (radianes) y balanceo vertical */
  const ANIMACIONES = {
    quieto: () => ({
      rot: { HEAD: { y: Math.sin(Date.now() / 900) * 0.14 }, ARM0: { x: 0.04 }, ARM1: { x: 0.04 } }, bob: 0
    }),
    andar: (t) => {
      const s = Math.sin(t * 4.2), c = Math.cos(t * 8.4);
      return {
        rot: {
          LEG0: { x: s * 0.55 }, LEG1: { x: -s * 0.55 },
          ARM0: { x: -s * 0.5 }, ARM1: { x: s * 0.5 },
          BODY: { x: 0.03 }, HEAD: { y: Math.sin(t * 1.1) * 0.1 }
        },
        bob: Math.abs(c) * 0.4
      };
    },
    correr: (t) => {
      const s = Math.sin(t * 7.5), c = Math.cos(t * 15);
      return {
        rot: {
          LEG0: { x: s * 0.95 }, LEG1: { x: -s * 0.95 },
          ARM0: { x: -s * 0.85 }, ARM1: { x: s * 0.85 },
          BODY: { x: 0.18 }, HEAD: { x: -0.12 }
        },
        bob: Math.abs(c) * 0.7
      };
    },
    nadar: (t) => {
      const s = Math.sin(t * 2.6), p = Math.sin(t * 4.4);
      return {
        rot: {
          BODY: { x: 0.5 }, HEAD: { x: -0.4 },
          ARM0: { x: -1.25 + s * 0.95 }, ARM1: { x: -1.25 - s * 0.95 },
          LEG0: { x: p * 0.32 }, LEG1: { x: -p * 0.32 }
        },
        bob: -1
      };
    },
    saltar: () => ({
      rot: { ARM0: { x: -2.3 }, ARM1: { x: -2.3 }, LEG0: { x: 0.28 }, LEG1: { x: -0.28 }, HEAD: { x: -0.12 } },
      bob: 1.2
    }),
    agachado: () => ({
      rot: { BODY: { x: 0.55 }, HEAD: { x: -0.45 }, LEG0: { x: 0.22 }, LEG1: { x: -0.22 }, ARM0: { x: 0.18 }, ARM1: { x: 0.18 } },
      bob: -1.4
    }),
    saludar: (t) => ({
      rot: {
        ARM1: { x: -2.6, y: Math.sin(t * 4) * 0.5 },
        ARM0: { x: 0.1 },
        HEAD: { y: Math.sin(t * 1.6) * 0.14 }
      },
      bob: 0
    })
  };

  /** carpetas del modelo (las seis del jugador) y la parte que las mueve */
  const CARPETAS = [
    ['head', 'HEAD', 'Cabeza'],
    ['body', 'BODY', 'Cuerpo'],
    ['right_arm', 'ARM0', 'Brazo der.'],
    ['left_arm', 'ARM1', 'Brazo izq.'],
    ['right_leg', 'LEG0', 'Pierna der.'],
    ['left_leg', 'LEG1', 'Pierna izq.']
  ];
  const TIPO_DE_CARPETA = { head: 'HEAD', body: 'BODY', right_arm: 'ARM0', left_arm: 'ARM1', right_leg: 'LEG0', left_leg: 'LEG1' };

  /** pivote (punto de giro) de una parte: el que haya puesto el usuario o el del juego */
  function pivoteDe(skin, tipo) {
    const pv = skin && skin.pivotes && skin.pivotes[tipo];
    if (Array.isArray(pv) && pv.length === 3) return pv.map((v) => Number(v) || 0);
    return (PCK.BOX_PIVOT[tipo] || [0, 24, 0]).slice();
  }
  /** ¿el pivote es distinto del que usa el juego? */
  function pivotePropio(skin, tipo) {
    const a = pivoteDe(skin, tipo), b = PCK.BOX_PIVOT[tipo] || [0, 24, 0];
    return a.some((v, i) => Math.abs(v - b[i]) > 0.01);
  }

  /** a qué parte del muñeco va pegada cada pieza de armadura (para animarla con él) */
  const PARTE_DE_ARMADURA = {
    HELMET: 'HEAD', HAT: 'HEAD',
    CHEST: 'BODY', WAIST: 'BODY',
    SHOULDER0: 'ARM0', SHOULDER1: 'ARM1',
    TOOL0: 'ARM0', TOOL1: 'ARM1',
    PANTS0: 'LEG0', PANTS1: 'LEG1',
    BOOT0: 'LEG0', BOOT1: 'LEG1'
  };

  /**
   * Vista 3D isométrica con la skin y, encima, las piezas de armadura.
   * Deja en canvas._lce3d lo necesario para poder arrastrarlas.
   */
  function drawModel3D(canvas, skin, opts) {
    opts = opts || {};
    const boxes = opts.boxes || (skin.model3d ? skin.model3d.boxes : []);
    const W = 420, H = 420;

    // encuadre: el jugador estándar tiene su escala fija; los modelos más grandes
    // (personajes de Blockbench, criaturas…) se centran y se escalan solos para que entren
    let scale = 9, cx = 8, cy = 16;
    if (boxes.length) {
      let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
      boxes.forEach((b) => {
        const ms = PCK.boxToModelSpace(b);
        const inf = (b.inflate || 0) / 2;
        for (let i = 0; i < 3; i++) {
          mn[i] = Math.min(mn[i], ms.min[i] - inf);
          mx[i] = Math.max(mx[i], ms.max[i] + inf);
        }
      });
      const estandar = mn[0] >= -8.6 && mx[0] <= 8.6 && mn[1] >= -0.6 && mx[1] <= 32.6 && mn[2] >= -4.6 && mx[2] <= 4.6;
      if (!estandar) {
        cx = (mn[0] + mx[0]) / 2;
        cy = (mn[1] + mx[1]) / 2;
        const alto = Math.max(1, mx[1] - mn[1]);
        const ancho = Math.max(1, Math.max(mx[0] - mn[0], mx[2] - mn[2]));
        const fondo = Math.max(1, mx[2] - mn[2]);
        const escalaV = (H * 0.84) / (alto * 0.94 + fondo * 0.34);
        const escalaH = (W * 0.84) / (ancho * 1.15 + fondo * 0.7);
        scale = Math.max(1.2, Math.min(14, Math.min(escalaV, escalaH)));
      }
    }
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    canvas._lce3d = null;
    if (!boxes.length) return;

    const yaw = (opts.yaw == null ? Math.PI - 0.6 : opts.yaw), pitch = (opts.pitch == null ? 0.34 : opts.pitch);
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);

    // postura: cada parte gira alrededor de su pivote (es lo que hace el juego al andar)
    const rot = opts.rot || {};
    const bob = Number(opts.bob) || 0;
    /** pivote de cada parte: el del juego, salvo que se haya movido en el editor */
    const pivoteDeTipo = (tipo) => {
      const pv = (opts.pivotes && opts.pivotes[tipo]) || pivoteDe(skin, tipo);
      return pv;
    };
    const aplicarRot = (p, tipo) => {
      let x = p[0], y = p[1] + bob, z = p[2];
      const r = rot[tipo];
      if (r && (r.x || r.y)) {
        const piv = pivoteDeTipo(tipo);
        let dx = x - piv[0], dy = y - piv[1], dz = z - piv[2];
        if (r.x) {
          const c = Math.cos(r.x), s2 = Math.sin(r.x);
          const ny = dy * c - dz * s2;
          dz = dy * s2 + dz * c;
          dy = ny;
        }
        if (r.y) {
          const c = Math.cos(r.y), s2 = Math.sin(r.y);
          const nx = dx * c + dz * s2;
          dz = -dx * s2 + dz * c;
          dx = nx;
        }
        x = dx + piv[0]; y = dy + piv[1]; z = dz + piv[2];
      }
      return [x, y, z];
    };
    const proyectarParte = (p, tipo) => {
      const q = aplicarRot(p, tipo);
      return project(q[0], q[1], q[2]);
    };

    const project = (x, y, z) => {
      const px = x - cx, py = y - cy, pz = z;
      const rx = px * cosY - pz * sinY;
      const rz = px * sinY + pz * cosY;
      const ry = py * cosP - rz * sinP;
      const depth = rz * cosP + py * sinP;
      return { x: W / 2 + rx * scale, y: H / 2 - ry * scale, depth: depth };
    };

    const dibujar = () => {
      const cacheTex = texturaDeSkin(skin.thumbUrl, img);
      const off = cacheTex.off;
      const pixels = cacheTex.pixels;
      /** color medio y alfa media de un trozo de textura (alfa 0 = transparente) */
      const medias = cacheTex.medias;
      const media = (u, v, w, h) => {
        if (!pixels) return { r: 150, g: 150, b: 150, a: 1 };
        const clave = u + '|' + v + '|' + w + '|' + h;
        const guardado = medias.get(clave);
        if (guardado) return guardado;
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
        if (!n) { const vacio = { r: 0, g: 0, b: 0, a: 0 }; medias.set(clave, vacio); return vacio; }
        const col = { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), a: total ? aSum / total / 255 : 1 };
        medias.set(clave, col);
        return col;
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
      const pintarCara = (pts, sx, sy, sw, sh, shade, fuente) => {
        if (sw <= 0 || sh <= 0 || !pixels) return false;
        const p0 = pts[0], p1 = pts[1], p3 = pts[3];
        ctx.save();
        ctx.beginPath();
        pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.closePath();
        ctx.clip();
        ctx.transform((p1.x - p0.x) / sw, (p1.y - p0.y) / sw, (p3.x - p0.x) / sh, (p3.y - p0.y) / sh, p0.x, p0.y);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(fuente || img, sx, sy, Math.max(0.01, sw), Math.max(0.01, sh), 0, 0, sw, sh);
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

      // --- capa de la espalda (cape): un plano detrás del cuerpo ---
      let capaCerca = false;
      if (opts.capa && skin.cape) {
        const ANCHO = 10, ALTO = 16, Y0 = 24, Z0 = 2.35, INCLINA = 0.6;
        const zDe = (y) => Z0 + (Y0 - y) * (INCLINA / ALTO);
        const pts = [
          proyectarParte([-ANCHO / 2, Y0, zDe(Y0)], 'BODY'), proyectarParte([ANCHO / 2, Y0, zDe(Y0)], 'BODY'),
          proyectarParte([ANCHO / 2, Y0 - ALTO, zDe(Y0 - ALTO)], 'BODY'), proyectarParte([-ANCHO / 2, Y0 - ALTO, zDe(Y0 - ALTO)], 'BODY')
        ];
        // ¿la espalda mira a la cámara? entonces la capa se pinta encima de todo
        capaCerca = project(0, 16, Z0).depth > project(0, 16, -2).depth;
        faces.push({ cape: true, pts: pts, tex: [12, 1, 10, 16], depth: 0, stroke: 'rgba(6,10,18,0.35)' });
      }

      // --- skin: base y capas por separado ---
      const dibujadas = { base: 0, capas: 0, armadura: 0 };
      const cajas = [];        // rectángulo en pantalla de cada caja (para tocarla y arrastrarla)
      const pivotesProy = {};  // cruz de cada carpeta
      let tiradores = null;    // tiradores de la caja elegida
      boxes.forEach((box, index) => {
        const esCapa = PCK.OVERLAY_BOX_TYPES.indexOf(box.type) >= 0;
        if (esCapa && opts.capas === false) return;
        if (!esCapa && opts.base === false) return;
        dibujadas[esCapa ? 'capas' : 'base']++;
        const ms = PCK.boxToModelSpace(box);
        const inf = (box.inflate || 0) / 2;
        const b = [[ms.min[0] - inf, ms.min[1] - inf, ms.min[2] - inf], [ms.max[0] + inf, ms.max[1] + inf, ms.max[2] + inf]];
        const w = ms.max[0] - ms.min[0], h = ms.max[1] - ms.min[1], d = ms.max[2] - ms.min[2];
        const uvs = carasUV(box.uv, w, h, d);
        const ocho = [
          [b[0][0], b[0][1], b[0][2]], [b[1][0], b[0][1], b[0][2]],
          [b[0][0], b[1][1], b[0][2]], [b[1][0], b[1][1], b[0][2]],
          [b[0][0], b[0][1], b[1][2]], [b[1][0], b[0][1], b[1][2]],
          [b[0][0], b[1][1], b[1][2]], [b[1][0], b[1][1], b[1][2]]
        ].map((q) => proyectarParte(q, box.type));
        const xs8 = ocho.map((q) => q.x), ys8 = ocho.map((q) => q.y);
        cajas.push({
          i: index, tipo: box.type,
          x0: Math.min.apply(null, xs8), x1: Math.max.apply(null, xs8),
          y0: Math.min.apply(null, ys8), y1: Math.max.apply(null, ys8),
          depth: Math.max.apply(null, ocho.map((q) => q.depth))
        });
        CARAS.forEach((c) => {
          const pts = esquinas(c, b).map((q) => proyectarParte(q, box.type));
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
          const pts = esquinas(c, base).map((q) => proyectarParte(q, PARTE_DE_ARMADURA[tipo] || 'BODY'));
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
      if (faces.some((f) => f.cape)) {
        const tela = faces.filter((f) => f.cape);
        const resto = faces.filter((f) => !f.cape);
        faces.length = 0;
        (capaCerca ? resto.concat(tela) : tela.concat(resto)).forEach((f) => faces.push(f));
      }
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
        if (f.cape) {
          pintarCara(f.pts, f.tex[0], f.tex[1], f.tex[2], f.tex[3], 0.92, skin.cape.canvas);   // 0.92 = un pelín de sombra, como la espalda
          if (f.stroke) {
            ctx.beginPath();
            f.pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
            ctx.closePath();
            ctx.strokeStyle = f.stroke;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
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

      // --- pivotes de las carpetas (se arrastran) ---
      if (opts.verPivotes) {
        CARPETAS.forEach(([carpeta, tipo]) => {
          const pv = pivoteDeTipo(tipo);
          const q = project(pv[0], pv[1], pv[2]);
          const elegido = opts.pivoteSel === tipo;
          const propio = pv.some((v, i) => Math.abs(v - (PCK.BOX_PIVOT[tipo] || [0, 24, 0])[i]) > 0.01);
          pivotesProy[tipo] = { x: q.x, y: q.y, pivote: pv, carpeta: carpeta, propio: propio };
          const color = elegido ? '#ffb457' : (propio ? '#ff8f5a' : '#6cc4ff');
          ctx.save();
          if (!propio) { ctx.setLineDash([3, 3]); }
          ctx.strokeStyle = color;
          ctx.lineWidth = elegido ? 2 : 1.2;
          ctx.beginPath(); ctx.moveTo(q.x, q.y - 11); ctx.lineTo(q.x, q.y + 11); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(q.x - 11, q.y); ctx.lineTo(q.x + 11, q.y); ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath(); ctx.arc(q.x, q.y, elegido ? 6 : 4, 0, Math.PI * 2);
          ctx.fillStyle = color; ctx.fill();
          ctx.strokeStyle = 'rgba(8,12,20,0.85)'; ctx.lineWidth = 1; ctx.stroke();
          if (elegido) {
            ctx.font = '600 11px system-ui, sans-serif';
            ctx.fillStyle = 'rgba(10,14,22,0.75)';
            const txt = carpeta + '  ' + pv.map((v) => Math.round(v)).join(', ');
            const an = ctx.measureText(txt).width;
            const aIzq = q.x + 15 + an > W - 6;         // que la etiqueta no se salga del lienzo
            const x0 = aIzq ? q.x - 15 - an : q.x + 10;
            ctx.fillRect(x0, q.y - 22, an + 10, 16);
            ctx.fillStyle = '#ffd9a8';
            ctx.fillText(txt, x0 + 5, q.y - 10);
          }
          ctx.restore();
        });
      }

      // --- caja elegida: marco y tiradores para mover / estirar ---
      const elegidaIdx = opts.cajaSel;
      const rectElegida = elegidaIdx == null ? null : cajas.find((z) => z.i === elegidaIdx);
      if (rectElegida && opts.modo === 'caja') {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(255,196,110,0.95)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(rectElegida.x0, rectElegida.y0, rectElegida.x1 - rectElegida.x0, rectElegida.y1 - rectElegida.y0);
        ctx.setLineDash([]);
        const cuadro = (x, y, col, letra) => {
          ctx.fillStyle = col;
          ctx.fillRect(x - 6, y - 6, 12, 12);
          ctx.strokeStyle = 'rgba(8,12,20,0.9)'; ctx.lineWidth = 1.5;
          ctx.strokeRect(x - 6, y - 6, 12, 12);
          if (letra) {
            ctx.fillStyle = '#0b0f18';
            ctx.font = '700 9px system-ui, sans-serif';
            ctx.fillText(letra, x - 3, y + 3);
          }
        };
        tiradores = {
          w: { x: rectElegida.x1 + 10, y: (rectElegida.y0 + rectElegida.y1) / 2 },
          h: { x: (rectElegida.x0 + rectElegida.x1) / 2, y: rectElegida.y0 - 10 },
          d: { x: rectElegida.x1 + 10, y: rectElegida.y0 - 10 }
        };
        cuadro(tiradores.w.x, tiradores.w.y, '#ffb457', 'A');
        cuadro(tiradores.h.x, tiradores.h.y, '#7ee081', 'H');
        cuadro(tiradores.d.x, tiradores.d.y, '#6cc4ff', 'F');
        ctx.restore();
      }

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

      canvas._lce3d = {
        piezas: piezas, dibujadas: dibujadas, escala: scale, alto: H, ancho: W,
        cajas: cajas, pivotes: pivotesProy, tiradores: tiradores,
        // datos para pasar de "píxeles arrastrados" a "píxeles del modelo"
        proy: { escala: scale, cosY: cosY, sinY: sinY, cosP: cosP, sinP: sinP, cx: cx, cy: cy }
      };
    };
    const img = imagenDeSkin(skin.thumbUrl);
    if (img.complete && img.naturalWidth) dibujar();
    else img.onload = dibujar;

    function b0(tipo, bx) { return armorPieceBox(tipo, bx); }
  }

  /**
   * Arrastrar en la vista 3D. Según el modo elegido:
   *   girar   → gira el muñeco (y mueve las piezas de armadura)
   *   caja    → mueve la caja que toques y estira con los tiradores A / H / F
   *   pivote  → mueve el punto de giro de cada carpeta
   */
  function initDrag3D(canvas, api) {
    canvas._lceApi = api;
    canvas._lceCtx = Object.assign(canvas._lceCtx || {}, {
      skin: api.skin,
      onChange: (tipo, valor, inicio) => canvas._lceApi.onArmor(tipo, valor, inicio),
      sel: () => canvas._lceApi.getArmor()
    });
    if (canvas._lceBound) return;
    canvas._lceBound = true;

    let arrastre = null;

    const punto = (ev) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: (ev.clientX - r.left) * (canvas.width / r.width),
        y: (ev.clientY - r.top) * (canvas.height / r.height)
      };
    };
    /** cómo se mueve en pantalla un paso de 1 píxel en cada eje del modelo */
    const vectores = (pr) => ({
      x: [pr.cosY * pr.escala, pr.sinP * pr.sinY * pr.escala],
      y: [0, -pr.cosP * pr.escala],
      z: [-pr.sinY * pr.escala, pr.sinP * pr.cosY * pr.escala]
    });
    /** cuántos píxeles del modelo hay en un arrastre de pantalla sobre ese eje */
    const proyecta = (d, v) => {
      const l2 = v[0] * v[0] + v[1] * v[1];
      return l2 ? (d[0] * v[0] + d[1] * v[1]) / l2 : 0;
    };
    /**
     * Arrastre de pantalla → píxeles del modelo. Horizontal mueve X y vertical mueve Y
     * (sin mezclarlos: así el muñeco no se va de lado cuando lo subes).
     */
    const enPlano = (d, v) => [
      Math.abs(v.x[0]) > 1e-6 ? d[0] / v.x[0] : 0,
      Math.abs(v.y[1]) > 1e-6 ? d[1] / v.y[1] : 0
    ];
    const piezaEn = (p) => {
      const st = canvas._lce3d;
      if (!st) return null;
      const dentro = st.piezas.filter((z) => p.x >= z.x0 && p.x <= z.x1 && p.y >= z.y0 && p.y <= z.y1);
      dentro.sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0));
      return dentro[0] || null;
    };
    /** la caja de la skin que hay debajo (la que está más cerca de la cámara) */
    const cajaEn = (p) => {
      const st = canvas._lce3d;
      if (!st || !st.cajas) return null;
      const dentro = st.cajas.filter((z) => p.x >= z.x0 && p.x <= z.x1 && p.y >= z.y0 && p.y <= z.y1);
      dentro.sort((a, b) => b.depth - a.depth);
      return dentro.length ? dentro[0].i : null;
    };
    const pivoteEn = (p) => {
      const st = canvas._lce3d;
      if (!st || !st.pivotes) return null;
      let mejor = 20, quien = null;
      Object.keys(st.pivotes).forEach((t) => {
        const m = st.pivotes[t];
        const d = Math.hypot(m.x - p.x, m.y - p.y);
        if (d <= mejor) { mejor = d; quien = t; }
      });
      return quien;
    };

    canvas.addEventListener('pointerdown', (ev) => {
      const A = canvas._lceApi;
      const st = canvas._lce3d;
      if (!A || !st) return;
      const p = punto(ev);
      const modo = A.getModo();
      const agarrar = (datos) => {
        arrastre = datos;
        arrastre.ini = { x: ev.clientX, y: ev.clientY };
        arrastre.proy = st.proy;
        try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* noop */ }
        canvas.classList.add('arrastrando');
        ev.preventDefault();
      };

      // 1) pivotes de las carpetas
      if (modo === 'pivote') {
        const quien = pivoteEn(p);
        if (quien) {
          A.setPivoteSel(quien);
          agarrar({ tipo: 'pivote', parte: quien, base: st.pivotes[quien].pivote.slice() });
          return;
        }
      }

      // 2) cajas de la skin: tiradores primero, luego la caja que toques
      if (modo === 'caja') {
        const sel = A.getCaja();
        if (sel != null && st.tiradores) {
          const ejes = ['w', 'h', 'd'];
          for (let k = 0; k < ejes.length; k++) {
            const t = st.tiradores[ejes[k]];
            if (Math.hypot(t.x - p.x, t.y - p.y) <= 17) {
              const base = A.getCajaModelo(sel);
              if (base) { agarrar({ tipo: 'estirar', eje: ejes[k], i: sel, base: base }); return; }
            }
          }
        }
        const bajo = cajaEn(p);
        if (bajo != null) {
          A.setCaja(bajo);
          const base = A.getCajaModelo(bajo);
          if (base) { agarrar({ tipo: 'caja', i: bajo, base: base }); return; }
        }
      }

      // 3) armadura (solo en el modo de girar, como siempre)
      if (modo === 'girar') {
        const elegida = A.getArmor();
        const rectSel = elegida ? st.piezas.find((z) => z.tipo === elegida) : null;
        const dentroSel = rectSel && p.x >= rectSel.x0 && p.x <= rectSel.x1 && p.y >= rectSel.y0 && p.y <= rectSel.y1;
        const pieza = dentroSel ? { tipo: elegida } : piezaEn(p);
        if (pieza) {
          const off0 = Number((A.skin.offsets || {})[pieza.tipo]) || 0;
          A.onArmor(pieza.tipo, off0, true);
          agarrar({ tipo: 'armadura', parte: pieza.tipo, y0: ev.clientY, off0: off0 });
          return;
        }
      }

      // 4) si no hay nada debajo: girar el muñeco
      arrastre = { tipo: 'girar', x: ev.clientX, y: ev.clientY };
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* noop */ }
      canvas.classList.add('arrastrando');
      ev.preventDefault();
    });

    canvas.addEventListener('pointermove', (ev) => {
      const A = canvas._lceApi;
      const p = punto(ev);
      if (!arrastre) {
        let cur = 'default';
        const modo = A.getModo();
        if (modo === 'caja' && cajaEn(p) != null) cur = 'move';
        else if (modo === 'pivote' && pivoteEn(p)) cur = 'grab';
        else if (modo === 'girar' && piezaEn(p)) cur = 'ns-resize';
        canvas.style.cursor = cur;
        return;
      }
      if (arrastre.tipo === 'girar') {
        A.rotar(ev.clientX - arrastre.x, ev.clientY - arrastre.y);
        arrastre.x = ev.clientX;
        arrastre.y = ev.clientY;
        ev.preventDefault();
        return;
      }
      const rCaja = canvas.getBoundingClientRect();
      const kPx = rCaja.width ? canvas.width / rCaja.width : 1;   // píxeles CSS → píxeles del lienzo
      const d = [(ev.clientX - arrastre.ini.x) * kPx, (ev.clientY - arrastre.ini.y) * kPx];
      if (arrastre.tipo === 'armadura') {
        const r = canvas.getBoundingClientRect();
        const escalaPx = (canvas._lce3d ? canvas._lce3d.escala : 9) * (r.height / canvas.height);
        const delta = Math.round((ev.clientY - arrastre.y0) / escalaPx);
        A.onArmor(arrastre.parte, arrastre.off0 + delta, false);
        ev.preventDefault();
        return;
      }
      const v = vectores(arrastre.proy);
      if (arrastre.tipo === 'caja') {
        const plano = enPlano(d, v);
        const fondo = ev.shiftKey || A.getFondo();
        const dz = fondo ? proyecta(d, v.z) : 0;
        const paso = [plano[0], plano[1], dz].map((n) => Math.round(n));
        const min = arrastre.base.min.map((n, k) => n + paso[k]);
        const max = arrastre.base.max.map((n, k) => n + paso[k]);
        A.colocarCaja(arrastre.i, min, max);
        ev.preventDefault();
        return;
      }
      if (arrastre.tipo === 'estirar') {
        const eje = arrastre.eje === 'w' ? 0 : (arrastre.eje === 'h' ? 1 : 2);
        // el tirador siempre crece al arrastrarlo hacia fuera (derecha / arriba), gire como gire la vista
        const k = eje === 0 ? Math.round(d[0] / Math.max(1e-6, Math.abs(v.x[0])))
          : eje === 1 ? Math.round(-d[1] / Math.max(1e-6, Math.abs(v.y[1])))
            : Math.round(proyecta(d, v.z));
        const min = arrastre.base.min.slice(), max = arrastre.base.max.slice();
        max[eje] = Math.max(min[eje] + 1, arrastre.base.max[eje] + k);
        A.colocarCaja(arrastre.i, min, max);
        ev.preventDefault();
        return;
      }
      if (arrastre.tipo === 'pivote') {
        const plano = enPlano(d, v).map((n) => Math.round(n));
        A.colocarPivote(arrastre.parte, [
          Math.round(arrastre.base[0] + plano[0]),
          Math.round(arrastre.base[1] + plano[1]),
          Math.round(arrastre.base[2])
        ]);
        ev.preventDefault();
      }
    });

    const fin = (ev) => {
      if (!arrastre) return;
      const A = canvas._lceApi;
      const tipo = arrastre.tipo;
      arrastre = null;
      canvas.classList.remove('arrastrando');
      canvas.style.cursor = 'default';
      try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* noop */ }
      if (A && A.finArrastre) A.finArrastre(tipo);
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
