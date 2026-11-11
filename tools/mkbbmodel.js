#!/usr/bin/env node
/**
 * Genera los .bbmodel de ejemplo (node tools/mkbbmodel.js)
 *
 * Crea en ejemplos/ tres proyectos de Blockbench listos para abrir, editar y
 * volver a arrastrar a la página. La textura va dentro del propio .bbmodel,
 * y cada cubo lleva la propiedad `lce_armor` con la máscara que debe traer
 * marcada la herramienta al importarlo (1 casco, 2 peto, 4 gregüesco, 8 botas).
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'ejemplos');
const PNG = path.join(__dirname, '..', 'test', 'out');

const { randomUUID } = require('crypto');
const uuid = () => randomUUID();

const dataUrl = (file) => 'data:image/png;base64,' + fs.readFileSync(path.join(PNG, file)).toString('base64');

/**
 * UV por cara a partir de la posición y el tamaño del cubo (desplegado estándar
 * de Minecraft para box UV). Con `box_uv: true` Blockbench lo recalcula, pero así
 * el fichero también se ve bien en visores que leen `faces` tal cual.
 */
function caras(from, to, uv) {
  const w = Math.abs(to[0] - from[0]);
  const h = Math.abs(to[1] - from[1]);
  const d = Math.abs(to[2] - from[2]);
  const [u, v] = uv;
  return {
    north: { uv: [u + d, v + d, u + d + w, v + d + h] },              // frente
    east: { uv: [u, v + d, u + d, v + d + h] },                       // derecha
    south: { uv: [u + d + w, v + d, u + 2 * d + w, v + d + h] },      // espalda
    west: { uv: [u + 2 * d + w, v + d, u + 2 * (d + w), v + d + h] }, // izquierda
    up: { uv: [u + d, v, u + d + w, v + d] },                         // arriba
    down: { uv: [u + d + w, v, u + 2 * d + w, v + d] }                // abajo
  };
}

/** cubo con uv_offset; lce_armor = máscara de armadura sugerida */
function cube(name, from, to, uv, armor = 0, inflate = 0) {
  return {
    uuid: uuid(),
    type: 'cube',
    name,
    from,
    to,
    origin: [0, 24, 0],
    uv_offset: uv,
    box_uv: true,
    rotation: [0, 0, 0],
    inflate,
    lce_armor: armor,
    faces: caras(from, to, uv)
  };
}

/**
 * Agrupa los cubos en carpetas del outliner, como el modelo de jugador de Blockbench.
 * grupos: { nombre: [nombres de cubo] }
 */
function agrupar(elements, grupos) {
  const byName = {};
  elements.forEach((e) => { byName[e.name] = e; });
  const groups = [];
  const asignados = new Set();
  Object.keys(grupos).forEach((nombre) => {
    const hijos = grupos[nombre].map((n) => byName[n]).filter(Boolean);
    if (!hijos.length) return;
    groups.push({
      uuid: uuid(),
      name: nombre,
      origin: [0, 24, 0],
      children: hijos.map((h) => { asignados.add(h.name); return h.uuid; })
    });
  });
  return groups;
}

function modelo(name, elements, texture, size, grupos) {
  const groups = agrupar(elements, grupos || {});
  const sueltos = elements.filter((e) => !groups.some((g) => g.children.includes(e.uuid)));
  // Blockbench 5.0: el árbol vive en `outliner` ({uuid, isOpen, children}) y los
  // datos del grupo (nombre, origen) en `groups`, unidos por uuid.
  const outliner = groups.map((g) => ({ uuid: g.uuid, isOpen: true, children: g.children }))
    .concat(sueltos.map((e) => e.uuid));
  return {
    groups: groups.map((g) => ({ uuid: g.uuid, name: g.name, origin: g.origin, rotation: [0, 0, 0] })),
    meta: { format_version: '5.0', model_format: 'java_block', box_uv: true },
    name,
    resolution: { width: size[0], height: size[1] },
    elements,
    outliner: outliner,
    textures: [{
      name: 'skin.png',
      id: '0',
      source: texture,
      uv_width: size[0],
      uv_height: size[1],
      particle: false
    }],
    lce: {
      formato: 'bbmodel 5.0 (carpetas en outliner + groups, unidos por uuid)',
      nota: 'Modelo de ejemplo para SkinForge. Los nombres de los cubos deben ser head, hat, body, jacket, right_arm, right_sleeve, left_arm, left_sleeve, right_leg, right_pants, left_leg, left_pants.',
      armor_hint: 'lce_armor: 1 casco · 2 peto · 4 gregüesco · 8 botas (se suman)'
    }
  };
}

/* ---------------------------------------------------------------- */
/* 1. Jugador estándar (Steve 64×64), 12 partes                      */
/* ---------------------------------------------------------------- */
const estandar = modelo('Jugador estándar', [
  cube('head', [-4, 24, -4], [4, 32, 4], [0, 0], 0),
  cube('hat', [-4, 24, -4], [4, 32, 4], [32, 0], 1, 0.5),
  cube('body', [-4, 12, -2], [4, 24, 2], [16, 16], 0),
  cube('jacket', [-4, 12, -2], [4, 24, 2], [16, 32], 2, 0.25),
  cube('right_arm', [-8, 12, -2], [-4, 24, 2], [40, 16], 0),
  cube('right_sleeve', [-8, 12, -2], [-4, 24, 2], [40, 32], 2, 0.25),
  cube('left_arm', [4, 12, -2], [8, 24, 2], [32, 48], 0),
  cube('left_sleeve', [4, 12, -2], [8, 24, 2], [48, 48], 2, 0.25),
  cube('right_leg', [-4, 0, -2], [0, 12, 2], [0, 16], 0),
  cube('right_pants', [-4, 0, -2], [0, 12, 2], [0, 32], 4, 0.25),
  cube('left_leg', [0, 0, -2], [4, 12, 2], [16, 48], 0),
  cube('left_pants', [0, 0, -2], [4, 12, 2], [0, 48], 4, 0.25)
], dataUrl('steve.png'), [64, 64], {
  head: ['head', 'hat'],
  body: ['body', 'jacket'],
  right_arm: ['right_arm', 'right_sleeve'],
  left_arm: ['left_arm', 'left_sleeve'],
  right_leg: ['right_leg', 'right_pants'],
  left_leg: ['left_leg', 'left_pants']
});

/* ---------------------------------------------------------------- */
/* 2. Caballero: cabeza más grande, hombreras y capa (armadura)      */
/* ---------------------------------------------------------------- */
const caballero = modelo('Caballero (armadura)', [
  // cabeza 10×10×10 en vez de 8×8×8 → el casco del juego quedaría dentro:
  // por eso `head` y `hat` se marcan con casco (1)
  cube('head', [-5, 24, -5], [5, 34, 5], [0, 0], 1),
  // la capa estándar (8×8×8) sí cabe en 32,0: en un cubo de 10×10×10 se saldría de la textura
  cube('hat', [-4, 25, -4], [4, 33, 4], [32, 0], 1, 0.5),
  cube('body', [-4, 12, -2], [4, 24, 2], [16, 16], 0),
  cube('jacket', [-4, 12, -2], [4, 24, 2], [16, 32], 2, 0.25),
  cube('right_arm', [-8, 12, -2], [-4, 24, 2], [40, 16], 0),
  cube('right_sleeve', [-8, 12, -2], [-4, 24, 2], [40, 32], 2, 0.25),
  cube('left_arm', [4, 12, -2], [8, 24, 2], [32, 48], 0),
  cube('left_sleeve', [4, 12, -2], [8, 24, 2], [48, 48], 2, 0.25),
  cube('right_leg', [-4, 0, -2], [0, 12, 2], [0, 16], 0),
  cube('right_pants', [-4, 0, -2], [0, 12, 2], [0, 32], 4, 0.25),
  cube('left_leg', [0, 0, -2], [4, 12, 2], [16, 48], 0),
  cube('left_pants', [0, 0, -2], [4, 12, 2], [0, 48], 4, 0.25),
  // cajas extra (mismo tipo que su parte): hombreras que se ocultan con el peto
  cube('right_pad', [-9, 23, -3], [-3, 26, 3], [0, 32], 2),
  cube('left_pad', [3, 23, -3], [9, 26, 3], [0, 32], 2),
  // cresta del casco: se oculta con el casco
  cube('crest', [-1, 34, -5], [1, 36, 3], [44, 44], 1)
], dataUrl('steve.png'), [64, 64], {
  head: ['head', 'hat', 'crest'],
  body: ['body', 'jacket'],
  right_arm: ['right_arm', 'right_sleeve', 'right_pad'],
  left_arm: ['left_arm', 'left_sleeve', 'left_pad'],
  right_leg: ['right_leg', 'right_pants'],
  left_leg: ['left_leg', 'left_pants']
});

/* ---------------------------------------------------------------- */
/* 3. Explorador slim (Alex 64×64, brazos de 3 px)                  */
/* ---------------------------------------------------------------- */
const slim = modelo('Explorador slim', [
  cube('head', [-4, 24, -4], [4, 32, 4], [0, 0], 0),
  cube('hat', [-4, 24, -4], [4, 32, 4], [32, 0], 1, 0.5),
  cube('body', [-4, 12, -2], [4, 24, 2], [16, 16], 0),
  cube('jacket', [-4, 12, -2], [4, 24, 2], [16, 32], 2, 0.25),
  cube('right_arm', [-7, 12, -2], [-4, 24, 2], [40, 16], 0),
  cube('right_sleeve', [-7, 12, -2], [-4, 24, 2], [40, 32], 2, 0.25),
  cube('left_arm', [4, 12, -2], [7, 24, 2], [32, 48], 0),
  cube('left_sleeve', [4, 12, -2], [7, 24, 2], [48, 48], 2, 0.25),
  cube('right_leg', [-4, 0, -2], [0, 12, 2], [0, 16], 0),
  cube('right_pants', [-4, 0, -2], [0, 12, 2], [0, 32], 4, 0.25),
  cube('left_leg', [0, 0, -2], [4, 12, 2], [16, 48], 0),
  cube('left_pants', [0, 0, -2], [4, 12, 2], [0, 48], 4, 0.25)
], dataUrl('alex.png'), [64, 64], {
  head: ['head', 'hat'],
  body: ['body', 'jacket'],
  right_arm: ['right_arm', 'right_sleeve'],
  left_arm: ['left_arm', 'left_sleeve'],
  right_leg: ['right_leg', 'right_pants'],
  left_leg: ['left_leg', 'left_pants']
});

fs.mkdirSync(OUT, { recursive: true });
const archivos = [
  ['jugador-estandar.bbmodel', estandar],
  ['caballero-armadura.bbmodel', caballero],
  ['explorador-slim.bbmodel', slim]
];
archivos.forEach(([nombre, json]) => {
  const destino = path.join(OUT, nombre);
  fs.writeFileSync(destino, JSON.stringify(json, null, '\t'));
  console.log('·', nombre, (fs.statSync(destino).size / 1024).toFixed(1) + ' KB',
    json.elements.length + ' cubos en', json.groups.length + ' grupos');
});
