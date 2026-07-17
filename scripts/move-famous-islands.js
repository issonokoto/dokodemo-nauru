const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const attractionsPath = path.join(root, 'data', 'attractions.geojson');
const naturalPath = path.join(root, 'data', 'natural-features.geojson');
const attractionGeometryDir = path.join(root, 'data', 'attractions');
const naturalGeometryDir = path.join(root, 'data', 'natural-features');

const islands = new Map([
  ['エロマンガ島', { boundaryNote: '', aliases: ['Erromango', 'エロマンゴ島', 'イロマンゴ島'] }],
  ['クサイ島', { boundaryNote: '', aliases: ['Kosrae', 'Kusaie', 'コスラエ島'] }],
  ['チンコティーグ島', { boundaryNote: '（島上のチンコティーグ町域境界）', aliases: ['Chincoteague Island', 'シンコティーグ島'] }]
]);

const attractions = JSON.parse(fs.readFileSync(attractionsPath, 'utf8'));
const natural = JSON.parse(fs.readFileSync(naturalPath, 'utf8'));

for (const [name, island] of islands) {
  const attractionSource = attractions.features.find(feature => feature.properties.name === name);
  const naturalSource = natural.features.find(feature => feature.properties.name === name);
  const source = attractionSource || naturalSource;
  if (!source) throw new Error(`${name} がどちらのカタログにも見つかりません`);

  const sourceFile = path.join(root, 'data', source.properties.geometryFile);
  const geometry = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  const geometryName = path.basename(sourceFile);
  const naturalFeature = {
    type: 'Feature',
    id: `island-${source.properties.osmType === 'relation' ? 'R' : 'W'}${source.properties.osmId}`,
    properties: {
      id: `island-${source.properties.osmType === 'relation' ? 'R' : 'W'}${source.properties.osmId}`,
      kind: 'island',
      name,
      shortName: name,
      context: source.properties.context,
      aliases: island.aliases,
      osmType: source.properties.osmType,
      osmId: source.properties.osmId,
      officialAreaKm2: null,
      areaSourceLabel: '',
      areaSourceUrl: '',
      boundarySourceLabel: `© OpenStreetMap contributors${island.boundaryNote}`,
      boundarySourceUrl: 'https://www.openstreetmap.org/copyright',
      geometryFile: `natural-features/${geometryName}`
    },
    geometry: null
  };

  natural.features = natural.features.filter(feature => feature.properties.name !== name);
  natural.features.push(naturalFeature);
  geometry.properties = naturalFeature.properties;
  geometry.id = naturalFeature.id;
  fs.writeFileSync(path.join(naturalGeometryDir, geometryName), JSON.stringify(geometry));
  if (attractionSource) fs.unlinkSync(sourceFile);
}

attractions.features = attractions.features.filter(feature => !islands.has(feature.properties.name));
attractions.generatedAt = new Date().toISOString();
natural.generatedAt = new Date().toISOString();
fs.writeFileSync(attractionsPath, JSON.stringify(attractions));
fs.writeFileSync(naturalPath, JSON.stringify(natural));

console.log(`観光地・施設: ${attractions.features.length}件`);
console.log(`島・湖: ${natural.features.length}件（島 ${natural.features.filter(feature => feature.properties.kind === 'island').length}件）`);
