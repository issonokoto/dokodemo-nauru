const fs = require('fs');
const path = require('path');

const root = process.env.DOKODEMO_NAURU_ROOT || path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'data', 'attractions.geojson');
const geometryDir = path.join(root, 'data', 'attractions');
const reportPath = path.join(root, 'scripts', 'japan-parks-zoos-gardens-report.json');
const osmCopyrightUrl = 'https://www.openstreetmap.org/copyright';
const minimumLargeParkAreaKm2 = 0.5;
const minimumNotableParkAreaKm2 = 0.1;

const managedSubtypes = new Set([
  'large-park',
  'zoo',
  'botanical-garden',
  'zoological-botanical-park'
]);

const famousParkNames = new Set([
  'あすたむらんど徳島',
  '上野恩賜公園',
  '日比谷公園',
  '代々木公園',
  '山下公園',
  '井の頭恩賜公園',
  '奈良公園',
  '大濠公園',
  '平和記念公園',
  '円山公園',
  '中島公園',
  '舞鶴公園',
  '水前寺江津湖公園',
  '高松市立中央公園'
]);

const extraAliasesByOsm = new Map([
  ['way:471312607', ['とくしま植物園']]
]);

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

function samePoint(a, b) {
  return a && b && a[0] === b[0] && a[1] === b[1];
}

function coordinatesFromGeometry(geometry) {
  return Array.isArray(geometry) ? geometry.map(point => [point.lon, point.lat]) : [];
}

function stitchRings(members) {
  const segments = members
    .map(member => coordinatesFromGeometry(member.geometry))
    .filter(coordinates => coordinates.length > 1);
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
  const members = Array.isArray(element.members)
    ? element.members.filter(member => member.type === 'way')
    : [];
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
  const polygonArea = polygon =>
    Math.max(0, ringAreaKm2(polygon[0]) -
      polygon.slice(1).reduce((sum, ring) => sum + ringAreaKm2(ring), 0));
  return geometry.type === 'Polygon'
    ? polygonArea(geometry.coordinates)
    : geometry.coordinates.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
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
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[previous];
    if (((y1 > point[1]) !== (y2 > point[1])) &&
        point[0] < (x2 - x1) * (point[1] - y1) / (y2 - y1 || Number.EPSILON) + x1) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInJapan(point, japanGeometry) {
  const polygons = japanGeometry.type === 'Polygon'
    ? [japanGeometry.coordinates]
    : japanGeometry.coordinates;
  return polygons.some(polygon =>
    polygon[0] &&
    pointInRing(point, polygon[0]) &&
    !polygon.slice(1).some(ring => pointInRing(point, ring)));
}

function pointInGeometry(point, geometry) {
  const polygons = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.coordinates;
  return polygons.some(polygon =>
    polygon[0] &&
    pointInRing(point, polygon[0]) &&
    !polygon.slice(1).some(ring => pointInRing(point, ring)));
}

function normalizeName(value) {
  return String(value || '').replace(/[\s　・･]/g, '').toLowerCase();
}

function aliasesFromTags(tags) {
  return [...new Set([
    tags['name:ja'],
    tags['name:en'],
    tags.alt_name,
    tags.old_name,
    tags.short_name,
    tags.official_name
  ].flatMap(value => String(value || '').split(';'))
    .map(value => value.trim())
    .filter(value => value && value !== tags.name))];
}

function contextFromTags(tags) {
  const values = [
    tags['addr:province'],
    tags['is_in:province'],
    tags['addr:city'],
    tags['is_in:city']
  ].filter(Boolean);
  return values.length ? [...new Set(values)].join('・') : '日本';
}

function classify(tags, name) {
  if (tags.tourism === 'zoo') {
    return { subtype: 'zoo', subtypeLabel: '動物園', minimumArea: 0.005 };
  }
  if (/動植物公園|動植物園/.test(name)) {
    return {
      subtype: 'zoological-botanical-park',
      subtypeLabel: '動植物園・総合公園',
      minimumArea: 0.02
    };
  }
  const botanical = /植物園|植物公園|ボタニカルガーデン|フラワーパーク/.test(name) ||
    (tags.leisure === 'garden' &&
      /^(botanical|arboretum)$/.test(tags['garden:type'] || ''));
  if (botanical) {
    return {
      subtype: 'botanical-garden',
      subtypeLabel: '植物園・植物公園',
      minimumArea: 0.005
    };
  }
  return {
    subtype: 'large-park',
    subtypeLabel: '大型都市公園・広域公園',
    minimumArea: minimumLargeParkAreaKm2
  };
}

function isFacilitySection(classification, name) {
  if (!['zoo', 'botanical-garden'].includes(classification.subtype)) return false;
  if (/(ゾーン|エリア)$/.test(name)) return true;
  return ['ふれあいの国', '野生の国'].includes(name);
}

function parkIsIncluded(tags, name, areaKm2) {
  if (areaKm2 >= minimumLargeParkAreaKm2) return true;
  if (/^国営.*公園$/.test(name)) return true;
  if (famousParkNames.has(name) && (tags.wikidata || tags.wikipedia)) return true;
  return areaKm2 >= minimumNotableParkAreaKm2 && Boolean(tags.wikidata || tags.wikipedia);
}

function distanceKm(a, b) {
  const lat1 = a[1] * Math.PI / 180;
  const lat2 = b[1] * Math.PI / 180;
  const deltaLat = lat2 - lat1;
  const deltaLon = (b[0] - a[0]) * Math.PI / 180;
  const value = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

async function fetchOverpassBox(box, boxIndex) {
  const cachePath = path.join(root, `.park-facility-cache-${boxIndex + 1}.json`);
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    cached.fromLocalCache = true;
    return cached;
  }
  const bbox = `(${box.join(',')})`;
  const query = `[out:json][timeout:240][maxsize:536870912];
    (
      way["leisure"="park"]["name"]${bbox};
      relation["leisure"="park"]["name"]${bbox};
      way["tourism"="zoo"]["name"]${bbox};
      relation["tourism"="zoo"]["name"]${bbox};
      way["leisure"="garden"]["name"]${bbox};
      relation["leisure"="garden"]["name"]${bbox};
    );
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
          'User-Agent': 'Dokodemo-Nauru park and facility catalog maintenance (https://issonokoto.github.io/dokodemo-nauru/)'
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(120000)
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
  throw lastError || new Error(`Overpass request failed: region ${boxIndex + 1}`);
}

async function fetchOverpass() {
  const elementMap = new Map();
  const concurrency = 3;
  for (let start = 0; start < japanQueryBoxes.length; start += concurrency) {
    const indexes = japanQueryBoxes
      .slice(start, start + concurrency)
      .map((unused, offset) => start + offset);
    const results = await Promise.all(indexes.map(index =>
      fetchOverpassBox(japanQueryBoxes[index], index)));
    results.forEach((data, resultIndex) => {
      const index = indexes[resultIndex];
      (data.elements || []).forEach(element =>
        elementMap.set(`${element.type}:${element.id}`, element));
      console.log(`region ${index + 1} / ${japanQueryBoxes.length}`);
    });
    if (results.some(data => !data.fromLocalCache)) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  return [...elementMap.values()];
}

function geometryFilename(subtype, element) {
  const prefix = element.type === 'relation' ? 'R' : 'W';
  return `attractions/${subtype}-${prefix}${element.id}.geojson`;
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const japan = JSON.parse(fs.readFileSync(
    path.join(root, 'data', 'countries', 'JPN.geojson'),
    'utf8'
  ));
  const japanGeometry = japan.geometry ||
    (japan.features && japan.features[0] && japan.features[0].geometry);
  const existingFeatures = catalog.features || [];
  const existingByOsm = new Map(existingFeatures.map(feature => {
    const properties = feature.properties || {};
    return [`${properties.osmType}:${properties.osmId}`, feature];
  }));
  const kept = existingFeatures.filter(feature =>
    !managedSubtypes.has(feature.properties && feature.properties.subtype));
  const imported = [];
  const candidates = [];
  const reclassifiedIds = new Set();
  const rejected = [];
  const selectedKeys = new Set();
  const elements = await fetchOverpass();

  for (const element of elements) {
    if (!['way', 'relation'].includes(element.type)) continue;
    const tags = element.tags || {};
    const name = tags.name || tags['name:ja'] || '';
    if (!name) continue;
    const geometry = geometryFromElement(element);
    if (!geometry) {
      rejected.push({ name, osmType: element.type, osmId: element.id, reason: 'geometry' });
      continue;
    }
    if (!pointInJapan(geometryCenter(geometry), japanGeometry)) continue;
    const classification = classify(tags, name);
    if (isFacilitySection(classification, name)) {
      rejected.push({
        name,
        osmType: element.type,
        osmId: element.id,
        reason: 'facility-section'
      });
      continue;
    }
    const areaKm2 = geometryAreaKm2(geometry);
    const botanicalOrZoo = classification.subtype !== 'large-park';
    const included = botanicalOrZoo
      ? areaKm2 >= classification.minimumArea
      : parkIsIncluded(tags, name, areaKm2);
    if (!included) {
      rejected.push({
        name,
        osmType: element.type,
        osmId: element.id,
        areaKm2,
        reason: 'small-or-not-notable'
      });
      continue;
    }

    const osmKey = `${element.type}:${element.id}`;
    if (selectedKeys.has(osmKey)) continue;
    const existing = existingByOsm.get(osmKey);
    let reclassifiedId = '';
    if (existing && !managedSubtypes.has(existing.properties && existing.properties.subtype)) {
      const existingSubtype = existing.properties && existing.properties.subtype;
      const shouldReclassify = existingSubtype === 'theme-park' &&
        ['zoo', 'botanical-garden', 'zoological-botanical-park'].includes(classification.subtype);
      if (!shouldReclassify) continue;
      reclassifiedId = existing.id || (existing.properties && existing.properties.id) || '';
    }

    const prefix = element.type === 'relation' ? 'R' : 'W';
    const existingProperties = existing ? existing.properties || {} : {};
    const id = existingProperties.id ||
      `attraction-${classification.subtype}-${prefix}${element.id}`;
    const geometryFile = existingProperties.geometryFile ||
      geometryFilename(classification.subtype, element);
    const aliases = [...new Set([
      ...(Array.isArray(existingProperties.aliases) ? existingProperties.aliases : []),
      ...aliasesFromTags(tags),
      ...(extraAliasesByOsm.get(osmKey) || [])
    ])];
    const properties = {
      ...existingProperties,
      id,
      kind: 'attraction',
      name,
      shortName: tags.short_name || existingProperties.shortName || name,
      context: existingProperties.context || contextFromTags(tags),
      subtype: classification.subtype,
      subtypeLabel: classification.subtypeLabel,
      statusLabel: classification.subtype === 'large-park' && areaKm2 < minimumLargeParkAreaKm2
        ? '著名な公園'
        : '',
      aliases,
      osmType: element.type,
      osmId: element.id,
      osmDate: null,
      officialAreaKm2: existingProperties.officialAreaKm2 || null,
      areaSourceLabel: existingProperties.areaSourceLabel || '',
      areaSourceUrl: existingProperties.areaSourceUrl || '',
      boundarySourceLabel: '© OpenStreetMap contributors',
      boundarySourceUrl: osmCopyrightUrl,
      geometryFile
    };
    candidates.push({
      id,
      properties,
      geometry,
      areaKm2,
      center: geometryCenter(geometry),
      reclassifiedId
    });
    selectedKeys.add(osmKey);
  }

  const deduplicated = [];
  for (const candidate of candidates.slice().sort((a, b) => b.areaKm2 - a.areaKm2)) {
    const normalized = normalizeName(candidate.properties.name);
    const containingFacility = ['zoo', 'botanical-garden'].includes(candidate.properties.subtype)
      ? deduplicated.find(existing =>
        existing.properties.subtype === candidate.properties.subtype &&
        existing.areaKm2 >= candidate.areaKm2 * 1.5 &&
        pointInGeometry(candidate.center, existing.geometry))
      : null;
    if (containingFacility) {
      rejected.push({
        name: candidate.properties.name,
        osmType: candidate.properties.osmType,
        osmId: candidate.properties.osmId,
        areaKm2: candidate.areaKm2,
        reason: 'contained-facility-area',
        keptName: containingFacility.properties.name,
        keptOsmType: containingFacility.properties.osmType,
        keptOsmId: containingFacility.properties.osmId
      });
      continue;
    }
    const duplicate = deduplicated.find(existing =>
      existing.properties.subtype === candidate.properties.subtype &&
      normalizeName(existing.properties.name) === normalized &&
      distanceKm(existing.center, candidate.center) <= 5);
    if (duplicate) {
      rejected.push({
        name: candidate.properties.name,
        osmType: candidate.properties.osmType,
        osmId: candidate.properties.osmId,
        areaKm2: candidate.areaKm2,
        reason: 'nearby-duplicate',
        keptOsmType: duplicate.properties.osmType,
        keptOsmId: duplicate.properties.osmId
      });
      continue;
    }
    deduplicated.push(candidate);
  }

  for (const candidate of deduplicated) {
    if (candidate.reclassifiedId) reclassifiedIds.add(candidate.reclassifiedId);
    const geometryFeature = {
      type: 'Feature',
      id: candidate.id,
      properties: candidate.properties,
      geometry: candidate.geometry
    };
    fs.writeFileSync(
      path.join(root, 'data', candidate.properties.geometryFile),
      `${JSON.stringify(geometryFeature)}\n`
    );
    imported.push({
      type: 'Feature',
      id: candidate.id,
      properties: candidate.properties,
      geometry: null
    });
  }

  const features = kept
    .filter(feature => !reclassifiedIds.has(feature.id || (feature.properties && feature.properties.id)))
    .concat(imported)
    .sort((a, b) => String(a.properties.name).localeCompare(String(b.properties.name), 'ja'));
  fs.writeFileSync(catalogPath, `${JSON.stringify({
    type: 'FeatureCollection',
    features,
    generatedAt: new Date().toISOString()
  })}\n`);

  const subtypeCounts = Object.fromEntries([...managedSubtypes].map(subtype => [
    subtype,
    imported.filter(feature => feature.properties.subtype === subtype).length
  ]));
  const report = {
    generatedAt: new Date().toISOString(),
    source: 'OpenStreetMap named polygon boundaries in Japan',
    selection: {
      largeParkMinimumAreaKm2: minimumLargeParkAreaKm2,
      notableParkMinimumAreaKm2: minimumNotableParkAreaKm2,
      notableSignals: ['wikidata', 'wikipedia', '国営 in name', 'curated famous names']
    },
    totalCatalogFeatures: features.length,
    importedFeatures: imported.length,
    subtypeCounts,
    reclassifiedFeatures: reclassifiedIds.size,
    rejectedCount: rejected.length,
    rejected
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    total: features.length,
    imported: imported.length,
    subtypeCounts,
    reclassified: reclassifiedIds.size,
    rejected: rejected.length
  }, null, 2));
}

main().then(() => {
  process.exit(0);
}).catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
