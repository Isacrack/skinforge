const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const OUT = path.join(__dirname, 'out');
(async () => {
  const br = await chromium.launch();
  const page = await br.newPage({ viewport: { width: 1300, height: 1000 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await page.setInputFiles('#fileInput', [path.join(__dirname, '..', 'ejemplos', 'caballero-armadura.bbmodel'), path.join(OUT, 'steve.png')]);
  await page.waitForTimeout(2500);
  const cards = await page.evaluate(() => [...document.querySelectorAll('.skin-card')].map((c) => ({
    texto: c.innerText.replace(/\s+/g, ' ').slice(0, 120),
    pills: [...c.querySelectorAll('.pill')].map((p) => p.textContent.trim()),
    thumb: (c.querySelector('.skin-thumb img') || {}).src?.slice(0, 30)
  })));
  console.log(JSON.stringify(cards, null, 1));
  console.log('errores:', errs.length ? errs : 'ninguno');
  await br.close();
})();
