const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dataPath = (...parts) => path.join(root, 'data', ...parts);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value)}\n`);

function polygonParts(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  throw new Error(`Unsupported geometry: ${geometry.type}`);
}

function normalizeRingContinuity(ring) {
  if (!ring.length) return ring;
  const result = [ring[0].slice()];
  for (let i = 1; i < ring.length; i += 1) {
    const point = ring[i].slice();
    const previousLongitude = result[i - 1][0];
    while (point[0] - previousLongitude > 180) point[0] -= 360;
    while (point[0] - previousLongitude < -180) point[0] += 360;
    result.push(point);
  }
  const longitudes = result.map(point => point[0]);
  const center = (Math.min(...longitudes) + Math.max(...longitudes)) / 2;
  const shift = Math.round(center / 360) * 360;
  return result.map(point => [point[0] - shift, ...point.slice(1)]);
}

function normalizeGeometryContinuity(geometry) {
  const polygons = polygonParts(geometry).map(polygon => polygon.map(normalizeRingContinuity));
  return geometry.type === 'Polygon'
    ? { ...geometry, coordinates: polygons[0] }
    : { ...geometry, coordinates: polygons };
}

function ringAreaKm2(ring) {
  const radius = 6371.0088;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const lon1 = ring[i][0] * Math.PI / 180;
    const lat1 = ring[i][1] * Math.PI / 180;
    const lon2 = ring[i + 1][0] * Math.PI / 180;
    const lat2 = ring[i + 1][1] * Math.PI / 180;
    let delta = lon2 - lon1;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    sum += delta * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs(sum * radius * radius / 2);
}

function geometryAreaKm2(geometry) {
  return polygonParts(geometry).reduce((total, polygon) => {
    const outer = ringAreaKm2(polygon[0]);
    const holes = polygon.slice(1).reduce((sum, ring) => sum + ringAreaKm2(ring), 0);
    return total + Math.max(0, outer - holes);
  }, 0);
}

async function nominatimLookup(osmId) {
  const url = `https://nominatim.openstreetmap.org/lookup?format=jsonv2&polygon_geojson=1&osm_ids=${osmId}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Dokodemo-Nauru-data-fix/1.0' } });
  if (!response.ok) throw new Error(`Nominatim ${response.status}: ${osmId}`);
  const entries = await response.json();
  if (!entries[0] || !entries[0].geojson) throw new Error(`Nominatim geometry missing: ${osmId}`);
  return entries[0].geojson;
}

async function main() {
  const attractionsFile = dataPath('attractions.geojson');
  const attractions = readJson(attractionsFile);
  const removedAttractionIds = new Set([
    'attraction-unesco-1246',
    'attraction-large-large-port-W605687568',
    'attraction-large-large-port-W842972655',
    'attraction-large-large-port-W1080136431'
  ]);
  attractions.features = attractions.features.filter(feature => !removedAttractionIds.has(feature.properties.id));
  attractions.generatedAt = new Date().toISOString();

  const ogasawara = attractions.features.find(feature => feature.properties.id === 'attraction-unesco-1362');
  if (!ogasawara) throw new Error('Ogasawara catalog entry not found');
  const representativeFiles = ['R5378191.geojson', 'R5378190.geojson', 'R12525921.geojson'];
  const representativePolygons = representativeFiles.flatMap(file => polygonParts(readJson(dataPath('natural-features', file)).geometry));
  Object.assign(ogasawara.properties, {
    name: '小笠原諸島（代表：父島・母島・聟島）',
    shortName: '小笠原諸島',
    statusLabel: 'UNESCO世界遺産 No.1362（代表輪郭）',
    osmType: 'composite',
    osmId: null,
    officialAreaKm2: null,
    areaSourceLabel: '代表輪郭から算出した概算',
    areaSourceUrl: 'https://www.env.go.jp/nature/isan/worldheritage/ogasawara/area/index.html',
    boundarySourceLabel: '© OpenStreetMap contributors（父島・母島・聟島）',
    boundarySourceUrl: 'https://www.openstreetmap.org/copyright'
  });
  writeJson(dataPath('attractions', 'unesco-1362.geojson'), {
    type: 'Feature',
    properties: { ...ogasawara.properties },
    geometry: { type: 'MultiPolygon', coordinates: representativePolygons }
  });
  writeJson(attractionsFile, attractions);

  const naturalFile = dataPath('natural-features.geojson');
  const natural = readJson(naturalFile);
  natural.features = natural.features.filter(feature => feature.properties.id !== 'water-wikipedia-W597309322');
  natural.generatedAt = new Date().toISOString();

  const minamitorishima = natural.features.find(feature => feature.properties.id === 'island-南鳥島');
  if (!minamitorishima) throw new Error('Minamitorishima catalog entry not found');
  const minamitorishimaGeometry = await nominatimLookup('W130970566');
  Object.assign(minamitorishima.properties, {
    osmType: 'way',
    osmId: 130970566,
    geometryFile: 'natural-features/W130970566.geojson',
    boundarySourceLabel: '© OpenStreetMap contributors',
    boundarySourceUrl: 'https://www.openstreetmap.org/copyright'
  });
  writeJson(dataPath('natural-features', 'W130970566.geojson'), {
    type: 'Feature', properties: { ...minamitorishima.properties }, geometry: minamitorishimaGeometry
  });

  const sakata = natural.features.find(feature => feature.properties.id === 'water-wikipedia-W262166812');
  if (!sakata) throw new Error('Sakata catalog entry not found');
  const formerUpperFile = dataPath('natural-features', 'W262166812.geojson');
  const compositeFile = dataPath('natural-features', 'sakata-upper-lower.geojson');
  const upper = fs.existsSync(formerUpperFile)
    ? readJson(formerUpperFile).geometry
    : { type: 'Polygon', coordinates: polygonParts(readJson(compositeFile).geometry)[0] };
  const lower = await nominatimLookup('W262166813');
  const sakataGeometry = { type: 'MultiPolygon', coordinates: [...polygonParts(upper), ...polygonParts(lower)] };
  Object.assign(sakata.properties, {
    aliases: ['さかた', '上潟', '下潟'],
    osmType: 'composite',
    osmId: null,
    officialAreaKm2: 0.436,
    areaSourceLabel: '新潟市「佐潟の概要」',
    areaSourceUrl: 'https://www.city.niigata.lg.jp/kurashi/kankyo/hozen/shizenfureai/sakata/',
    geometryFile: 'natural-features/sakata-upper-lower.geojson',
    boundarySourceLabel: '© OpenStreetMap contributors（上潟・下潟）',
    boundarySourceUrl: 'https://www.openstreetmap.org/copyright'
  });
  writeJson(compositeFile, {
    type: 'Feature', properties: { ...sakata.properties }, geometry: sakataGeometry
  });

  const lakeCorrections = {
    'water-wikipedia-W391840573': {
      officialAreaKm2: 0.05,
      areaSourceLabel: '北海道立総合研究機構「北海道の湖沼」',
      areaSourceUrl: 'https://www.hro.or.jp/lakes_in_hokkaido/n079_OYU.html'
    },
    'water-wikipedia-W943425241': {
      officialAreaKm2: null,
      areaSourceLabel: '境界データから算出した概算',
      areaSourceUrl: 'https://www.openstreetmap.org/way/943425241'
    },
    'water-wikipedia-W219619536': {
      officialAreaKm2: 0.083,
      areaSourceLabel: '蔵王町観光物産協会の公表寸法（直径325m）から概算',
      areaSourceUrl: 'https://www.zao-machi.com/sightseeing_spot/1.html'
    },
    'water-wikipedia-W91550845': {
      officialAreaKm2: null,
      areaSourceLabel: '境界データから算出した現況概算',
      areaSourceUrl: 'https://www.openstreetmap.org/way/91550845'
    },
    'water-wikipedia-W22592241': {
      officialAreaKm2: null,
      areaSourceLabel: '境界データから算出した現況概算',
      areaSourceUrl: 'https://www.openstreetmap.org/way/22592241'
    },
    'water-wikipedia-W439470889': {
      officialAreaKm2: null,
      areaSourceLabel: '境界データから算出した現況概算',
      areaSourceUrl: 'https://www.openstreetmap.org/way/439470889'
    },
    'water-wikipedia-W797503076': {
      officialAreaKm2: 0.058,
      areaSourceLabel: '山梨県衛生環境研究所「四尾連湖の概要」',
      areaSourceUrl: 'https://www.pref.yamanashi.jp/documents/98368/nenpou61sibirekosyokubutu9.pdf'
    },
    'water-wikipedia-R6382769': {
      officialAreaKm2: 0.248,
      areaSourceLabel: '多鯰ケ池の概要',
      areaSourceUrl: 'https://www.tanegaike.com/overview/'
    },
    'water-wikipedia-W436073909': {
      officialAreaKm2: null,
      areaSourceLabel: '境界データから算出した現況概算',
      areaSourceUrl: 'https://www.openstreetmap.org/way/436073909'
    }
  };
  for (const feature of natural.features) {
    const correction = lakeCorrections[feature.properties.id];
    if (!correction) continue;
    Object.assign(feature.properties, correction);
    const detailFile = dataPath(feature.properties.geometryFile);
    const detail = readJson(detailFile);
    Object.assign(detail.properties, correction);
    writeJson(detailFile, detail);
  }
  writeJson(naturalFile, natural);

  const countriesFile = dataPath('countries.geojson');
  const countries = readJson(countriesFile);
  countries.generatedAt = new Date().toISOString();
  const discontinuousCodes = new Set([
    'IRL', 'ATG', 'URY', 'GIN', 'COK', 'CIV', 'SLE', 'JAM', 'SUR', 'KNA',
    'LCA', 'DOM', 'DMA', 'TTO', 'PAN', 'BLZ', 'PER', 'MEX', 'MAR'
  ]);
  for (const feature of countries.features) {
    if (!discontinuousCodes.has(feature.properties.code)) continue;
    const geometryFile = dataPath(feature.properties.geometryFile);
    const detail = readJson(geometryFile);
    detail.geometry = normalizeGeometryContinuity(detail.geometry);
    detail.properties.calculatedAreaKm2 = Number(geometryAreaKm2(detail.geometry).toFixed(2));
    feature.properties.calculatedAreaKm2 = detail.properties.calculatedAreaKm2;
    writeJson(geometryFile, detail);
  }
  writeJson(countriesFile, countries);

  console.log(JSON.stringify({
    attractions: attractions.features.length,
    natural: natural.features.length,
    islands: natural.features.filter(feature => feature.properties.kind === 'island').length,
    waters: natural.features.filter(feature => feature.properties.kind === 'water').length,
    fixedCountries: discontinuousCodes.size
  }));
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
