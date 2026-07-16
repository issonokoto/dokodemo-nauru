const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'data', 'natural-features.geojson');
const geometryDir = path.join(root, 'data', 'natural-features');
const sourceUrl = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_lakes.geojson';
const sourceLabel = 'Natural Earth 1:10m Physical Vectors';
const sourcePage = 'https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-lakes/';

const lakes = [
  ['ヒューロン湖', 'カナダ・アメリカ合衆国', ['Lake Huron'], 'Lake Huron'],
  ['ミシガン湖', 'アメリカ合衆国', ['Lake Michigan'], 'Lake Michigan'],
  ['タンガニーカ湖', 'タンザニア・コンゴ民主共和国・ブルンジ・ザンビア', ['Lake Tanganyika'], 'Lake Tanganyika'],
  ['バイカル湖', 'ロシア', ['Lake Baikal'], 'Lake Baikal'],
  ['グレートベア湖', 'ノースウエスト準州・カナダ', ['Great Bear Lake'], 'Great Bear Lake'],
  ['マラウイ湖', 'マラウイ・モザンビーク・タンザニア', ['ニアサ湖', 'Lake Malawi', 'Lake Nyasa'], 'Lake Malawi'],
  ['グレートスレーブ湖', 'ノースウエスト準州・カナダ', ['Great Slave Lake'], 'Great Slave Lake'],
  ['エリー湖', 'カナダ・アメリカ合衆国', ['Lake Erie'], 'Lake Erie'],
  ['ウィニペグ湖', 'マニトバ州・カナダ', ['Lake Winnipeg'], 'Lake Winnipeg'],
  ['オンタリオ湖', 'カナダ・アメリカ合衆国', ['Lake Ontario'], 'Lake Ontario'],
  ['チチカカ湖', 'ペルー・ボリビア', ['Lake Titicaca'], 'Lago Titicaca'],
  ['ニカラグア湖', 'ニカラグア', ['コシボルカ湖', 'Lake Nicaragua', 'Lake Cocibolca'], 'Lago de Nicaragua'],
  ['チャド湖', 'チャド・カメルーン・ニジェール・ナイジェリア', ['Lake Chad'], 'Lake Chad'],
];

async function main() {
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Natural Earth ${response.status}`);
  const naturalEarth = await response.json();
  const sourceByName = new Map(naturalEarth.features.map(feature => [feature.properties.name, feature]));
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  catalog.source = 'OpenStreetMap contributors / Natural Earth';
  const existingIds = new Set(catalog.features.map(feature => feature.properties && feature.properties.id));

  let added = 0;
  for (const [name, context, aliases, naturalEarthName] of lakes) {
    const id = `water-global-${name}`;
    if (existingIds.has(id)) {
      console.log(`skip existing id: ${name}`);
      continue;
    }
    const source = sourceByName.get(naturalEarthName);
    if (!source) throw new Error(`Natural Earth feature not found: ${naturalEarthName}`);
    const neId = source.properties.ne_id;
    const fileName = `NE${neId}.geojson`;
    const properties = {
      id,
      kind: 'water',
      name,
      shortName: name,
      context,
      aliases,
      officialAreaKm2: null,
      boundarySourceLabel: sourceLabel,
      boundarySourceUrl: sourcePage,
      naturalEarthId: neId,
      wikidataId: source.properties.wikidataid || '',
      geometryFile: `natural-features/${fileName}`
    };
    const feature = { type: 'Feature', id, properties, geometry: source.geometry };
    fs.writeFileSync(path.join(geometryDir, fileName), `${JSON.stringify(feature)}\n`);
    catalog.features.push({ type: 'Feature', id, properties, geometry: null });
    existingIds.add(id);
    added += 1;
    console.log(`add water: ${name} <- ${naturalEarthName} (NE ${neId})`);
  }
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`);
  console.log(`done: ${added} added, ${catalog.features.length} total`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
