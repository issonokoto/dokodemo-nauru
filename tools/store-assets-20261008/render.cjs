const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('C:/Users/中尾洋一/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const sharp = require('C:/Users/中尾洋一/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const out = path.resolve('google-play/store-assets/redesign-20261008');
const source = path.join(out,'source');
const font = fs.readFileSync('github-dokodemo-nauru/camera/fonts/rounded.woff2').toString('base64');
const logo = fs.readFileSync('github-dokodemo-nauru/assets/dokodemo-nauru-logo-transparent-v3.png').toString('base64');
const image = filename => 'data:image/png;base64,'+fs.readFileSync(filename).toString('base64');
const cards = [
  {id:'01-tokyo',label:'地図で遊ぶ',lines:['ナウル、','あなたの街に','置いてみた。'],sub:'たった21km²の国を、街に重ねてみよう。',bg:'#0a2744',fg:'#fff9e9',accent:'#ffdb4b'},
  {id:'02-chiyoda',label:'面積でびっくり',lines:['えっ、ナウルって','千代田区より','大きいの？'],sub:'輪郭も面積も、同じ縮尺で見くらべる。',bg:'#ffda4b',fg:'#0a2744',accent:'#0a2744'},
  {id:'03-expo',label:'気になる場所と比較',lines:['万博会場は','ナウル','何個ぶん？'],sub:'島も、湖も、気になる場所も検索して比較。',bg:'#d3f3e9',fg:'#0a2744',accent:'#087f79'},
  {id:'04-quiz',label:'面積クイズ',lines:['大きい？ 小さい？','地理の勘、','試してみよう。'],sub:'ナウルをものさしに、10問の面積クイズ。',bg:'#0a2744',fg:'#fff9e9',accent:'#ffdb4b'},
  {id:'05-photo-editor',label:'写真で遊ぶ',lines:['いつもの写真に、','ナウルのみんなを','連れていこう。'],sub:'キャラクターを貼って、保存して楽しもう。',bg:'#fff3d8',fg:'#0a2744',accent:'#087f79'}
];
const css = `@font-face{font-family:Store;src:url(data:font/woff2;base64,${font})}*{box-sizing:border-box}html,body{margin:0}body{font-family:Store,'Yu Gothic',sans-serif}.card{width:1080px;height:1920px;position:relative;overflow:hidden;background:var(--bg);color:var(--fg)}.topline{position:absolute;left:52px;top:35px;display:flex;align-items:center;gap:20px;font-size:27px;font-weight:800;letter-spacing:.05em}.dot{width:14px;height:14px;background:var(--accent);border-radius:50%}.brand{position:absolute;right:50px;top:26px;width:205px;height:auto}h1{position:absolute;top:91px;left:52px;margin:0;font-size:89px;line-height:1.12;font-weight:900;letter-spacing:-.04em}.line{display:block;white-space:nowrap}.line:first-child{color:var(--accent)}.sub{position:absolute;left:54px;top:408px;margin:0;font-size:30px;line-height:1.3;font-weight:650;letter-spacing:-.015em;white-space:nowrap}.screen{position:absolute;left:48px;top:462px;width:984px;height:1412px;object-fit:contain;overflow:hidden;border-radius:25px;border:3px solid rgba(10,39,68,.18);box-shadow:0 12px 30px rgba(0,0,0,.18);background:#061525}.foot{position:absolute;bottom:12px;right:54px;font-size:20px;opacity:.70}.halo{position:absolute;width:800px;height:800px;right:-400px;top:1250px;border:3px solid currentColor;border-radius:50%;opacity:.09}.feature{position:relative;width:1024px;height:500px;background:#0a2744;overflow:hidden;color:#fff9e9}.feature-shot{position:absolute;right:0;top:0;width:550px;height:500px;object-fit:cover;object-position:52% 49%}.feature-shade{position:absolute;inset:0;background:linear-gradient(90deg,#0a2744 0%,#0a2744 42%,rgba(10,39,68,.82) 49%,rgba(10,39,68,0) 70%)}.feature h1{top:97px;left:42px;font-size:54px;line-height:1.17;letter-spacing:-.04em}.feature .brand{left:42px;top:33px;width:215px;right:auto}.feature .sub{top:325px;left:43px;font-size:23px;line-height:1.5;white-space:normal;width:430px}.feature-credit{position:absolute;right:14px;bottom:9px;font-size:12px;background:rgba(255,255,255,.85);color:#0a2744;padding:3px 7px;border-radius:4px}`;
(async()=>{
  fs.mkdirSync(path.join(out,'phone'),{recursive:true});fs.mkdirSync(path.join(out,'tablet'),{recursive:true});
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1080,height:1920},deviceScaleFactor:1});
    const page=await context.newPage();
    for(const card of cards){
      const html=`<!doctype html><html lang="ja"><meta charset="utf-8"><style>${css}</style><body><main class="card" style="--bg:${card.bg};--fg:${card.fg};--accent:${card.accent}"><div class="halo"></div><div class="topline"><i class="dot"></i>${card.label}</div><img class="brand" src="data:image/png;base64,${logo}"><h1>${card.lines.map(s=>`<span class="line">${s}</span>`).join('')}</h1><p class="sub">${card.sub}</p><img class="screen" src="${image(path.join(out,'raw',card.id+'.png'))}"><span class="foot">どこでもナウル</span></main></body></html>`;
      fs.writeFileSync(path.join(source,card.id+'.html'),html);
      await page.setContent(html);await page.evaluate(()=>document.fonts.ready);await page.locator('img').evaluateAll(ims=>Promise.all(ims.map(i=>i.decode())));
      const overflow=await page.locator('h1,.sub,.topline').evaluateAll(els=>els.map(el=>({text:el.textContent,right:el.getBoundingClientRect().right,scroll:el.scrollWidth,width:el.clientWidth})).filter(x=>x.right>1050||x.scroll>x.width+1));
      if(overflow.length)throw new Error('Text overflow '+JSON.stringify(overflow));
      const shot=await page.screenshot();
      await sharp(shot).removeAlpha().png().toFile(path.join(out,'phone',card.id+'-1080x1920.png'));
      console.log('Rendered '+card.id);
    }
    for(const name of ['01-tokyo','02-chiyoda','03-expo','04-quiz']){
      await sharp(path.join(out,'raw','tablet-'+name+'.png')).resize(1920,1080).removeAlpha().png().toFile(path.join(out,'tablet',name+'-1920x1080.png'));
    }
    const feature=`<!doctype html><html lang="ja"><meta charset="utf-8"><style>${css}</style><body><main class="feature"><img class="feature-shot" src="${image(path.join(out,'raw','01-tokyo.png'))}"><div class="feature-shade"></div><img class="brand" style="width:190px;top:23px" src="data:image/png;base64,${logo}"><h1>ナウル、<br>あなたの街に<br><span style="color:#ffdb4b">置いてみた。</span></h1><p class="sub">地図で比べる。クイズで遊ぶ。<br>写真にも、ナウルのみんなを。</p><div class="feature-credit">地図 © OpenStreetMap · ナウルくん © ナウル共和国政府観光局</div></main></body></html>`;
    fs.writeFileSync(path.join(source,'feature.html'),feature);
    await page.setViewportSize({width:1024,height:500});await page.setContent(feature);await page.evaluate(()=>document.fonts.ready);await page.locator('img').evaluateAll(ims=>Promise.all(ims.map(i=>i.decode())));
    await sharp(await page.screenshot()).removeAlpha().png().toFile(path.join(out,'feature-graphic-1024x500.png'));
    const previews=await Promise.all(cards.map(c=>sharp(path.join(out,'phone',c.id+'-1080x1920.png')).resize(270,480).toBuffer()));
    await sharp({create:{width:1430,height:560,channels:3,background:'#e7e9e5'}}).composite(previews.map((input,i)=>({input,left:20+i*282,top:24}))).png().toFile(path.join(out,'preview-contact-sheet.png'));
    fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({created:'2026-10-08',app:'どこでもナウル',source:'https://issonokoto.github.io/dokodemo-nauru/',phone:cards.map((c,i)=>({order:i+1,file:'phone/'+c.id+'-1080x1920.png',headline:c.lines.join(''),subtitle:c.sub,alt:c.label+'。'+c.lines.join('')})),tablet:['01-tokyo','02-chiyoda','03-expo','04-quiz'].map((n,i)=>({order:i+1,file:'tablet/'+n+'-1920x1080.png'})),feature:'feature-graphic-1024x500.png',demoPhoto:{file:'source/beach-demo.png',generator:'built-in image_gen',note:'写真遊びのデモ背景として生成した架空の海岸風景。ナウル共和国の実景写真ではありません。'}},null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

