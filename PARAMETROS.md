# Parámetros exactos del `.pck` (los que escribe y espera la herramienta)

Hoja de referencia de todo lo que va dentro del fichero. Cada valor está comprobado por
`node test/params.js` (**86 comprobaciones**), que audita un `.pck` recién generado.

> Regla de oro: **PS3 = big endian**. Todos los enteros de abajo van en big endian para PS3/360/WiiU
> y en little endian para PS4/Vita/Switch. Los strings son **siempre UTF-16** (nunca UTF-8), salvo el `.loc`,
> que es UTF-8.

---

## 1. Cabecera del contenedor

| Orden | Campo | Valor que escribimos |
|---|---|---|
| 1 | `int32` **pckType** | `3` |
| 2 | `int32` **count** de la LUT | nº de nombres de parámetro (7–9) |
| 3 | `int32 index` + string, ×count | `PACKID`, `PACKVERSION`, `DISPLAYNAME`, `DISPLAYNAMEID`, `THEMENAME`, `THEMENAMEID`, `ANIM`, `GAME_FLAGS`, `FREE`, `BOX` |
| 4 | `int32` **xmlVersion** | **solo si `XMLVERSION` está en la LUT**. `0`/ausente en packs antiguos, `2` o `3` con modelo 3D |
| 5 | `int32` **assetCount** | nº de assets |
| 6 | por asset: `int32 size`, `int32 type`, string **filename** | |
| 7 | por asset: `int32 propCount`, (`int32 keyIndex` + string valor)×propCount, y `size` bytes de contenido | |

**String:** `int32 len` + `len*2` bytes UTF-16 + `int32 0` (terminador).
`len` cuenta **caracteres**, no bytes: `"PACKID"` → `6`, `12` bytes, `00000000`.

---

## 2. Tipos de asset usados

| Tipo | Nombre | Qué lleva |
|---|---|---|
| `4` | `InfoFile` | fichero llamado `0`, **0 bytes** de contenido; params `PACKID`, `PACKVERSION` |
| `6` | `LocalisationFile` | `localisation.loc` (ver §5) |
| `0` | `SkinFile` | `dlcskin########.png` + params de skin |
| `2`, `5`, `8`, `9`, `11` | textura / TexturePackInfo / audio / ColourTable / SkinData | pestaña de texture packs |

---

## 3. Parámetros de una skin (tipo 0)

| Parámetro | Valor | Obligatorio |
|---|---|---|
| `DISPLAYNAME` | nombre visible | sí |
| `DISPLAYNAMEID` | `IDS_dlcskin<ID>_DISPLAYNAME` (exactamente el mismo que la clave del `.loc`) | sí |
| `THEMENAME` | tema | solo si hay tema |
| `THEMENAMEID` | `IDS_dlcskin<ID>_THEMENAME` | solo si hay tema |
| `ANIM` | `0x` + 8 dígitos hex (ver §4) | sí |
| `GAME_FLAGS` | `0x18` | sí |
| `FREE` | `1` (skin gratuita, no cuenta en el contador de desbloqueos) | sí |
| `BOX` | una entrada **por caja** (ver §6) | solo si hay modelo 3D |

Fichero: **`dlcskin` + exactamente 8 dígitos decimales + `.png`**. ID fuera de
`100000…99999999` o con algo que no sea un dígito → el juego la trata como *ID 0*
(aparece como «Auto Select»).

---

## 4. `ANIM` según el modelo

| Modelo | Skin | `ANIM` |
|---|---|---|
| Clásico | 64×32 | `0x00000000` |
| Moderno ancho (Steve) | 64×64 | `0x00040000` |
| Alex / slim | 64×64, brazos de 3 px | `0x00080000` |

Se escribe **con el prefijo `0x`** y **8 dígitos**: el juego no acepta un entero pelado.
Otros bits (brazos de zombi, sentarse, ocultar partes) existen desde TU7 pero la herramienta no los toca.

---

## 5. `localisation.loc` (tipo 6)

| Campo | Valor |
|---|---|
| `int32 version` | `2` |
| `int32 langCount` | `1` |
| `bool hasUids` | `false` (1 byte) — solo en v2 |
| `int32 keyCount` + claves (`uint16 len` + UTF-8) | claves de abajo |
| por idioma: string + `int32 size` | `en-EN` |
| por idioma: `int32 version` `2`, `bool hasUids` (1 byte), string idioma, `int32 keyCount`, y por clave `uint16 len`+UTF-8 + `uint16 len`+UTF-8 | |

Claves que escribimos:

- `IDS_DISPLAY_NAME` → nombre del pack (el que sale en la pestaña del juego)
- `IDS_dlcskin<ID>_DISPLAYNAME` → nombre de cada skin
- `IDS_dlcskin<ID>_THEMENAME` → tema, si lo hay

Los acentos y emojis viajan en **UTF-8 dentro del `.loc`** y en **UTF-16 dentro del `.pck`**.

---

## 6. Parámetro `BOX` (geometría)

```
BOX  TIPO  X Y Z  ANCHO ALTO FONDO  U V  [máscaraArmadura] [espejo] [inflado]
```

- **9 argumentos** mínimo; 11 si hay máscara+espejo; 12 con inflado.
- Decimales **con punto** (`0.25`), nunca con coma. Un `,` rompe el parseo del juego.
- `X Y Z` = esquina mínima de la caja **relativa al pivote de esa parte**.
- **Eje Y invertido**: negativo = más arriba. Subir una cabeza a 28–36 da `Y = -12`.
- `ANCHO ALTO FONDO` y las posiciones se **truncan a enteros**: la herramienta redondea antes de escribir.
- Cajas **idénticas** se ignoran en el juego (optimización); nosotros no las duplicamos.
- `máscaraArmadura`: entero decimal **0–15**, un bit por pieza (1 casco, 2 peto, 4 gregüesco, 8 botas).
  La caja se oculta cuando llevas esa pieza (TU31+). Ver la receta en §6b.
- `espejo`: `0`/`1`, espeja la U de la textura (obligatorio en 64×32 para brazo/pierna izquierdos).
- `inflado`: float; **exige `XMLVERSION 3`**.

### Pivotes y valores de referencia del modelo estándar

| Tipo | Pivote | Caja estándar (Blockbench) | `BOX` que escribimos |
|---|---|---|---|
| `HEAD` | 0,24,0 | −4,24,−4 → 4,32,4 | `HEAD -4 -8 -4 8 8 8 0 0` |
| `HEADWEAR` | 0,24,0 | igual | `HEADWEAR -4 -8 -4 8 8 8 32 0` |
| `BODY` | 0,24,0 | −4,12,−2 → 4,24,2 | `BODY -4 0 -2 8 12 4 16 16` |
| `JACKET` | 0,24,0 | igual | `JACKET -4 0 -2 8 12 4 16 32` |
| `ARM0` | −5,22,0 | −8,12,−2 → −4,24,2 | `ARM0 -3 -2 -2 4 12 4 40 16` |
| `SLEEVE0` | −5,22,0 | igual | `SLEEVE0 -3 -2 -2 4 12 4 40 32` |
| `ARM1` | 5,22,0 | 4,12,−2 → 8,24,2 | `ARM1 -1 -2 -2 4 12 4 32 48` |
| `SLEEVE1` | 5,22,0 | igual | `SLEEVE1 -1 -2 -2 4 12 4 48 48` |
| `LEG0` | −2,12,0 | −4,0,−2 → 0,12,2 | `LEG0 -2 0 -2 4 12 4 0 16` |
| `PANTS0` | −2,12,0 | igual | `PANTS0 -2 0 -2 4 12 4 0 32` |
| `LEG1` | 2,12,0 | 0,0,−2 → 4,12,2 | `LEG1 -2 0 -2 4 12 4 16 48` |
| `PANTS1` | 2,12,0 | igual | `PANTS1 -2 0 -2 4 12 4 0 48` |

En skins **64×32** el brazo y la pierna izquierdos reutilizan la textura del derecho:
`ARM1 … 40 16 0 1` y `LEG1 … 0 16 0 1`.

### Fórmula aplicada (por eso los valores salen solos)

```
X = min.x − pivote.x
Y = pivote.y − max.y       ← eje Y invertido
Z = min.z − pivote.z
ANCHO/ALTO/FONDO = max − min   (redondeado a entero)
```

### 6b. Máscara de armadura (la receta)

El juego dibuja la armadura sobre el **modelo estándar**, así que la máscara sirve para que tus cajas no
atraviesen el casco o el peto.

| Bits | Valor | Se oculta al llevar |
|---|---|---|
| casco | `1` | casco o calabaza |
| peto | `2` | peto |
| gregüesco | `4` | gregüesco |
| botas | `8` | botas |
| — | `15` | cualquier pieza |

Máscaras por defecto que aplica la herramienta al importar un `.bbmodel` (paridad con Java):
`HEADWEAR`→`1` · `JACKET`, `SLEEVE0`, `SLEEVE1`→`2` · `PANTS0`, `PANTS1`→`4`.
Los tipos de armadura de Bedrock (`LEGGING0/1`→`4`, `SOCK0/1`→`12`, `BOOT0/1`→`8`, `ARMARMOR0/1`→`2`,
`BODYARMOR`→`2`, `BELT`→`6`) llevan la suya.

Ejemplo: sombrero que se oculta con casco → `HEADWEAR -4 -8 -4 8 8 8 32 0 1 0`
(los dos últimos argumentos son máscara y espejo; el inflado iría detrás si `XMLVERSION 3`).

**Aviso de tamaño:** si una caja supera la medida estándar de su parte, la herramienta lo dice al importar,
porque la armadura no se adapta y quedará dentro.

### 6c. `OFFSET` — mover la armadura (TU33)

```
OFFSET  TIPO Y valor
```

Tres argumentos: tipo, eje (**solo `Y`**) y entero. **Negativo = más arriba.** Se pueden poner varios
`OFFSET` en la misma skin y **se suman**: `HELMET Y -2` + `HEAD Y -2` dejan el casco en su sitio con la
cabeza dos unidades más arriba.

| Tipos | Desde |
|---|---|
| `HELMET`, `CHEST`, `SHOULDER0`, `SHOULDER1`, `WAIST`, `PANTS0`, `PANTS1`, `BOOT0`, `BOOT1`, `TOOL0`, `TOOL1` | TU33 |
| `HEAD`, `BODY`, `ARM0`, `ARM1`, `LEG0`, `LEG1` | TU58 |

Los tipos de overlay (`HEADWEAR`, `JACKET`…) **no** son válidos como `OFFSET`: aparecen en algunos packs
pero el juego los ignora. La herramienta no los escribe.

### 6d. Flags de skin

| Bit | Parámetro | Valor | Efecto |
|---|---|---|---|
| 9 | `ANIM` | `0x00000100` | no dibuja **ninguna** armadura (TU17) |
| 1 | `GAME_FLAGS` | `0x01` | no permitida en Battle Mode con «Allow All Skins» desactivado (TU36) |

`GAME_FLAGS` por defecto `0x18` = bits 4 y 5 («Character» + «Biological» en PCK Studio). Con el flag de
Battle Mode pasa a `0x19`.

### Los 23 tipos válidos

`HEAD`, `BODY`, `ARM0`, `ARM1`, `LEG0`, `LEG1` (TU7) ·
`HEADWEAR`, `JACKET`, `SLEEVE0`, `SLEEVE1`, `PANTS0`, `PANTS1` (TU34) ·
`WAIST`, `LEGGING0`, `LEGGING1`, `SOCK0`, `SOCK1`, `BOOT0`, `BOOT1` (TU58) ·
`ARMARMOR0`, `ARMARMOR1`, `BODYARMOR`, `BELT` (TU60).

Cualquier otro nombre se rechaza (el cubo del `.bbmodel` se ignora con aviso).

---

## 7. `XMLVERSION` (cabecera del pack, no de la skin)

| Valor | Efecto |
|---|---|
| ausente / `0` | formato antiguo (pre-TU34). Sin inflado automático de capas. |
| `1` / `2` | las capas overlay se inflan solas: `HEADWEAR` +0.5, resto +0.25. **Valor por defecto al usar modelo 3D.** |
| `3` | el inflado se escribe explícitamente en cada `BOX`; las capas ya **no** se inflan solas. |

La herramienta elige: **2** si el modelo no trae inflados propios, **3** si algún cubo lleva uno distinto
del estándar (y entonces escribe el inflado de las capas también, para que no se queden pegadas al cuerpo).
El pack hereda el valor máximo de sus skins; las skins sin `BOX` no lo necesitan.

> Con `XMLVERSION` activo el juego voltea la UV de la cara sur. Por eso se escriben los valores de
> referencia de la tabla de arriba, que son los que el propio juego usa por defecto.

---

## 8. Límites y comprobaciones previas

| Límite | Valor | Qué hace la herramienta |
|---|---|---|
| PNG de skin | **≤ 32767 B** | avisa en la tarjeta si se pasa |
| Resolución | 64×64, 64×32, 128×128… | reescala con *nearest* y rellena transparente |
| ID de pack / skin | 8 dígitos, 100000–99999999 | genera y valida |
| Nombres | UTF-16 en el `.pck`, UTF-8 en el `.loc` | escapa nada, convierte |
| Ruta de instalación | `/dev_hdd0/game/<TITLE_ID>/USRDIR/DLC/<carpeta>/` | documentada en la página |

---

## 9. Cómo se audita

```bash
node test/params.js      # 86 parámetros (cabecera, LUT, strings, loc, ANIM, IDs, BOX)
node test/pck.test.js    # 8 tests del formato byte a byte
node test/e2e-3d.js      # .bbmodel → BOX, XMLVERSION 2/3, slim, ciclo importar/exportar
python3 test/verify.py fichero.pck   # relectura independiente, «no sobran bytes»
```

Si algún día hay que tocar un valor, **se cambia aquí y en el test a la vez**: el test es la garantía
de que la consola recibe lo que espera.
