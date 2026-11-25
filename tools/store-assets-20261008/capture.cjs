const {chromium} = require('C:/Users/中尾洋一/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const base = 'https://issonokoto.github.io/dokodemo-nauru/';
const out = path.resolve('google-play/store-assets/redesign-20261008/raw');
fs.mkdirSync(out, {recursive:true});
(async () => {
  const browser = await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const context = await browser.newContext({viewport:{width:432,height:620},deviceScaleFactor:3,hasTouch:true,acceptDownloads:true});
  const page = await context.newPage();
  const errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  async function readyMap(url) {
    await page.goto(url, {waitUntil:'networkidle'});
    const start = page.getByRole('button', {name:'はじめる',exact:true});
    if(await start.isVisible()) await start.click();
    await page.waitForFunction(()=>typeof map!=='undefined' && map && document.querySelectorAll('.leaflet-tile-loaded').length >=4);
    await page.waitForTimeout(1200);
  }
  async function save(name) {
    await page.screenshot({path:path.join(out,name+'.png'),scale:'device'});
    console.log('Captured '+name);
  }
  try {
    await readyMap(base+'?lat=35.6812&lng=139.7671&z=12&style=k-original&reticle=0&labels=normal');
    console.log('Map images',await page.locator('#map img').evaluateAll(ims=>ims.map(i=>({src:i.src,width:i.naturalWidth,cls:i.className}))));
    await save('01-tokyo');
    await readyMap(base+'?compare='+encodeURIComponent('千代田区')+'&category=current');
    await page.getByRole('heading',{name:'ナウル共和国と東京都千代田区の大きさ比較'}).waitFor();
    await save('02-chiyoda');
    await readyMap(base+'?compare='+encodeURIComponent('大阪・関西万博会場')+'&category=attraction');
    await page.locator('#comparison-modal').waitFor({state:'visible'});
    console.log('Expo',await page.locator('#comparison-summary').innerText());
    await save('03-expo');
    await page.goto(base+'game/',{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'ゲームスタート',exact:true}).waitFor();
    await save('04-quiz');
    await page.setViewportSize({width:1920,height:1080});
    await readyMap(base+'?lat=35.6812&lng=139.7671&z=13&style=k-original&reticle=0&labels=normal');
    await save('tablet-01-tokyo');
    await readyMap(base+'?compare='+encodeURIComponent('千代田区')+'&category=current');
    await page.getByRole('heading',{name:'ナウル共和国と東京都千代田区の大きさ比較'}).waitFor();
    await save('tablet-02-chiyoda');
    await readyMap(base+'?compare='+encodeURIComponent('大阪・関西万博会場')+'&category=attraction');
    await page.locator('#comparison-modal').waitFor({state:'visible'});
    await save('tablet-03-expo');
    await page.goto(base+'game/',{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'ゲームスタート',exact:true}).waitFor();
    await save('tablet-04-quiz');
    await page.setViewportSize({width:432,height:620});
    await page.goto(base+'camera/',{waitUntil:'networkidle'});
    await page.locator('#background-file').setInputFiles(path.resolve('google-play/store-assets/redesign-20261008/source/beach-demo.png'));
    await page.waitForFunction(()=>document.body.dataset.mode==='image' && document.querySelector('.character-layer')?.complete);
    await page.getByRole('button',{name:'ナウルちゃんを追加',exact:true}).click();
    await page.locator('.character-layer').evaluateAll(ims=>Promise.all(ims.map(i=>i.decode())));
    await save('05-photo-editor');
    console.log(JSON.stringify({errors,photoUrl:page.url()}));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
