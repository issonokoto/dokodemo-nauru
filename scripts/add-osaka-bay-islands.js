const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'data', 'natural-features.geojson');
const geometryDir = path.join(root, 'data', 'natural-features');
const boundarySourceLabel = '© OpenStreetMap contributors';
const boundarySourceUrl = 'https://www.openstreetmap.org/copyright';

const islands = [
  {
    name: '夢洲',
    context: '大阪府大阪市此花区',
    aliases: ['ゆめしま', 'Yumeshima', '夢州'],
    officialAreaKm2: 3.9,
    areaSourceLabel: '大阪市「夢洲の概要」',
    areaSourceUrl: 'https://www.city.osaka.lg.jp/kensetsu/cmsfiles/contents/0000506/506669/200612_07_siryou3_1.pdf'
  },
  {
    name: '咲洲',
    context: '大阪府大阪市住之江区',
    aliases: ['さきしま', 'Sakishima', '咲州'],
    officialAreaKm2: null,
    areaSourceLabel: '',
    areaSourceUrl: ''
  },
  {
    name: '舞洲',
    context: '大阪府大阪市此花区',
    aliases: ['まいしま', 'Maishima', '舞州'],
    officialAreaKm2: 2.2,
    areaSourceLabel: '大阪市「舞洲地区のまちづくり」',
    areaSourceUrl: 'https://www.city.osaka.lg.jp/port/page/0000015062.html'
  }
];

function closedCoordinates(element) {
  if (element.type !== 'way' || !Array.isArray(element.geometry)) return null;
  const coordinates = element.geometry.map(point => [point.lon, point.lat]);
  if (coordinates.length < 4) return null;
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coordinates.push(first);
  return coordinates;
}

async function main() {
  const names = islands.map(island => island.name).join('|');
  const query = `[out:json][timeout:90];
(
  nwr["place"="island"]["name"~"^(${names})$"];
  nwr["place"="island"]["name:ja"~"^(${names})$"];
);
out body geom;`;
  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Dokodemo-Nauru island catalog maintenance (https://issonokoto.github.io/dokodemo-nauru/)'
    },
    body: new URLSearchParams({ data: query })
  });
  if (!response.ok) throw new Error(`Overpass ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

  for (const island of islands) {
    const matches = data.elements.filter(element => {
      const tags = element.tags || {};
      return tags.name === island.name || tags['name:ja'] === island.name;
    });
    const element = matches.find(candidate => closedCoordinates(candidate));
    if (!element) throw new Error(`Closed OSM coastline not found: ${island.name}`);
    const coordinates = closedCoordinates(element);
    const osmPrefix = element.type === 'relation' ? 'R' : element.type === 'way' ? 'W' : 'N';
    const id = `island-${osmPrefix}${element.id}`;
    const geometryFile = `natural-features/${osmPrefix}${element.id}.geojson`;
    const properties = {
      id,
      kind: 'island',
      name: island.name,
      shortName: island.name,
      context: island.context,
      aliases: island.aliases,
      osmType: element.type,
      osmId: element.id,
      officialAreaKm2: island.officialAreaKm2,
      areaSourceLabel: island.areaSourceLabel,
      areaSourceUrl: island.areaSourceUrl,
      boundarySourceLabel,
      boundarySourceUrl,
      geometryFile
    };
    const feature = { type: 'Feature', id, properties, geometry: { type: 'Polygon', coordinates: [coordinates] } };
    const existingIndex = catalog.features.findIndex(item => item.properties && item.properties.name === island.name);
    if (existingIndex >= 0) catalog.features[existingIndex] = { type: 'Feature', id, properties, geometry: null };
    else catalog.features.push({ type: 'Feature', id, properties, geometry: null });
    fs.writeFileSync(path.join(geometryDir, path.basename(geometryFile)), `${JSON.stringify(feature)}\n`);
    console.log(`${island.name}: OSM ${element.type} ${element.id}, ${coordinates.length} points`);
  }

  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
