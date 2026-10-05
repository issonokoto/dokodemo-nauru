const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

async function main() {
  const cacheName = read('service-worker.js').match(/const CACHE_NAME = '([^']+)'/)[1];
  const previousCacheName = cacheName.replace(/\d+$/, value => String(Number(value) - 1));
  const handlers = {}, deleted = [], stored = new Map();
  const context = {
    URL, Request, Response,
    self: {
      registration: { scope: 'https://example.com/dokodemo-nauru/' },
      location: { origin: 'https://example.com' },
      addEventListener: (name, callback) => { handlers[name] = callback; },
      clients: { claim: async () => {} }
    },
    caches: {
      keys: async () => [previousCacheName, cacheName, 'dokodemo-nauru-map-tiles-v1', 'other-app'],
      delete: async key => deleted.push(key),
      open: async () => ({ put: async (key, value) => stored.set(key.url || key, await value.text()) }),
      match: async key => stored.has(key.url) ? new Response(stored.get(key.url)) : undefined
    },
    fetch: async request => new Response(request.url.endsWith('privacy.html') ? 'privacy' : request.url.includes('/camera/') ? 'photo-editor' : 'home')
  };
  vm.createContext(context);
  vm.runInContext(read('service-worker.js'), context);
  let pending;
  handlers.activate({ waitUntil: promise => { pending = promise; } });
  await pending;
  assert.deepEqual(deleted, [previousCacheName]);
  // Use a Request-compatible stub to model browser navigation requests.
  context.Request = class { constructor(value) { this.url = value.url || String(value); } };
  async function navigate(url) {
    const writes = [];
    handlers.fetch({ request: { method: 'GET', mode: 'navigate', url },
      respondWith: promise => { pending = promise; }, waitUntil: promise => writes.push(promise) });
    const response = await pending;
    await Promise.all(writes);
    return response.text();
  }
  await navigate('https://example.com/dokodemo-nauru/');
  await navigate('https://example.com/dokodemo-nauru/privacy.html');
  await navigate('https://example.com/dokodemo-nauru/camera/');
  context.fetch = async () => { throw new Error('offline'); };
  assert.equal(await navigate('https://example.com/dokodemo-nauru/'), 'home');
  assert.equal(await navigate('https://example.com/dokodemo-nauru/privacy.html'), 'privacy');
  assert.equal(await navigate('https://example.com/dokodemo-nauru/camera/'), 'photo-editor');
  assert.equal(await navigate('https://example.com/dokodemo-nauru/camera/index.html'), 'photo-editor');

  const game = read('game/game.js');
  const rpc = game.slice(game.indexOf('  async function rankingRpc('), game.indexOf('  function firstRpcRow('));
  let timer, cleared = 0;
  const rpcContext = { AbortController, getRankingConfig: () => ({supabaseUrl: 'https://test', supabaseAnonKey: 'test'}),
    setTimeout: (fn, ms) => { assert.equal(ms, 8000); timer = fn; return 1; },
    clearTimeout: () => { cleared++; },
    fetch: async () => ({ok: true, json: async () => ({ok: true})}) };
  vm.createContext(rpcContext);
  vm.runInContext(rpc, rpcContext);
  assert.equal((await rpcContext.rankingRpc('test', {})).ok, true);
  rpcContext.fetch = async (_url, options) => ({ok: true, json: () => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  })});
  const stalled = rpcContext.rankingRpc('test', {});
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  timer();
  await assert.rejects(stalled, /aborted/);
  assert.equal(cleared, 2);

  const html = read('index.html');
  const noteCode = html.slice(html.indexOf('        const officialArea ='), html.indexOf('        comparisonNote.append(\'輪郭：\');', html.indexOf('        const officialArea =')));
  function noteFor(properties, areaKm2) {
    const parts = [];
    const ctx = {result: {target: {feature: {properties}, areaKm2}}, attraction: false,
      comparisonNote: {append: (...args) => parts.push(...args)}};
    vm.runInNewContext(noteCode, ctx);
    return parts.join('');
  }
  assert.equal(noteFor({officialAreaKm2: null}, 12), '');
  assert.match(noteFor({officialAreaKm2: 12}, 12), /国土地理院/);
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/src=|application\/ld\+json/.test(match[1])) new vm.Script(match[2]);
  }
  new vm.Script(game);
  const renderCode = game.slice(game.indexOf('  async function renderQuestion('), game.indexOf('  function tickTimer('));
  let now = 1000, tick;
  const element = () => ({classList: {remove() {}}, style: {}, setAttribute() {}, focus() {}});
  const elements = new Proxy({answerButtons: [element()]}, {get: (target, key) => target[key] ||= element()});
  const renderContext = {elements, performance: {now: () => now}, cancelAnimationFrame() {},
    state: {questions: [{id: 'q', category: 'island'}], currentIndex: 0, serverSessionId: 'session'},
    QUESTION_COUNT: 10, CATEGORY_LABELS: {island: '島'},
    rankingRpc: async () => {now += 2000; return [{opened: true, question_id: 'q'}];},
    firstRpcRow: rows => rows[0], tickTimer: value => {tick = value;}, console, showToast() {}};
  vm.createContext(renderContext);
  vm.runInContext(renderCode, renderContext);
  await renderContext.renderQuestion();
  assert.equal(tick - renderContext.state.questionStartedAt, 2000);
  renderContext.rankingRpc = async () => {now += 8000; throw new Error('test timeout');};
  renderContext.console = {warn() {}};
  await renderContext.renderQuestion();
  assert.equal(renderContext.state.serverSessionId, null);
  assert.equal(tick - renderContext.state.questionStartedAt, 0);

  const geometryCode = html.slice(html.indexOf('    async function getComparisonGeometry('), html.indexOf('    function comparisonBoundsToLeaflet('));
  let attempts = 0;
  const geometryContext = {comparisonGeometryCache: new Map(), prefecturesGeojsonPromise: null,
    isHistoricalComparisonTarget: () => false, isFileGeometryComparisonTarget: () => false,
    PREFECTURES_GEOJSON_URL: 'test',
    fetch: async () => { if (++attempts === 1) throw new Error('temporary'); return {ok: true, json: async () => ({features: [{properties: {code: '27'}}]})}; },
    polygonGroupsByLayerFromGeojson: () => ({allPolygons: [[]], polygons: [[]], waterPolygons: []}),
    getGeometryBounds: () => ({})};
  vm.createContext(geometryContext);
  vm.runInContext(geometryCode, geometryContext);
  await assert.rejects(geometryContext.getComparisonGeometry({kind: 'prefecture', code: '27'}), /temporary/);
  await geometryContext.getComparisonGeometry({kind: 'prefecture', code: '27'});
  assert.equal(attempts, 2);
  console.log('PASS: cache isolation, offline navigation, RPC success/body timeout, area provenance, countdown/fallback, boundary retry, JS syntax');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
