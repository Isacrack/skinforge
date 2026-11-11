/* Capturas de pantalla para revisar el diseño (node test/shots.js) */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'out');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.on('dialog', (d) => d.accept());
  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await page.waitForTimeout(300);

  // estado limpio
  await page.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); });
  await page.screenshot({ path: path.join(OUT, 'shot-empty.png'), fullPage: true });

  await page.setInputFiles('#fileInput', [
    path.join(OUT, 'steve.png'), path.join(OUT, 'clasica.png'), path.join(OUT, 'pack.mcpack')
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.skin-card').length >= 4, null, { timeout: 20000 });
  await page.locator('#packName').fill('Mi Pack PS3');
  await page.click('#buildTestBtn');
  await page.waitForSelector('#logWrap.show');
  await page.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'shot-full.png'), fullPage: true });

  // modales 3D de cada tipo de skin
  for (const [i, name] of [[1, 'clasica'], [0, 'moderna']]) {
    await page.locator('.skin-card .doll-btn').nth(i).click();
    await page.waitForTimeout(450);
    await page.locator('#dollOverlay').screenshot({ path: path.join(OUT, 'shot-doll-' + name + '.png') });
    await page.click('#dollClose');
  }

  // móvil
  const m = await browser.newPage({ viewport: { width: 400, height: 900 } });
  await m.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await m.waitForTimeout(300);
  await m.setInputFiles('#fileInput', [path.join(OUT, 'steve.png')]);
  await m.waitForFunction(() => document.querySelectorAll('.skin-card').length === 1);
  await m.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); window.scrollTo(0, 0); });
  await m.waitForTimeout(300);
  await m.screenshot({ path: path.join(OUT, 'shot-mobile.png'), fullPage: true });

  await browser.close();
  console.log('capturas listas');
})();
