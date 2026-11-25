const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

async function main() {
  const cacheName = read('service-worker.js').match(/const CACHE_NAME = '([^']+)'/)[1];
  const previousCacheName = cacheName.replace(/\d+$/, value => String(Number(value) - 1));
  const handlers = {}, deleted = [], stored = new Map(), seenCaches = [];
  const context = {
    URL, Request, Response,
    self: {
      registration: { scope: 'https://example.com/dokodemo-nauru/' },
      location: { origin: 'https://example.com' },
      addEventListener: (name, callback) => { handlers[name] = callback; },
      skipWaiting: async () => {},
      clients: { claim: async () => {} }
    },
    caches: {
      keys: async () => [previousCacheName, cacheName, 'dokodemo-nauru-map-tiles-v1', 'other-app'],
      delete: async key => deleted.push(key),
      open: async () => ({ put: async (key, value) => stored.set(key.url || key, await value.text()) }),
      match: async key => stored.has(key.url) ? new Response(stored.get(key.url)) : undefined
    },
    fetch: async request => {
      seenCaches.push(request.cache);
      return new Response(request.url.endsWith('privacy.html') ? 'privacy' : request.url.includes('/camera/') ? 'photo-editor' : request.url.endsWith('attractions.geojson') ? 'attractions' : 'home');
    }
  };
  vm.createContext(context);
  vm.runInContext(read('service-worker.js'), context);
  let pending;
  handlers.install({ waitUntil: promise => { pending = promise; } });
  await pending;
  assert(seenCaches.length > 0 && seenCaches.every(mode => mode === 'no-cache'));
  seenCaches.length = 0;
  stored.clear();
  handlers.activate({ waitUntil: promise => { pending = promise; } });
  await pending;
  assert.deepEqual(deleted, [previousCacheName]);
  // Use a Request-compatible stub to model browser navigation requests.
  context.Request = class { constructor(value, init) { this.url = value.url || String(value); this.cache = init && init.cache; } };
  async function requestPath(url, mode = 'navigate') {
    const writes = [];
    handlers.fetch({ request: { method: 'GET', mode, url },
      respondWith: promise => { pending = promise; }, waitUntil: promise => writes.push(promise) });
    const response = await pending;
    await Promise.all(writes);
    return response.text();
  }
  await requestPath('https://example.com/dokodemo-nauru/');
  await requestPath('https://example.com/dokodemo-nauru/privacy.html');
  await requestPath('https://example.com/dokodemo-nauru/camera/');
  await requestPath('https://example.com/dokodemo-nauru/data/attractions.geojson', 'cors');
  assert.deepEqual(seenCaches, ['no-cache', 'no-cache', 'no-cache', 'no-cache']);
  context.fetch = async () => { throw new Error('offline'); };
  assert.equal(await requestPath('https://example.com/dokodemo-nauru/'), 'home');
  assert.equal(await requestPath('https://example.com/dokodemo-nauru/privacy.html'), 'privacy');
  assert.equal(await requestPath('https://example.com/dokodemo-nauru/camera/'), 'photo-editor');
  assert.equal(await requestPath('https://example.com/dokodemo-nauru/camera/index.html'), 'photo-editor');
  assert.equal(await requestPath('https://example.com/dokodemo-nauru/data/attractions.geojson', 'cors'), 'attractions');

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
  const app = read('app.js');
  const noteCode = app.slice(app.indexOf('        const officialArea ='), app.indexOf('        comparisonNote.append(\'輪郭：\');', app.indexOf('        const officialArea =')));
  function noteFor(properties, areaKm2) {
    const parts = [];
    const ctx = {result: {target: {feature: {properties}, areaKm2}}, attraction: false,
      comparisonNote: {append: (...args) => parts.push(...args)}};
    vm.runInNewContext(noteCode, ctx);
    return parts.join('');
  }
  assert.equal(noteFor({officialAreaKm2: null}, 12), '');
  assert.match(noteFor({officialAreaKm2: 12}, 12), /国土地理院/);
  for (const file of ['app-start.css', 'app.css', 'tailwind.css', 'app.js']) {
    assert.ok(html.includes('="./' + file + '"'), file);
    const source = read(file);
    if (file.endsWith('.js')) new vm.Script(source, {filename: file});
  }
  new vm.Script(game);
  const Rules = require('../game/rules.js');
  const renderCode = game.slice(game.indexOf('  function updateSurvivalHud('), game.indexOf('  function tickTimer('));
  let now = 1000, tick;
  const element = () => ({classList: {remove() {}, toggle() {}}, style: {}, setAttribute() {}, focus() {}});
  const elements = new Proxy({answerButtons: [element()]}, {get: (target, key) => target[key] ||= element()});
  const places = [
    {id: 'q', category: 'island', outcome: 'larger', name: 'テスト島', location: '東京都'},
    {id: 'q2', category: 'island', outcome: 'smaller', name: '予備島', location: '沖縄県'}
  ];
  const renderContext = {elements, performance: {now: () => now}, cancelAnimationFrame() {},
    Rules, MAX_MISTAKES: Rules.MAX_MISTAKES, CATEGORY_LABELS: {island: '島'}, formatScore: String,
    state: {
      data: {places}, placesById: new Map(places.map(place => [place.id, place])),
      usedQuestionIds: new Set(), questions: [], currentIndex: 0, correctCount: 0, mistakes: 0,
      serverSessionId: 'session', serverClientId: 'client', serverCompleted: false
    },
    rankingRpc: async (name, body) => {
      assert.equal(name, 'open_quiz_survival_question');
      assert.equal(body.p_session_id, 'session');
      assert.equal(body.p_client_id, 'client');
      now += 2000;
      return [{opened: true, question_id: 'q'}];
    },
    firstRpcRow: rows => rows[0], tickTimer: value => {tick = value;}, console, showToast() {}};
  vm.createContext(renderContext);
  vm.runInContext(renderCode, renderContext);
  await renderContext.renderQuestion();
  assert.equal(renderContext.state.questions[0].id, 'q');
  assert.equal(tick - renderContext.state.questionStartedAt, 2000);
  renderContext.state.currentIndex = 1;
  renderContext.rankingRpc = async () => {now += 8000; throw new Error('test timeout');};
  renderContext.console = {warn() {}};
  await renderContext.renderQuestion();
  assert.equal(renderContext.state.serverSessionId, null);
  assert.equal(renderContext.state.serverClientId, null);
  assert.equal(renderContext.state.questions[1].id, 'q2');
  assert.equal(tick - renderContext.state.questionStartedAt, 0);

  const geometryCode = app.slice(app.indexOf('    async function getComparisonGeometry('), app.indexOf('    function comparisonBoundsToLeaflet('));
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
