// Read-only inspection of the app's page in an ADB-forwarded Chrome session.
const port = Number(process.env.DOKODEMO_CDP_PORT || 9223);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(item => item.url.startsWith('https://issonokoto.github.io/dokodemo-nauru/'));
if (!target) throw new Error('The app page is not open.');
const socket = new WebSocket(target.webSocketDebuggerUrl);
const timer = setTimeout(() => { socket.close(); process.exitCode = 1; }, 10000);
socket.addEventListener('open', () => socket.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: {
    expression: `JSON.stringify({
      viewport: {width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visual: {width: visualViewport.width, height: visualViewport.height}},
      center: typeof map !== 'undefined' ? map.getCenter() : null,
      zoom: typeof map !== 'undefined' ? map.getZoom() : null,
      coordinates: document.getElementById('center-coords')?.textContent,
      visibleControls: [...document.querySelectorAll('button')].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').map(e => ({text: e.textContent.trim(), label: e.getAttribute('aria-label'), rect: {x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}}))
    })`,
    returnByValue: true
  }
})));
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id !== 1) return;
  clearTimeout(timer);
  if (message.result?.exceptionDetails || message.error) {
    console.error(JSON.stringify(message.result?.exceptionDetails || message.error));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(JSON.parse(message.result.result.value), null, 2));
  }
  socket.close();
});
