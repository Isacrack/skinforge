#!/usr/bin/env node
/**
 * Valida los .bbmodel de ejemplo (node test/bbmodel.test.js)
 *
 * Comprueba que el árbol de carpetas es coherente y que Blockbench lo puede leer:
 * formato 5.0, uuid únicos, cada cubo dentro de exactamente una carpeta, y cada
 * nodo del outliner casando con su entrada de `groups`.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'ejemplos');
const archivos = fs.readdirSync(DIR).filter((f) => f.endsWith('.bbmodel')).sort();

let fallos = 0;
const ok = (nombre, cond, detalle) => {
  if (!cond) { fallos++; console.log('  FALLO ' + nombre + (detalle ? ' → ' + detalle : '')); }
  else console.log('  OK    ' + nombre);
};

if (!archivos.length) {
  console.error('No hay .bbmodel en ejemplos/ (ejecuta node tools/mkbbmodel.js)');
  process.exit(1);
}

archivos.forEach((archivo) => {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, archivo), 'utf8'));
  console.log('\n' + archivo);

  ok('formato bbmodel 5.0', j.meta && j.meta.format_version === '5.0', j.meta && j.meta.format_version);
  ok('model_format java_block', j.meta && j.meta.model_format === 'java_block');
  ok('lleva textura dentro', Array.isArray(j.textures) && /^data:image\/png;base64,/.test(j.textures[0].source));
  ok('resolución 64×64', j.resolution && j.resolution.width === 64 && j.resolution.height === 64);

  const cubos = j.elements || [];
  const ids = cubos.map((e) => e.uuid);
  ok('cada cubo tiene uuid', ids.every(Boolean));
  ok('uuid de cubos únicos', new Set(ids).size === ids.length);

  const grupos = j.groups || [];
  ok('hay carpetas', grupos.length > 0, grupos.length + ' grupos');
  ok('cada carpeta tiene nombre y uuid', grupos.every((g) => g.uuid && g.name));
  ok('en 5.0 los grupos no llevan children', grupos.every((g) => !('children' in g)));

  const outliner = j.outliner || [];
  ok('outliner con nodos {uuid, isOpen, children}',
    outliner.every((n) => typeof n === 'object' && n.uuid && Array.isArray(n.children)));

  // recorrer el árbol
  const enCarpeta = {};
  const recorrer = (nodos, carpeta) => {
    nodos.forEach((n) => {
      if (typeof n === 'string') {
        enCarpeta[n] = enCarpeta[n] || [];
        enCarpeta[n].push(carpeta || '(raíz)');
        return;
      }
      const nombre = (grupos.find((g) => g.uuid === n.uuid) || {}).name || n.name || '?';
      recorrer(n.children || [], nombre);
    });
  };
  recorrer(outliner, null);

  const huerfanos = ids.filter((id) => !enCarpeta[id]);
  ok('ningún cubo fuera de las carpetas', huerfanos.length === 0, huerfanos.join(', '));
  const repetidos = ids.filter((id) => (enCarpeta[id] || []).length > 1);
  ok('ningún cubo en dos carpetas a la vez', repetidos.length === 0, repetidos.join(', '));
  ok('no sobran nodos en el outliner',
    Object.keys(enCarpeta).every((id) => ids.includes(id)));

  const nodosOutliner = outliner.map((n) => n.uuid);
  ok('cada carpeta aparece en el outliner', grupos.every((g) => nodosOutliner.includes(g.uuid)));
  ok('cada nodo del outliner tiene su grupo', nodosOutliner.every((u) => grupos.some((g) => g.uuid === u)));

  // UV por cara coherentes con el tamaño y el uv_offset (desplegado de caja)
  const malosUv = [];
  cubos.forEach((e) => {
    const w = Math.abs(e.to[0] - e.from[0]), h = Math.abs(e.to[1] - e.from[1]), d = Math.abs(e.to[2] - e.from[2]);
    const [u, v] = e.uv_offset || [0, 0];
    const esperado = {
      north: [u + d, v + d, u + d + w, v + d + h],
      east: [u, v + d, u + d, v + d + h],
      south: [u + d + w, v + d, u + 2 * d + w, v + d + h],
      west: [u + 2 * d + w, v + d, u + 2 * (d + w), v + d + h],
      up: [u + d, v, u + d + w, v + d],
      down: [u + d + w, v, u + 2 * d + w, v + d]
    };
    Object.keys(esperado).forEach((cara) => {
      const f = (e.faces || {})[cara];
      if (!f || JSON.stringify(f.uv) !== JSON.stringify(esperado[cara])) {
        malosUv.push(e.name + '.' + cara + ' = ' + JSON.stringify(f && f.uv) + ' (esperado ' + JSON.stringify(esperado[cara]) + ')');
      }
      if (f && (f.uv[2] - f.uv[0]) * (f.uv[3] - f.uv[1]) === 0) malosUv.push(e.name + '.' + cara + ' sin área');
      if (f && (f.uv[2] > 64 || f.uv[3] > 64 || f.uv[0] < 0 || f.uv[1] < 0)) malosUv.push(e.name + '.' + cara + ' fuera de la textura');
    });
  });
  ok('UV por cara = desplegado estándar de caja', malosUv.length === 0, malosUv.slice(0, 3).join(' | '));

  // nombres de cubo que la herramienta sabe emparejar
  const CONOCIDOS = /^(head|hat|body|jacket|right_arm|right_sleeve|left_arm|left_sleeve|right_leg|right_pants|left_leg|left_pants|right_pad|left_pad|crest)$/;
  const raros = cubos.filter((e) => !CONOCIDOS.test(e.name)).map((e) => e.name);
  ok('nombres de cubo reconocibles por la herramienta', raros.length === 0, raros.join(', '));

  // resumen del árbol
  recorrer.toString();
  const arbol = grupos.map((g) => {
    const hijos = cubos.filter((e) => (enCarpeta[e.uuid] || []).includes(g.name)).map((e) => e.name);
    return g.name + ' [' + hijos.join(', ') + ']';
  });
  console.log('  árbol: ' + arbol.join('  '));
});

console.log('\n' + (fallos ? fallos + ' COMPROBACIONES FALLIDAS' : 'BBMODEL OK (' + archivos.length + ' ficheros)'));
process.exit(fallos ? 1 : 0);
