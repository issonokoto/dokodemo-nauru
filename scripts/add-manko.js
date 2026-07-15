import fs from 'node:fs';

const catalogPath = 'data/natural-features.geojson';
const geometryPath = 'data/natural-features/W541590471.geojson';
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
if (catalog.features.some(feature => feature.properties.name === '漫湖')) {
  console.log('漫湖 already exists');
  process.exit(0);
}

const response = await fetch('https://nominatim.openstreetmap.org/lookup?format=geojson&osm_ids=W541590471&polygon_geojson=1', {
  headers: { 'User-Agent': 'Dokodemo-Nauru/1.0 (lake catalog)' }
});
if (!response.ok) throw new Error(`Nominatim ${response.status}`);
const collection = await response.json();
const source = collection.features && collection.features[0];
if (!source || !source.geometry) throw new Error('漫湖の輪郭を取得できませんでした');

const id = 'water-W541590471';
const properties = {
  id,
  kind: 'water',
  name: '漫湖',
  shortName: '漫湖',
  context: '沖縄県',
  aliases: ['まんこ', '漫湖公園'],
  osmType: 'way',
  osmId: 541590471,
  officialAreaKm2: null,
  areaSourceLabel: 'Wikipedia「日本の湖沼一覧」',
  areaSourceUrl: 'https://ja.wikipedia.org/wiki/日本の湖沼一覧',
  geometryFile: 'natural-features/W541590471.geojson'
};
const feature = { type: 'Feature', id, properties, geometry: null };
const geometryFeature = { type: 'Feature', id, properties, geometry: source.geometry };
fs.writeFileSync(geometryPath, `${JSON.stringify(geometryFeature)}\n`);
catalog.features.unshift(feature);
catalog.generatedAt = new Date().toISOString();
fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`);
console.log(JSON.stringify({ name: properties.name, points: JSON.stringify(source.geometry).length, total: catalog.features.length }));
