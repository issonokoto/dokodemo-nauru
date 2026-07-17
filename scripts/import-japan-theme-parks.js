const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'data', 'attractions.geojson');
const geometryDir = path.join(root, 'data', 'attractions');
const reportPath = path.join(root, 'scripts', 'japan-theme-parks-report.json');
const osmCopyrightUrl = 'https://www.openstreetmap.org/copyright';
const expoSourceLabel = '経済産業省「日本で開かれた国際博覧会」';
const expoSourceUrl = 'https://www.meti.go.jp/policy/exhibition/jpofficialrecordbook.pdf';

const expoHeritage = {
  '万博記念公園': {
    name: '大阪万博会場跡・万博記念公園（1970年）',
    shortName: '万博記念公園', context: '大阪府吹田市', statusLabel: '1970年大阪万博会場跡',
    aliases: ['日本万国博覧会', 'EXPO 70', '大阪万博'],
    bounds: [135.50, 34.78, 135.56, 34.83]
  },
  '海洋博公園': {
    name: '沖縄海洋博会場跡・海洋博公園（1975年）',
    shortName: '海洋博公園', context: '沖縄県国頭郡本部町', statusLabel: '1975年沖縄国際海洋博覧会会場跡',
    aliases: ['沖縄国際海洋博覧会', '沖縄海洋博', 'EXPO 75'],
    bounds: [127.85, 26.66, 127.91, 26.72]
  },
  '科学万博記念公園': {
    name: 'つくば博会場跡・科学万博記念公園（1985年）',
    shortName: '科学万博記念公園', context: '茨城県つくば市', statusLabel: '1985年国際科学技術博覧会会場跡の記念公園',
    aliases: ['国際科学技術博覧会', 'つくば博', 'EXPO 85'],
    bounds: [140.04, 36.03, 140.10, 36.09]
  },
  '花博記念公園 鶴見緑地': {
    name: '大阪花博会場跡・花博記念公園鶴見緑地（1990年）',
    shortName: '花博記念公園鶴見緑地', context: '大阪府大阪市鶴見区', statusLabel: '1990年国際花と緑の博覧会会場跡',
    aliases: ['国際花と緑の博覧会', '花の万博', 'EXPO 90', '花博記念公園鶴見緑地'],
    bounds: [135.54, 34.69, 135.60, 34.73], mergeCandidates: true
  },
  '愛・地球博記念公園': {
    name: '愛・地球博会場跡・愛・地球博記念公園（2005年）',
    shortName: '愛・地球博記念公園', context: '愛知県長久手市', statusLabel: '2005年日本国際博覧会長久手会場跡',
    aliases: ['2005年日本国際博覧会', '愛・地球博', 'モリコロパーク', 'EXPO 2005'],
    bounds: [137.05, 35.14, 137.12, 35.20]
  }
};

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

function geometryCenter(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const points = polygons.flatMap(polygon => polygon[0]);
  return [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length
  ];
}

function geometryInBounds(geometry, bounds) {
  const [lon, lat] = geometryCenter(geometry);
  return !bounds || (lon >= bounds[0] && lat >= bounds[1] && lon <= bounds[2] && lat <= bounds[3]);
}

function mergeGeometries(geometries) {
  const polygons = geometries.flatMap(geometry => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates);
  return polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
}

function featureKey(type, id) {
  return `${type}:${id}`;
}

function osmPrefix(type) {
  return type === 'relation' ? 'R' : 'W';
}

function aliasesFromTags(tags) {
  return [...new Set([
    tags['name:ja'], tags['name:en'], tags.alt_name, tags.old_name, tags.short_name, tags.official_name
  ].flatMap(value => String(value || '').split(';')).map(value => value.trim()).filter(value => value && value !== tags.name))];
}

function contextFromTags(tags) {
  return tags['addr:province'] || tags['is_in:province'] || tags['addr:city'] || tags['is_in:city'] || '日本';
}

async function fetchOverpass() {
  const expoNames = Object.keys(expoHeritage).map(name => `nwr["name"="${name}"](area.japan);`).join('\n');
  const query = `[out:json][timeout:300][maxsize:536870912];
    area["ISO3166-1"="JP"]["admin_level"="2"]->.japan;
    (
      nwr["tourism"="theme_park"](area.japan);
      ${expoNames}
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
          'User-Agent': 'Dokodemo-Nauru Japan theme park catalog maintenance (https://issonokoto.github.io/dokodemo-nauru/)'
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

async function main() {
  const existingCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const existingFeatures = existingCatalog.features || [];
  const existingByOsm = new Map(existingFeatures.map(feature => {
    const properties = feature.properties || {};
    return [featureKey(properties.osmType, properties.osmId), feature];
  }));
  const data = await fetchOverpass();
  const unresolvedNodes = [];
  const unresolvedAreas = [];
  const generated = [];
  const generatedKeys = new Set();
  const expoCandidates = new Map();

  for (const element of data.elements) {
    const tags = element.tags || {};
    const originalName = tags.name || tags['name:ja'] || '';
    const expo = expoHeritage[originalName];
    const isThemePark = tags.tourism === 'theme_park';
    if (!expo && !isThemePark) continue;
    if (element.type === 'node') {
      if (isThemePark) unresolvedNodes.push({ osmType: element.type, osmId: element.id, name: originalName || '（名称なし）', tags });
      continue;
    }
    const key = featureKey(element.type, element.id);
    if (generatedKeys.has(key)) continue;
    const geometry = geometryFromElement(element);
    if (!geometry || geometryAreaKm2(geometry) <= 0) {
      unresolvedAreas.push({ osmType: element.type, osmId: element.id, name: originalName || '（名称なし）' });
      continue;
    }
    if (!originalName) {
      unresolvedAreas.push({ osmType: element.type, osmId: element.id, name: '（名称なし）' });
      continue;
    }

    if (expo) {
      if (!geometryInBounds(geometry, expo.bounds)) continue;
      const candidates = expoCandidates.get(expo.name) || [];
      candidates.push({ element, geometry, expo });
      expoCandidates.set(expo.name, candidates);
      continue;
    }

    const existing = existingByOsm.get(key);
    if (existing) {
      generated.push(existing);
      generatedKeys.add(key);
      continue;
    }

    const prefix = osmPrefix(element.type);
    const id = `attraction-${prefix}${element.id}`;
    const geometryFile = `attractions/${prefix}${element.id}.geojson`;
    const properties = {
      id, kind: 'attraction', name: originalName, shortName: tags.short_name || originalName,
      context: contextFromTags(tags), subtype: 'theme-park', subtypeLabel: '遊園地・テーマパーク', statusLabel: '',
      aliases: aliasesFromTags(tags), osmType: element.type, osmId: element.id, osmDate: null,
      officialAreaKm2: null, areaSourceLabel: '', areaSourceUrl: '',
      boundarySourceLabel: '© OpenStreetMap contributors', boundarySourceUrl: osmCopyrightUrl, geometryFile
    };
    const feature = { type: 'Feature', id, properties, geometry };
    fs.writeFileSync(path.join(root, 'data', geometryFile), `${JSON.stringify(feature)}\n`);
    generated.push({ type: 'Feature', id, properties, geometry: null });
    generatedKeys.add(key);
  }

  for (const candidates of expoCandidates.values()) {
    const expo = candidates[0].expo;
    const selected = expo.mergeCandidates
      ? candidates
      : [candidates.slice().sort((a, b) => geometryAreaKm2(b.geometry) - geometryAreaKm2(a.geometry))[0]];
    const geometry = mergeGeometries(selected.map(candidate => candidate.geometry));
    const primary = selected.slice().sort((a, b) => geometryAreaKm2(b.geometry) - geometryAreaKm2(a.geometry))[0].element;
    const prefix = osmPrefix(primary.type);
    const id = `attraction-expo-${expo.statusLabel.match(/\d{4}/)[0]}`;
    const geometryFile = `attractions/${id.replace('attraction-', '')}.geojson`;
    const properties = {
      id, kind: 'attraction', name: expo.name, shortName: expo.shortName, context: expo.context,
      subtype: 'expo-site', subtypeLabel: '万博会場跡・記念公園', statusLabel: expo.statusLabel,
      aliases: expo.aliases, osmType: primary.type, osmId: primary.id, osmDate: null,
      officialAreaKm2: null, areaSourceLabel: '', areaSourceUrl: '',
      eventSourceLabel: expoSourceLabel, eventSourceUrl: expoSourceUrl,
      boundarySourceLabel: '© OpenStreetMap contributors', boundarySourceUrl: osmCopyrightUrl, geometryFile
    };
    const feature = { type: 'Feature', id, properties, geometry };
    fs.writeFileSync(path.join(root, 'data', geometryFile), `${JSON.stringify(feature)}\n`);
    generated.push({ type: 'Feature', id, properties, geometry: null });
    for (const candidate of selected) generatedKeys.add(featureKey(candidate.element.type, candidate.element.id));
  }

  for (const feature of existingFeatures) {
    const properties = feature.properties || {};
    if (properties.subtype === 'expo-site') continue;
    const key = featureKey(properties.osmType, properties.osmId);
    if (generatedKeys.has(key)) continue;
    generated.push(feature);
    generatedKeys.add(key);
  }

  generated.sort((a, b) => {
    const subtypeA = a.properties && a.properties.subtype;
    const subtypeB = b.properties && b.properties.subtype;
    const rank = subtype => subtype === 'expo-site' || subtype === 'event-site' || subtype === 'landmark' ? 0 : 1;
    return rank(subtypeA) - rank(subtypeB) || String(a.properties.name).localeCompare(String(b.properties.name), 'ja');
  });
  fs.writeFileSync(catalogPath, `${JSON.stringify({ type: 'FeatureCollection', features: generated })}\n`);
  const report = {
    generatedAt: new Date().toISOString(),
    source: 'OpenStreetMap tourism=theme_park in Japan',
    totalCatalogFeatures: generated.length,
    themeParkPolygons: generated.filter(feature => feature.properties && feature.properties.subtype === 'theme-park').length,
    expoHeritageFeatures: generated.filter(feature => feature.properties && feature.properties.subtype === 'expo-site').length,
    unresolvedNodeCount: unresolvedNodes.length,
    unresolvedAreaCount: unresolvedAreas.length,
    unresolvedNodes,
    unresolvedAreas
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
