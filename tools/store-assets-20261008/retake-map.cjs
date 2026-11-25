const {chromium}=require('C:/Users/中尾洋一/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:432,height:620},deviceScaleFactor:3,hasTouch:true});const page=await context.newPage();
  for(const [name,width,height,z] of [['01-tokyo',432,620,12],['tablet-01-tokyo',1920,1080,13]]){
   await page.setViewportSize({width,height});
   await page.goto('https://issonokoto.github.io/dokodemo-nauru/?lat=35.6812&lng=139.7671&z='+z+'&style=k-original&opacity=100&reticle=0&labels=normal&map=osm',{waitUntil:'networkidle'});
   const start=page.getByRole('button',{name:'はじめる',exact:true});if(await start.isVisible())await start.click();
   await page.locator('.leaflet-image-layer').waitFor();
   const unlock=page.getByRole('button',{name:'ナウルくんの中央固定を解除',exact:true});
   if(await unlock.isVisible())await unlock.click();
   await page.waitForFunction(()=>{const im=document.querySelector('.leaflet-image-layer');return im?.complete&&im.naturalWidth>0&&Number(getComputedStyle(im).opacity)>.9;});
   await page.waitForFunction(()=>document.querySelectorAll('.leaflet-tile-loaded').length>=4);
   await page.waitForTimeout(3500);
   await page.screenshot({path:'google-play/store-assets/redesign-20261008/raw/'+name+'.png',scale:'device'});console.log('Retaken '+name);
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
