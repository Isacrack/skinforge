const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const OUT = path.join(__dirname, 'out');
(async () => {
  const br = await chromium.launch();
  const page = await br.newPage({ viewport: { width: 1300, height: 1050 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await page.setInputFiles('#fileInput', [path.join(__dirname, '..', 'ejemplos', 'caballero-armadura.bbmodel'), path.join(OUT, 'steve.png')]);
  await page.waitForFunction(() => /Modelo:/.test(document.querySelector('.skin-card')?.textContent || ''), null, { timeout: 15000 });
  await page.click('.skin-card .doll-btn');
  await page.waitForFunction(() => document.querySelector('#dollCanvas')._lce3d, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => {
    const c = document.querySelector('#dollCanvas');
    return { piesas: c._lce3d.piezas.length, dib: c._lce3d.dibujadas };
  });
  console.log(info);
  const mod = await page.locator('#dollOverlay .modal').boundingBox();
  await page.screenshot({ path: path.join(OUT, 'shot-png-mas-modelo.png'), clip: { x: mod.x - 8, y: mod.y - 8, width: mod.width + 16, height: Math.min(mod.height + 16, 1040 - mod.y) } });
  console.log('errores:', errs.length ? errs : 'ninguno');
  await br.close();
})();
