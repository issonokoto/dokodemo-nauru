const fs = require('fs');
const path = require('path');

const ROOT = process.env.DOKODEMO_NAURU_ROOT
  ? path.resolve(process.env.DOKODEMO_NAURU_ROOT)
  : path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'data', 'attractions.geojson');
const ADMIN_PATH = path.join(ROOT, 'data', 'place-administrative-areas.json');
const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
const RETIRED_IDS = new Set([
  // 内部アトラクションまたは同一施設の旧・小区画。
  'attraction-W1455979270',
  'attraction-W431328611',
  'attraction-W634473695',
  'attraction-W478996501',
  'attraction-W361861392',
  'attraction-W211459575',
  'attraction-W836796370',
  'attraction-W286179918',
  // 「大洗わくわく科学館」と同一形状で名称が誤っている重複relation。
  'attraction-R2573768'
]);
const OLD_IG_ID = 'attraction-R19120714';
const NEW_IG_ID = 'attraction-W1385731142';

function writeJson(filename, value, pretty = false) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`, 'utf8');
}

function updateDetailedProperties(properties) {
  const filename = properties.geometryFile && path.join(ROOT, 'data', properties.geometryFile);
  if (!filename || !fs.existsSync(filename)) return;
  const feature = JSON.parse(fs.readFileSync(filename, 'utf8'));
  feature.id = properties.id;
  feature.properties = properties;
  writeJson(filename, feature);
}

function recomputeAdminSummary(payload) {
  payload.generatedAt = new Date().toISOString();
  payload.summary = Object.values(payload.places || {}).reduce((result, item) => {
    if ((item.prefectures || []).length) result.withPrefectures += 1;
    if ((item.municipalities || []).length) result.withMunicipalities += 1;
    if ((item.prefectures || []).length > 1) result.multiPrefecture += 1;
    if ((item.municipalities || []).length > 1) result.multiMunicipality += 1;
    if ((item.groups || []).length) result.withGroups += 1;
    return result;
  }, {
    total: Object.keys(payload.places || {}).length,
    withPrefectures: 0,
    withMunicipalities: 0,
    multiPrefecture: 0,
    multiMunicipality: 0,
    withGroups: 0
  });
}

async function fetchIgArenaGeometry() {
  const url = new URL('https://nominatim.openstreetmap.org/lookup');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('polygon_geojson', '1');
  url.searchParams.set('osm_ids', 'W1385731142');
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Dokodemo-Nauru boundary maintenance (https://issonokoto.github.io/dokodemo-nauru/)'
    }
  });
  if (!response.ok) throw new Error(`Nominatim ${response.status}`);
  const results = await response.json();
  const result = results[0];
  if (result && result.geojson && ['Polygon', 'MultiPolygon'].includes(result.geojson.type)) {
    return result.geojson;
  }

  const fullResponse = await fetch('https://api.openstreetmap.org/api/0.6/way/1385731142/full.json', {
    headers: {
      'User-Agent': 'Dokodemo-Nauru boundary maintenance (https://issonokoto.github.io/dokodemo-nauru/)'
    }
  });
  if (!fullResponse.ok) throw new Error(`OpenStreetMap API ${fullResponse.status}`);
  const full = await fullResponse.json();
  const nodes = new Map(
    full.elements
      .filter(element => element.type === 'node')
      .map(element => [element.id, [element.lon, element.lat]])
  );
  const way = full.elements.find(element => element.type === 'way' && element.id === 1385731142);
  const ring = (way && way.nodes || []).map(id => nodes.get(id)).filter(Boolean);
  if (ring.length < 4) throw new Error('IGアリーナの建物外周を取得できませんでした');
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
  return { type: 'Polygon', coordinates: [ring] };
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const oldIg = (catalog.features || []).find(feature =>
    (feature.properties && feature.properties.id || feature.id) === OLD_IG_ID);
  if (!oldIg) throw new Error('旧IGアリーナ登録が見つかりません');
  const igGeometry = await fetchIgArenaGeometry();
  const retiredGeometryFiles = (catalog.features || [])
    .filter(feature => {
      const id = feature.properties && feature.properties.id || feature.id;
      return RETIRED_IDS.has(id) || id === OLD_IG_ID;
    })
    .map(feature => feature.properties && feature.properties.geometryFile)
    .filter(Boolean);

  catalog.features = (catalog.features || []).filter(feature => {
    const id = feature.properties && feature.properties.id || feature.id;
    return !RETIRED_IDS.has(id) && id !== OLD_IG_ID;
  });

  const igProperties = {
    ...oldIg.properties,
    id: NEW_IG_ID,
    osmType: 'way',
    osmId: 1385731142,
    geometryFile: 'attractions/W1385731142.geojson',
    officialAreaKm2: 0.0265,
    areaSourceLabel: '愛知県「愛知県新体育館」建築面積',
    areaSourceUrl: 'https://www.pref.aichi.jp/soshiki/kokusai-arena/kokusai-arena.html',
    boundarySourceLabel: '© OpenStreetMap contributors（建物外周）',
    boundarySourceUrl: OSM_COPYRIGHT_URL
  };
  const igFeature = {
    type: 'Feature',
    id: NEW_IG_ID,
    properties: igProperties,
    geometry: null
  };
  const igDetailed = {
    type: 'Feature',
    id: NEW_IG_ID,
    properties: igProperties,
    geometry: igGeometry
  };
  catalog.features.push(igFeature);
  writeJson(path.join(ROOT, 'data', igProperties.geometryFile), igDetailed);
  for (const geometryFile of retiredGeometryFiles) {
    const filename = path.join(ROOT, 'data', geometryFile);
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
  }

  const iwakuni = catalog.features.find(feature =>
    (feature.properties && feature.properties.id || feature.id)
      === 'attraction-large-airport-W664900076');
  if (!iwakuni) throw new Error('岩国錦帯橋空港が見つかりません');
  Object.assign(iwakuni.properties, {
    officialAreaKm2: 1.152,
    areaSourceLabel: '山口県「岩国錦帯橋空港」空港面積',
    areaSourceUrl: 'https://www.pref.yamaguchi.lg.jp/uploaded/attachment/70576.pdf',
    statusLabel: '岩国飛行場の軍民共用空港／輪郭は民航ターミナル区域'
  });
  updateDetailedProperties(iwakuni.properties);

  const aguni = catalog.features.find(feature =>
    (feature.properties && feature.properties.id || feature.id)
      === 'attraction-large-airport-W57015602');
  if (!aguni) throw new Error('粟国空港が見つかりません');
  Object.assign(aguni.properties, {
    officialAreaKm2: 0.09,
    areaSourceLabel: '沖縄県「粟国空港」空港面積',
    areaSourceUrl: 'https://www.pref.okinawa.lg.jp/machizukuri/kowankuko/1012617/1012690/1012697.html',
    statusLabel: '沖縄県管理の離島空港'
  });
  updateDetailedProperties(aguni.properties);

  const toyohashiGarden = catalog.features.find(feature =>
    (feature.properties && feature.properties.id || feature.id)
      === 'attraction-zoological-botanical-park-W1013611752');
  if (toyohashiGarden) {
    Object.assign(toyohashiGarden.properties, {
      subtype: 'botanical-garden',
      subtypeLabel: '植物園・植物公園',
      statusLabel: '豊橋総合動植物公園内の植物園区域'
    });
    updateDetailedProperties(toyohashiGarden.properties);
  }

  catalog.features.sort((a, b) =>
    String(a.properties && a.properties.name).localeCompare(
      String(b.properties && b.properties.name), 'ja'));
  catalog.generatedAt = new Date().toISOString();
  writeJson(CATALOG_PATH, catalog);

  const admin = JSON.parse(fs.readFileSync(ADMIN_PATH, 'utf8'));
  admin.places = admin.places || {};
  for (const id of RETIRED_IDS) delete admin.places[id];
  const previousIgAdmin = admin.places[OLD_IG_ID];
  delete admin.places[OLD_IG_ID];
  admin.places[NEW_IG_ID] = previousIgAdmin || {
    prefectures: ['愛知県'],
    municipalities: ['愛知県名古屋市'],
    groups: []
  };
  recomputeAdminSummary(admin);
  writeJson(ADMIN_PATH, admin, true);

  console.log(JSON.stringify({
    retired: [...RETIRED_IDS],
    igArena: { oldId: OLD_IG_ID, newId: NEW_IG_ID },
    iwakuniOfficialAreaKm2: iwakuni.properties.officialAreaKm2,
    toyohashiGardenReclassified: Boolean(toyohashiGarden),
    catalogFeatures: catalog.features.length
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
