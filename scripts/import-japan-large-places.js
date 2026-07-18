const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'data', 'attractions.geojson');
const geometryDir = path.join(root, 'data', 'attractions');
const reportPath = path.join(__dirname, 'japan-large-places-report.json');
const osmCopyrightUrl = 'https://www.openstreetmap.org/copyright';

const managedSubtypes = new Set([
  'airport', 'military-base', 'world-heritage', 'large-port', 'industrial-complex',
  'large-farm', 'large-mine'
]);

const categoryDefinitions = {
  airport: {
    query: `
      way["aeroway"="aerodrome"]["name"](area.japan);
      relation["aeroway"="aerodrome"]["name"](area.japan);`
  },
  military: {
    query: `
      way["landuse"="military"]["name"](area.japan);
      relation["landuse"="military"]["name"](area.japan);
      way["military"~"^(base|airfield|barracks|naval_base|training_area|range)$"]["name"](area.japan);
      relation["military"~"^(base|airfield|barracks|naval_base|training_area|range)$"]["name"](area.japan);`
  },
  heritage: {
    query: `
      way["ref:whc"]["name"](area.japan);
      relation["ref:whc"]["name"](area.japan);
      way["heritage:operator"~"(whc|unesco)",i]["name"](area.japan);
      relation["heritage:operator"~"(whc|unesco)",i]["name"](area.japan);`
  },
  infrastructure: {
    query: `
      way["landuse"="industrial"]["name"~"(コンビナート|工業地帯|工業団地|製鉄所|製油所|発電所|大規模工場)"](area.japan);
      relation["landuse"="industrial"]["name"~"(コンビナート|工業地帯|工業団地|製鉄所|製油所|発電所|大規模工場)"](area.japan);
      way["industrial"="port"]["name"](area.japan);
      relation["industrial"="port"]["name"](area.japan);
      way["landuse"="port"]["name"](area.japan);
      relation["landuse"="port"]["name"](area.japan);
      way["boundary"="harbour"]["name"](area.japan);
      relation["boundary"="harbour"]["name"](area.japan);`
  },
  land: {
    query: `
      way["landuse"~"^(farmland|farmyard|meadow|orchard|vineyard)$"]["name"~"(牧場|農場|ファーム|農園)"](area.japan);
      relation["landuse"~"^(farmland|farmyard|meadow|orchard|vineyard)$"]["name"~"(牧場|農場|ファーム|農園)"](area.japan);
      way["landuse"="quarry"]["name"](area.japan);
      relation["landuse"="quarry"]["name"](area.japan);
      way["man_made"="mine"]["name"](area.japan);
      relation["man_made"="mine"]["name"](area.japan);`
  }
};

const japanQueryBoxes = [
  [24, 122, 27.8, 131],
  [27, 128, 32, 133],
  [31, 129, 33, 133],
  [32.5, 129, 35, 136],
  [33, 133, 35, 138],
  [34.5, 133, 36.5, 139],
  [34, 136, 36, 139],
  [34, 139, 37.5, 141],
  [34, 139, 36.5, 142],
  [36, 139, 39, 143],
  [37, 138, 40, 142],
  [39.5, 139, 42, 143],
  [41, 139, 44, 143],
  [43, 140, 46, 146],
  [20, 135, 28, 145]
];

const officialAreas = new Map([
  ['東京国際空港', { area: 15.15, label: '国土交通省 東京航空局「よくある質問」', url: 'https://www.cab.mlit.go.jp/tcab/about/faq.html' }],
  ['羽田空港', { area: 15.15, label: '国土交通省 東京航空局「よくある質問」', url: 'https://www.cab.mlit.go.jp/tcab/about/faq.html' }],
  ['成田国際空港', { area: 11.51, label: '国土交通省 東京航空局「空港の概況」', url: 'https://www.cab.mlit.go.jp/tcab/conditions/04_kanto/narita.pdf' }],
  ['嘉手納飛行場', { area: 19.856, label: '防衛省「在日米軍施設・区域（専用施設）面積」', url: 'https://www.mod.go.jp/j/approach/zaibeigun/us_sisetsu/pdf/menseki_2025.pdf' }],
  ['三沢飛行場', { area: 15.78, label: '防衛省「在日米軍施設・区域（専用施設）面積」', url: 'https://www.mod.go.jp/j/approach/zaibeigun/us_sisetsu/pdf/menseki_2025.pdf' }],
  ['Misawa Air Base - 三沢飛行場', { area: 15.78, label: '防衛省「在日米軍施設・区域（専用施設）面積」', url: 'https://www.mod.go.jp/j/approach/zaibeigun/us_sisetsu/pdf/menseki_2025.pdf' }],
  ['三沢基地', { area: 16, label: '航空自衛隊 三沢基地「基地紹介」', url: 'https://www.mod.go.jp/asdf/misawa/about_base/about_base/' }]
]);

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

function geometryCenter(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const points = polygons.flatMap(polygon => polygon[0] || []);
  return [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length
  ];
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (((yi > point[1]) !== (yj > point[1])) &&
        point[0] < (xj - xi) * (point[1] - yi) / (yj - yi || Number.EPSILON) + xi) inside = !inside;
  }
  return inside;
}

function pointInJapan(point, japanGeometry) {
  const polygons = japanGeometry.type === 'Polygon' ? [japanGeometry.coordinates] : japanGeometry.coordinates;
  return polygons.some(polygon => polygon[0] && pointInRing(point, polygon[0]) &&
    !polygon.slice(1).some(ring => pointInRing(point, ring)));
}

function normalizeName(value) {
  return String(value || '').replace(/[\s　・･]/g, '').toLowerCase();
}

function aliasesFromTags(tags) {
  return [...new Set([
    tags['name:ja'], tags['name:en'], tags.alt_name, tags.old_name, tags.short_name, tags.official_name, tags.operator
  ].flatMap(value => String(value || '').split(';')).map(value => value.trim()).filter(value => value && value !== tags.name))];
}

function contextFromTags(tags) {
  const values = [tags['addr:province'], tags['is_in:province'], tags['addr:city'], tags['is_in:city']].filter(Boolean);
  return values.length ? [...new Set(values)].join('・') : '日本';
}

function classify(category, tags, name) {
  if (category === 'airport') return { subtype: 'airport', subtypeLabel: '空港・飛行場', minimumArea: 0.01 };
  if (category === 'military') return { subtype: 'military-base', subtypeLabel: '基地・駐屯地・演習場', minimumArea: 0.01 };
  if (category === 'heritage') return { subtype: 'world-heritage', subtypeLabel: '世界遺産・登録区域', minimumArea: 0.001 };
  if (category === 'infrastructure') {
    const port = tags.industrial === 'port' || tags.landuse === 'port' || tags.boundary === 'harbour' || /港|埠頭|ふ頭|ターミナル/.test(name);
    return port
      ? { subtype: 'large-port', subtypeLabel: '港湾・埠頭', minimumArea: 0.1 }
      : { subtype: 'industrial-complex', subtypeLabel: '工業地帯・大規模工場', minimumArea: 0.5 };
  }
  const mine = tags.landuse === 'quarry' || tags.man_made === 'mine' || /鉱山|採石|炭鉱|砕石/.test(name);
  return mine
    ? { subtype: 'large-mine', subtypeLabel: '鉱山・採石場', minimumArea: 0.1 }
    : { subtype: 'large-farm', subtypeLabel: '大規模農場・牧場', minimumArea: 0.5 };
}

async function fetchOverpassBox(category, box, boxIndex) {
  const cachePath = path.join(root, `.large-place-cache-${category}-${boxIndex + 1}.json`);
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    cached.fromLocalCache = true;
    return cached;
  }
  const definition = categoryDefinitions[category];
  const bbox = `(${box.join(',')})`;
  const bboxQuery = definition.query.replaceAll('(area.japan)', bbox);
  const query = `[out:json][timeout:180][maxsize:536870912];
    (${bboxQuery});
    out body geom;`;
  const endpoints = [
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter'
  ];
  let lastError;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'Dokodemo-Nauru large place catalog maintenance (https://issonokoto.github.io/dokodemo-nauru/)'
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(90000)
      });
      if (response.ok) {
        const data = await response.json();
        fs.writeFileSync(cachePath, JSON.stringify(data));
        return data;
      }
      lastError = new Error(`Overpass ${response.status}: ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Overpass request failed: ${category} box ${boxIndex + 1}`);
}

async function fetchOverpass(category) {
  const elementMap = new Map();
  for (let index = 0; index < japanQueryBoxes.length; index += 1) {
    const data = await fetchOverpassBox(category, japanQueryBoxes[index], index);
    (data.elements || []).forEach(element => elementMap.set(`${element.type}:${element.id}`, element));
    console.log(`${category}: region ${index + 1} / ${japanQueryBoxes.length}`);
    if (!data.fromLocalCache) await new Promise(resolve => setTimeout(resolve, 2500));
  }
  return { elements: [...elementMap.values()] };
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const japan = JSON.parse(fs.readFileSync(path.join(root, 'data', 'countries', 'JPN.geojson'), 'utf8'));
  const japanGeometry = japan.geometry || (japan.features && japan.features[0] && japan.features[0].geometry);
  const kept = (catalog.features || []).filter(feature => !managedSubtypes.has(feature.properties && feature.properties.subtype));
  const imported = [];
  const rejected = [];
  const categoryCounts = {};

  for (const category of Object.keys(categoryDefinitions)) {
    console.log(`${category}: downloading`);
    const data = await fetchOverpass(category);
    const groups = new Map();
    for (const element of data.elements || []) {
      const tags = element.tags || {};
      const name = tags.name || tags['name:ja'] || '';
      if (!name || !['way', 'relation'].includes(element.type)) continue;
      const geometry = geometryFromElement(element);
      if (!geometry) {
        rejected.push({ category, name, osmType: element.type, osmId: element.id, reason: 'geometry' });
        continue;
      }
      if (!pointInJapan(geometryCenter(geometry), japanGeometry)) continue;
      const classification = classify(category, tags, name);
      const area = geometryAreaKm2(geometry);
      if (!(area >= classification.minimumArea)) {
        rejected.push({ category, name, osmType: element.type, osmId: element.id, areaKm2: area, reason: 'small' });
        continue;
      }
      const key = `${classification.subtype}:${normalizeName(name)}`;
      const group = groups.get(key) || { category, name, classification, items: [] };
      group.items.push({ element, geometry, area, tags });
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      const geometry = mergeGeometries(group.items.map(item => item.geometry));
      const primary = group.items.slice().sort((a, b) => b.area - a.area)[0];
      const prefix = primary.element.type === 'relation' ? 'R' : 'W';
      const id = `attraction-large-${group.classification.subtype}-${prefix}${primary.element.id}`;
      const geometryFile = `attractions/large-${group.classification.subtype}-${prefix}${primary.element.id}.geojson`;
      const official = officialAreas.get(group.name) || null;
      const aliases = [...new Set(group.items.flatMap(item => aliasesFromTags(item.tags)))];
      const contexts = [...new Set(group.items.map(item => contextFromTags(item.tags)).filter(value => value !== '日本'))];
      const properties = {
        id, kind: 'attraction', name: group.name, shortName: primary.tags.short_name || group.name,
        context: contexts.length ? contexts.join('・') : '日本',
        subtype: group.classification.subtype, subtypeLabel: group.classification.subtypeLabel,
        statusLabel: group.items.length > 1 ? `同名の分割区域${group.items.length}区画` : '',
        aliases, osmType: primary.element.type, osmId: primary.element.id, osmDate: null,
        officialAreaKm2: official ? official.area : null,
        areaSourceLabel: official ? official.label : '', areaSourceUrl: official ? official.url : '',
        boundarySourceLabel: '© OpenStreetMap contributors', boundarySourceUrl: osmCopyrightUrl, geometryFile
      };
      const geometryFeature = { type: 'Feature', id, properties, geometry };
      fs.writeFileSync(path.join(root, 'data', geometryFile), `${JSON.stringify(geometryFeature)}\n`);
      imported.push({ type: 'Feature', id, properties, geometry: null });
    }
    categoryCounts[category] = groups.size;
    console.log(`${category}: ${groups.size}`);
  }

  const features = kept.concat(imported).sort((a, b) => String(a.properties.name).localeCompare(String(b.properties.name), 'ja'));
  fs.writeFileSync(catalogPath, `${JSON.stringify({ type: 'FeatureCollection', features, generatedAt: new Date().toISOString() })}\n`);
  const report = {
    generatedAt: new Date().toISOString(),
    source: 'OpenStreetMap named polygon boundaries in Japan',
    totalCatalogFeatures: features.length,
    importedFeatures: imported.length,
    categoryCounts,
    subtypeCounts: Object.fromEntries([...managedSubtypes].map(subtype => [subtype, imported.filter(feature => feature.properties.subtype === subtype).length])),
    rejectedCount: rejected.length,
    rejected
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ total: features.length, imported: imported.length, categoryCounts, subtypeCounts: report.subtypeCounts, rejected: rejected.length }, null, 2));
}

main().then(() => {
  process.exit(0);
}).catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
