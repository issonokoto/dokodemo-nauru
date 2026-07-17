const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'data', 'attractions.geojson');
const geometryDir = path.join(root, 'data', 'attractions');
const osmCopyrightUrl = 'https://www.openstreetmap.org/copyright';

const attractions = [
  {
    osmType: 'way',
    osmId: 567598329,
    osmDate: '2025-09-01T00:00:00Z',
    name: '大阪・関西万博会場（2025年・来場者エリア）',
    shortName: '大阪・関西万博会場',
    context: '大阪府大阪市此花区・夢洲',
    subtype: 'event-site',
    subtypeLabel: 'イベント会場',
    statusLabel: '2025年開催時・来場者エリア',
    aliases: ['2025年日本国際博覧会', 'EXPO 2025', '大阪万博', '関西万博'],
    officialAreaKm2: null,
    areaSourceLabel: '',
    areaSourceUrl: ''
  },
  {
    osmType: 'relation',
    osmId: 18047883,
    osmDate: '2025-09-01T00:00:00Z',
    name: '大屋根リング',
    shortName: '大屋根リング',
    context: '大阪府大阪市此花区・夢洲',
    subtype: 'landmark',
    subtypeLabel: '建築物・ランドマーク',
    statusLabel: '2025年時点',
    aliases: ['Grand Ring', 'The Grand Ring', '万博リング'],
    officialAreaKm2: 0.06103555,
    areaSourceLabel: 'EXPO 2025大阪・関西万博公式Webサイト「大屋根リング」',
    areaSourceUrl: 'https://www.expo2025.or.jp/expo-map-index/main-facilities/grandring/'
  },
  {
    osmType: 'way',
    osmId: 539380188,
    name: '森とリスの遊園地 メルヘン村',
    shortName: 'メルヘン村',
    context: '佐賀県武雄市',
    subtype: 'theme-park',
    subtypeLabel: '遊園地・テーマパーク',
    statusLabel: '',
    aliases: ['武雄・嬉野メルヘン村', '武雄嬉野メルヘン村', 'めるへんむら'],
    officialAreaKm2: null,
    areaSourceLabel: '',
    areaSourceUrl: ''
  }
];

function samePoint(a, b) {
  return a && b && a[0] === b[0] && a[1] === b[1];
}

function memberCoordinates(member) {
  return Array.isArray(member.geometry) ? member.geometry.map(point => [point.lon, point.lat]) : [];
}

function stitchRings(members) {
  const segments = members.map(memberCoordinates).filter(coordinates => coordinates.length > 1);
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
    const ring = memberCoordinates(element);
    if (!samePoint(ring[0], ring[ring.length - 1])) ring.push(ring[0]);
    if (ring.length < 4) throw new Error(`Way ${element.id} is not an area`);
    return { type: 'Polygon', coordinates: [ring] };
  }
  const members = Array.isArray(element.members) ? element.members.filter(member => member.type === 'way') : [];
  const outerRings = stitchRings(members.filter(member => member.role !== 'inner'));
  const innerRings = stitchRings(members.filter(member => member.role === 'inner'));
  if (outerRings.length === 1) return { type: 'Polygon', coordinates: [outerRings[0], ...innerRings] };
  if (outerRings.length > 1) return { type: 'MultiPolygon', coordinates: outerRings.map(ring => [ring]) };
  throw new Error(`Relation ${element.id} has no polygon geometry`);
}

async function fetchElement(attraction) {
  if (!attraction.osmDate && attraction.osmType === 'way') {
    const response = await fetch(`https://api.openstreetmap.org/api/0.6/way/${attraction.osmId}/full.json`, {
      headers: { 'User-Agent': 'Dokodemo-Nauru attraction catalog maintenance (https://issonokoto.github.io/dokodemo-nauru/)' }
    });
    if (!response.ok) throw new Error(`OpenStreetMap API ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const nodes = new Map(data.elements.filter(element => element.type === 'node').map(node => [node.id, node]));
    const way = data.elements.find(element => element.type === 'way' && element.id === attraction.osmId);
    if (!way) throw new Error(`OSM way not found: ${attraction.osmId}`);
    way.geometry = way.nodes.map(nodeId => nodes.get(nodeId)).filter(Boolean);
    return way;
  }
  const date = attraction.osmDate ? `[date:"${attraction.osmDate}"]` : '';
  const query = `[out:json]${date}[timeout:120];${attraction.osmType}(${attraction.osmId});out body geom;`;
  const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let data = null;
  let lastError = null;
  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Dokodemo-Nauru attraction catalog maintenance (https://issonokoto.github.io/dokodemo-nauru/)'
      },
      body: new URLSearchParams({ data: query })
    });
    if (response.ok) {
      data = await response.json();
      break;
    }
    lastError = new Error(`Overpass ${response.status}: ${await response.text()}`);
  }
  if (!data) throw lastError || new Error('Overpass request failed');
  const element = data.elements.find(item => item.type === attraction.osmType && item.id === attraction.osmId);
  if (!element) throw new Error(`OSM element not found: ${attraction.osmType} ${attraction.osmId}`);
  return element;
}

async function main() {
  fs.mkdirSync(geometryDir, { recursive: true });
  const features = [];
  for (const attraction of attractions) {
    const prefix = attraction.osmType === 'relation' ? 'R' : 'W';
    const id = `attraction-${prefix}${attraction.osmId}`;
    const geometryFile = `attractions/${prefix}${attraction.osmId}.geojson`;
    const outputPath = path.join(root, 'data', geometryFile);
    const existing = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) : null;
    const geometry = existing && existing.geometry
      ? existing.geometry
      : geometryFromElement(await fetchElement(attraction));
    const boundaryDateNote = attraction.osmDate ? '（2025年9月1日時点）' : '';
    const properties = {
      id,
      kind: 'attraction',
      name: attraction.name,
      shortName: attraction.shortName,
      context: attraction.context,
      subtype: attraction.subtype,
      subtypeLabel: attraction.subtypeLabel,
      statusLabel: attraction.statusLabel,
      aliases: attraction.aliases,
      osmType: attraction.osmType,
      osmId: attraction.osmId,
      osmDate: attraction.osmDate || null,
      officialAreaKm2: attraction.officialAreaKm2,
      areaSourceLabel: attraction.areaSourceLabel,
      areaSourceUrl: attraction.areaSourceUrl,
      boundarySourceLabel: `© OpenStreetMap contributors${boundaryDateNote}`,
      boundarySourceUrl: osmCopyrightUrl,
      geometryFile
    };
    const feature = { type: 'Feature', id, properties, geometry };
    fs.writeFileSync(outputPath, `${JSON.stringify(feature)}\n`);
    features.push({ type: 'Feature', id, properties, geometry: null });
    console.log(`${attraction.name}: OSM ${attraction.osmType} ${attraction.osmId}`);
  }
  fs.writeFileSync(catalogPath, `${JSON.stringify({ type: 'FeatureCollection', features })}\n`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
