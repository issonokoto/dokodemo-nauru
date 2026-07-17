const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'data', 'attractions.geojson');
const geometryDir = path.join(root, 'data', 'attractions');
const reportPath = path.join(root, 'scripts', 'japan-scenic-castles-report.json');
const osmCopyrightUrl = 'https://www.openstreetmap.org/copyright';
const castleSourceUrl = 'https://www.bunka.go.jp/seisaku/bunkashingikai/kondankaito/shiseki_working/01/pdf/r1411437_02.pdf';
const nationalParkSourceUrl = 'https://www.env.go.jp/park/parks/';
const largeCastleThresholdKm2 = 0.1;

const officialNationalParks = new Set([
  '利尻礼文サロベツ国立公園', '知床国立公園', '阿寒摩周国立公園', '釧路湿原国立公園',
  '大雪山国立公園', '日高山脈襟裳十勝国立公園', '支笏洞爺国立公園', '十和田八幡平国立公園',
  '三陸復興国立公園', '磐梯朝日国立公園', '日光国立公園', '尾瀬国立公園',
  '上信越高原国立公園', '妙高戸隠連山国立公園', '秩父多摩甲斐国立公園', '小笠原国立公園',
  '富士箱根伊豆国立公園', '中部山岳国立公園', '白山国立公園', '南アルプス国立公園',
  '伊勢志摩国立公園', '吉野熊野国立公園', '山陰海岸国立公園', '瀬戸内海国立公園',
  '大山隠岐国立公園', '足摺宇和海国立公園', '西海国立公園', '雲仙天草国立公園',
  '阿蘇くじゅう国立公園', '霧島錦江湾国立公園', '屋久島国立公園', '奄美群島国立公園',
  'やんばる国立公園', '慶良間諸島国立公園', '西表石垣国立公園'
]);

const existingKeeps = [
  '弘前城', '松本城', '丸岡城', '犬山城', '彦根城', '姫路城',
  '松江城', '備中松山城', '丸亀城', '松山城', '宇和島城', '高知城'
];

// 文化庁資料に掲載された復元・外観復元・復興・模擬天守を中心に、
// 現在も天守風建築を持つ著名城郭を補った一覧。表示上は分類論争を避けて一括する。
const reconstructedKeeps = [
  '洲本城', '大阪城', '羽衣石城', '郡上八幡城', '伊賀上野城', '岸和田城',
  '富山城', '岐阜城', '和歌山城', '浜松城', '大垣城', '小倉城', '熊本城',
  '小田原城', '松前城', '岩国城', '大峰城', '岡山城', '広島城', '名古屋城', '島原城', '伏見桃山城',
  '会津若松城', '鶴ヶ城', '横手城', '唐津城', '三戸城', '大野城', '長岡城',
  '高島城', '杵築城', '涌谷城', '大多喜城', '平戸城', '今治城', '川島城',
  '上山城', '長浜城', '五城目城', '綾城', '福知山城', '川之江城', '小山城',
  '稲庭城', '一郷山城', '墨俣城', '天ケ城', '木浦城', '豊田城', '舟見城',
  '掛川城', '白石城', '大洲城', '清洲城', '中津城', '勝山城博物館'
];

const scenicByOsm = new Map([
  ['way:534754971', { name: '皇居', context: '東京都千代田区', subtype: 'imperial-site', subtypeLabel: '皇居・御所', statusLabel: '旧江戸城本丸・西の丸周辺' }],
  ['way:55954342', { name: '鳥取砂丘', context: '鳥取県鳥取市', subtype: 'scenic-large', subtypeLabel: '景勝地・大規模地形', statusLabel: '砂丘・自然保護区' }],
  ['way:807446111', { name: '猿ヶ森砂丘', context: '青森県下北郡東通村', subtype: 'scenic-large', subtypeLabel: '景勝地・大規模地形', statusLabel: '砂丘' }],
  ['way:785598136', { name: '吹上浜', context: '鹿児島県', subtype: 'scenic-large', subtypeLabel: '景勝地・大規模地形', statusLabel: '砂浜' }],
  ['way:935429778', { name: '中田島砂丘', context: '静岡県浜松市', subtype: 'scenic-large', subtypeLabel: '景勝地・大規模地形', statusLabel: '砂丘・砂浜' }],
  ['way:1221835531', { name: '上高地', context: '長野県松本市', subtype: 'scenic-large', subtypeLabel: '景勝地・大規模地形', statusLabel: '山岳景勝地・谷' }],
  ['relation:8771350', { name: '尾瀬ヶ原', context: '群馬県・福島県・新潟県', subtype: 'scenic-large', subtypeLabel: '景勝地・大規模地形', statusLabel: '湿原' }]
]);

const existingKeepPointFallbacks = [
  { name: '丸亀城', context: '香川県丸亀市', lon: 133.8001009, lat: 34.2860216, osmId: 1179835155 },
  { name: '松山城', context: '愛媛県松山市', lon: 132.7657463, lat: 33.8456510, osmId: 611661255 }
];

function samePoint(a, b) {
  return a && b && a[0] === b[0] && a[1] === b[1];
}

function coordinatesFromGeometry(geometry) {
  return Array.isArray(geometry) ? geometry.map(point => [point.lon, point.lat]) : [];
}

function stitchRings(members) {
  const segments = members.map(member => coordinatesFromGeometry(member.geometry)).filter(coordinates => coordinates.length > 1);
  const rings = [];
  while (segments.length) {
    const ring = segments.shift().slice();
    let changed = true;
    while (!samePoint(ring[0], ring[ring.length - 1]) && changed) {
      changed = false;
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const first = segment[0];
        const last = segment[segment.length - 1];
        if (samePoint(ring[ring.length - 1], first)) ring.push(...segment.slice(1));
        else if (samePoint(ring[ring.length - 1], last)) ring.push(...segment.slice(0, -1).reverse());
        else if (samePoint(ring[0], last)) ring.unshift(...segment.slice(0, -1));
        else if (samePoint(ring[0], first)) ring.unshift(...segment.slice(1).reverse());
        else continue;
        segments.splice(index, 1);
        changed = true;
        break;
      }
    }
    if (!samePoint(ring[0], ring[ring.length - 1])) ring.push(ring[0]);
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function geometryFromElement(element) {
  if (element.type === 'way') {
    const ring = coordinatesFromGeometry(element.geometry);
    if (ring.length < 3) return null;
    if (!samePoint(ring[0], ring[ring.length - 1])) ring.push(ring[0]);
    return ring.length >= 4 ? { type: 'Polygon', coordinates: [ring] } : null;
  }
  if (element.type !== 'relation') return null;
  const members = Array.isArray(element.members) ? element.members.filter(member => member.type === 'way') : [];
  const outers = stitchRings(members.filter(member => member.role !== 'inner'));
  const inners = stitchRings(members.filter(member => member.role === 'inner'));
  if (outers.length === 1) return { type: 'Polygon', coordinates: [outers[0], ...inners] };
  if (outers.length > 1) return { type: 'MultiPolygon', coordinates: outers.map(ring => [ring]) };
  return null;
}

function ringAreaKm2(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  const lat0 = ring.reduce((sum, point) => sum + point[1], 0) / ring.length * Math.PI / 180;
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [lon1, lat1] = ring[index];
    const [lon2, lat2] = ring[index + 1];
    const x1 = 6371008.8 * lon1 * Math.PI / 180 * Math.cos(lat0);
    const y1 = 6371008.8 * lat1 * Math.PI / 180;
    const x2 = 6371008.8 * lon2 * Math.PI / 180 * Math.cos(lat0);
    const y2 = 6371008.8 * lat2 * Math.PI / 180;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2 / 1e6;
}

function geometryAreaKm2(geometry) {
  const polygonArea = polygon => Math.max(0, ringAreaKm2(polygon[0]) - polygon.slice(1).reduce((sum, ring) => sum + ringAreaKm2(ring), 0));
  return geometry.type === 'Polygon' ? polygonArea(geometry.coordinates) : geometry.coordinates.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
}

function mergeGeometries(geometries) {
  const polygons = geometries.flatMap(geometry => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates);
  return polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
}

function circleGeometry(lon, lat, radiusMeters = 30, steps = 48) {
  const coordinates = [];
  const latScale = 1 / 111320;
  const lonScale = 1 / (111320 * Math.cos(lat * Math.PI / 180));
  for (let index = 0; index <= steps; index += 1) {
    const angle = index / steps * Math.PI * 2;
    coordinates.push([lon + Math.cos(angle) * radiusMeters * lonScale, lat + Math.sin(angle) * radiusMeters * latScale]);
  }
  return { type: 'Polygon', coordinates: [coordinates] };
}

function normalizeCastleName(name) {
  return String(name || '').replace(/[\s　]/g, '').replace(/(城跡|城址|跡|址|公園)$/u, '');
}

function matchedListedName(name, list) {
  const normalized = normalizeCastleName(name);
  return list.find(item => normalized === normalizeCastleName(item)) || null;
}

function contextFromTags(tags) {
  return tags['addr:province'] || tags['is_in:province'] || tags['addr:city'] || tags['is_in:city'] || '日本';
}

function osmKey(element) {
  return `${element.type}:${element.id}`;
}

function osmPrefix(type) {
  return type === 'relation' ? 'R' : 'W';
}

async function fetchOverpass() {
  const directWays = [...scenicByOsm.keys()].filter(key => key.startsWith('way:')).map(key => key.split(':')[1]).join(',');
  const directRelations = [...scenicByOsm.keys()].filter(key => key.startsWith('relation:')).map(key => key.split(':')[1]).join(',');
  const query = `[out:json][timeout:300][maxsize:536870912];
    area["ISO3166-1"="JP"]["admin_level"="2"]->.japan;
    (
      nwr["historic"="castle"](area.japan);
      nwr["name"~"国立公園$"](area.japan);
      way(id:${directWays});
      relation(id:${directRelations});
      way["natural"="beach"](35.15,140.28,35.86,140.86);
      relation["natural"="beach"](35.15,140.28,35.86,140.86);
    );
    out body geom;`;
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  let lastError;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'Dokodemo-Nauru scenic and castle catalog maintenance (https://issonokoto.github.io/dokodemo-nauru/)'
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(180000)
      });
      if (response.ok) return response.json();
      lastError = new Error(`Overpass ${response.status}: ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Overpass request failed');
}

function writeFeature(properties, geometry) {
  const feature = { type: 'Feature', id: properties.id, properties, geometry };
  fs.writeFileSync(path.join(root, 'data', properties.geometryFile), `${JSON.stringify(feature)}\n`);
  return { type: 'Feature', id: properties.id, properties, geometry: null };
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const preserved = (catalog.features || []).filter(feature => ![
    'castle-existing', 'castle-reconstructed', 'castle-ruins-large', 'scenic-large', 'national-park', 'imperial-site'
  ].includes(feature.properties && feature.properties.subtype));
  const data = await fetchOverpass();
  const castleGroups = new Map();
  const nationalParkGroups = new Map();
  const scenicCandidates = new Map();
  const kujukuriGeometries = [];
  const rejected = [];

  for (const element of data.elements) {
    if (!['way', 'relation'].includes(element.type)) continue;
    const tags = element.tags || {};
    const geometry = geometryFromElement(element);
    if (!geometry || geometryAreaKm2(geometry) <= 0) {
      if (tags.name) rejected.push({ osmType: element.type, osmId: element.id, name: tags.name });
      continue;
    }
    const direct = scenicByOsm.get(osmKey(element));
    if (direct) {
      scenicCandidates.set(direct.name, { element, geometry, definition: direct });
      continue;
    }
    if (tags.natural === 'beach') {
      kujukuriGeometries.push(geometry);
      continue;
    }
    if (tags.historic === 'castle' && tags.name && /城/u.test(tags.name)) {
      const groupName = normalizeCastleName(tags.name);
      const group = castleGroups.get(groupName) || [];
      group.push({ element, geometry, tags, areaKm2: geometryAreaKm2(geometry) });
      castleGroups.set(groupName, group);
      continue;
    }
    if (officialNationalParks.has(tags.name)) {
      const group = nationalParkGroups.get(tags.name) || [];
      group.push({ element, geometry, tags, areaKm2: geometryAreaKm2(geometry) });
      nationalParkGroups.set(tags.name, group);
    }
  }

  const generated = [];
  const foundExistingKeeps = new Set();
  const foundReconstructedKeeps = new Set();

  for (const candidates of castleGroups.values()) {
    const selected = candidates.slice().sort((a, b) => b.areaKm2 - a.areaKm2)[0];
    const existingName = matchedListedName(selected.tags.name, existingKeeps);
    const reconstructedName = existingName ? null : matchedListedName(selected.tags.name, reconstructedKeeps);
    if (!existingName && !reconstructedName && selected.areaKm2 < largeCastleThresholdKm2) continue;
    if (existingName) foundExistingKeeps.add(existingName);
    if (reconstructedName) foundReconstructedKeeps.add(reconstructedName);
    const prefix = osmPrefix(selected.element.type);
    const id = `attraction-castle-${prefix}${selected.element.id}`;
    const geometryFile = `attractions/castle-${prefix}${selected.element.id}.geojson`;
    const subtype = existingName ? 'castle-existing' : reconstructedName ? 'castle-reconstructed' : 'castle-ruins-large';
    const subtypeLabel = existingName ? '城郭・現存天守' : reconstructedName ? '城郭・再建天守' : '城跡・大規模遺構';
    const statusLabel = existingName ? '現存12天守' : reconstructedName ? '復元・外観復元・復興・模擬天守を含む' : `境界面積10ha以上（概算${selected.areaKm2.toFixed(2)}km²）`;
    const properties = {
      id, kind: 'attraction', name: selected.tags.name, shortName: selected.tags.short_name || selected.tags.name,
      context: contextFromTags(selected.tags), subtype, subtypeLabel, statusLabel,
      aliases: [selected.tags.alt_name, selected.tags.old_name, selected.tags['name:en']].filter(Boolean),
      osmType: selected.element.type, osmId: selected.element.id, osmDate: null,
      officialAreaKm2: null, areaSourceLabel: '', areaSourceUrl: '',
      eventSourceLabel: '文化庁「近世城郭内の復元建造物等の実態について」等', eventSourceUrl: castleSourceUrl,
      boundarySourceLabel: '© OpenStreetMap contributors', boundarySourceUrl: osmCopyrightUrl, geometryFile
    };
    generated.push(writeFeature(properties, selected.geometry));
  }


  for (const fallback of existingKeepPointFallbacks) {
    if (foundExistingKeeps.has(fallback.name)) continue;
    const id = `attraction-castle-node-${fallback.osmId}`;
    const geometryFile = `attractions/castle-node-${fallback.osmId}.geojson`;
    const geometry = circleGeometry(fallback.lon, fallback.lat);
    const properties = {
      id, kind: 'attraction', name: fallback.name, shortName: fallback.name, context: fallback.context,
      subtype: 'castle-existing', subtypeLabel: '城郭・現存天守',
      statusLabel: '現存12天守／OSM天守位置から半径30mの参考範囲', aliases: [],
      osmType: 'node', osmId: fallback.osmId, osmDate: null,
      officialAreaKm2: null, areaSourceLabel: '', areaSourceUrl: '',
      eventSourceLabel: '文化庁「国指定文化財等データベース」', eventSourceUrl: 'https://kunishitei.bunka.go.jp/bsys/index',
      boundarySourceLabel: '© OpenStreetMap contributors（位置）', boundarySourceUrl: osmCopyrightUrl, geometryFile
    };
    generated.push(writeFeature(properties, geometry));
    foundExistingKeeps.add(fallback.name);
  }

  for (const candidates of nationalParkGroups.values()) {
    const selected = candidates.slice().sort((a, b) => b.areaKm2 - a.areaKm2)[0];
    const prefix = osmPrefix(selected.element.type);
    const id = `attraction-national-park-${prefix}${selected.element.id}`;
    const geometryFile = `attractions/national-park-${prefix}${selected.element.id}.geojson`;
    const properties = {
      id, kind: 'attraction', name: selected.tags.name, shortName: selected.tags.short_name || selected.tags.name,
      context: contextFromTags(selected.tags), subtype: 'national-park', subtypeLabel: '国立公園・大規模自然',
      statusLabel: '環境省指定国立公園', aliases: [selected.tags['name:en']].filter(Boolean),
      osmType: selected.element.type, osmId: selected.element.id, osmDate: null,
      officialAreaKm2: null, areaSourceLabel: '', areaSourceUrl: '',
      eventSourceLabel: '環境省「国立公園一覧」', eventSourceUrl: nationalParkSourceUrl,
      boundarySourceLabel: '© OpenStreetMap contributors', boundarySourceUrl: osmCopyrightUrl, geometryFile
    };
    generated.push(writeFeature(properties, selected.geometry));
  }

  for (const { element, geometry, definition } of scenicCandidates.values()) {
    const prefix = osmPrefix(element.type);
    const id = `attraction-scenic-${prefix}${element.id}`;
    const geometryFile = `attractions/scenic-${prefix}${element.id}.geojson`;
    const properties = {
      id, kind: 'attraction', name: definition.name, shortName: definition.name, context: definition.context,
      subtype: definition.subtype, subtypeLabel: definition.subtypeLabel, statusLabel: definition.statusLabel,
      aliases: [], osmType: element.type, osmId: element.id, osmDate: null,
      officialAreaKm2: null, areaSourceLabel: '', areaSourceUrl: '',
      boundarySourceLabel: '© OpenStreetMap contributors', boundarySourceUrl: osmCopyrightUrl, geometryFile
    };
    generated.push(writeFeature(properties, geometry));
  }

  if (kujukuriGeometries.length) {
    const geometry = mergeGeometries(kujukuriGeometries);
    const id = 'attraction-scenic-kujukuri-beaches';
    const geometryFile = 'attractions/scenic-kujukuri-beaches.geojson';
    const properties = {
      id, kind: 'attraction', name: '九十九里浜', shortName: '九十九里浜', context: '千葉県',
      subtype: 'scenic-large', subtypeLabel: '景勝地・大規模地形',
      statusLabel: `九十九里沿岸の砂浜ポリゴン${kujukuriGeometries.length}区画`, aliases: ['九十九里海岸'],
      osmType: 'aggregate', osmId: null, osmDate: null,
      officialAreaKm2: null, areaSourceLabel: '', areaSourceUrl: '',
      boundarySourceLabel: '© OpenStreetMap contributors', boundarySourceUrl: osmCopyrightUrl, geometryFile
    };
    generated.push(writeFeature(properties, geometry));
  }

  const features = [...preserved, ...generated];
  const rank = subtype => ({
    'expo-site': 0, 'event-site': 0, landmark: 0, 'imperial-site': 1,
    'castle-existing': 2, 'castle-reconstructed': 3, 'castle-ruins-large': 4,
    'scenic-large': 5, 'national-park': 6, 'theme-park': 7
  }[subtype] ?? 8);
  features.sort((a, b) => rank(a.properties.subtype) - rank(b.properties.subtype) || String(a.properties.name).localeCompare(String(b.properties.name), 'ja'));
  fs.writeFileSync(catalogPath, `${JSON.stringify({ type: 'FeatureCollection', features })}\n`);

  const report = {
    generatedAt: new Date().toISOString(), totalCatalogFeatures: features.length,
    generatedFeatures: generated.length,
    existingKeepFeatures: generated.filter(feature => feature.properties.subtype === 'castle-existing').length,
    reconstructedKeepFeatures: generated.filter(feature => feature.properties.subtype === 'castle-reconstructed').length,
    largeCastleRuinFeatures: generated.filter(feature => feature.properties.subtype === 'castle-ruins-large').length,
    nationalParkFeatures: generated.filter(feature => feature.properties.subtype === 'national-park').length,
    missingNationalParks: [...officialNationalParks].filter(name => !generated.some(feature => feature.properties.subtype === 'national-park' && feature.properties.name === name)),
    scenicLargeFeatures: generated.filter(feature => feature.properties.subtype === 'scenic-large').length,
    imperialSiteFeatures: generated.filter(feature => feature.properties.subtype === 'imperial-site').length,
    missingExistingKeeps: existingKeeps.filter(name => !foundExistingKeeps.has(name)),
    missingReconstructedKeeps: reconstructedKeeps.filter(name => !foundReconstructedKeeps.has(name)),
    rejected
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
