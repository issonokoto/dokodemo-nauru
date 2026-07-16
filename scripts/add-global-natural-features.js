const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'data', 'natural-features.geojson');
const geometryDir = path.join(root, 'data', 'natural-features');
const userAgent = 'DokodemoNauruDataBuilder/1.0 (data maintenance)';

const features = [
  // 世界最大級の島と、面積によらず広く知られている島。
  ['island', 'グリーンランド', 'グリーンランド・デンマーク王国', ['Greenland', 'Kalaallit Nunaat'], 'Greenland'],
  ['island', 'グレートブリテン島', 'イギリス', ['Great Britain', 'Britain'], 'Great Britain island United Kingdom'],
  ['island', 'バフィン島', 'ヌナブト準州・カナダ', ['Baffin Island'], 'Baffin Island Canada'],
  ['island', 'マダガスカル島', 'マダガスカル', ['Madagascar'], 'Madagascar'],
  ['island', 'ビクトリア島', 'カナダ', ['Victoria Island'], 'Victoria Island Canada', 'R5857216'],
  ['island', 'エルズミーア島', 'ヌナブト準州・カナダ', ['Ellesmere Island'], 'Ellesmere Island Canada'],
  ['island', 'ニューファンドランド島', 'ニューファンドランド・ラブラドール州・カナダ', ['Newfoundland'], 'Newfoundland Canada', 'R7168979'],
  ['island', '南島', 'ニュージーランド', ['ニュージーランド南島', 'South Island', 'Te Waipounamu'], 'South Island New Zealand'],
  ['island', '北島', 'ニュージーランド', ['ニュージーランド北島', 'North Island', 'Te Ika-a-Maui'], 'North Island New Zealand'],
  ['island', 'タスマニア島', 'タスマニア州・オーストラリア', ['Tasmania'], 'Tasmania island Australia'],
  ['island', 'スリランカ島', 'スリランカ', ['Sri Lanka', 'セイロン島', 'Ceylon'], 'Sri Lanka'],
  ['island', 'アイスランド島', 'アイスランド', ['Iceland'], 'Iceland'],
  ['island', 'アイルランド島', 'アイルランド・イギリス', ['Ireland'], 'Ireland', 'R7681896'],
  ['island', 'シチリア島', 'イタリア', ['Sicily', 'Sicilia'], 'Sicily island Italy'],
  ['island', 'サルデーニャ島', 'イタリア', ['サルディニア島', 'Sardinia', 'Sardegna'], 'Sardinia island Italy'],
  ['island', 'コルシカ島', 'フランス', ['Corsica', 'Corse'], 'Corsica island France'],
  ['island', 'クレタ島', 'ギリシャ', ['Crete', 'Kriti'], 'Crete island Greece'],
  ['island', 'キプロス島', 'キプロス', ['Cyprus'], 'Cyprus island'],
  ['island', 'マヨルカ島', 'バレアレス諸島・スペイン', ['マジョルカ島', 'Mallorca', 'Majorca'], 'Mallorca island Spain'],
  ['island', 'イビサ島', 'バレアレス諸島・スペイン', ['Ibiza', 'Eivissa'], 'Ibiza island Spain'],
  ['island', 'サントリーニ島', 'ギリシャ', ['ティーラ島', 'Santorini', 'Thira'], 'Santorini island Greece'],
  ['island', '済州島', '韓国', ['チェジュ島', 'Jeju Island'], 'Jeju Island South Korea'],
  ['island', 'モーリシャス島', 'モーリシャス', ['Mauritius'], 'Mauritius island'],
  ['island', 'タヒチ島', 'フランス領ポリネシア', ['Tahiti'], 'Tahiti island French Polynesia'],
  ['island', 'ボラボラ島', 'フランス領ポリネシア', ['Bora Bora'], 'Bora Bora island French Polynesia'],
  ['island', 'イースター島', 'チリ', ['ラパ・ヌイ', 'Easter Island', 'Rapa Nui'], 'Easter Island Chile'],
  ['island', 'マンハッタン島', 'ニューヨーク市・アメリカ合衆国', ['Manhattan Island', 'Manhattan'], 'Manhattan island New York'],
  ['island', 'アルカトラズ島', 'サンフランシスコ・アメリカ合衆国', ['Alcatraz Island', 'Alcatraz'], 'Alcatraz Island California'],

  // 世界最大級の湖と、観光・歴史・文化面で広く知られている小さな湖・池。
  ['water', 'カスピ海', 'ヨーロッパ・アジア', ['Caspian Sea'], 'Caspian Sea'],
  ['water', 'スペリオル湖', 'カナダ・アメリカ合衆国', ['Lake Superior'], 'Lake Superior'],
  ['water', 'ビクトリア湖', 'タンザニア・ウガンダ・ケニア', ['Lake Victoria', 'Victoria Nyanza'], 'Lake Victoria', 'R2606941'],
  ['water', 'ヒューロン湖', 'カナダ・アメリカ合衆国', ['Lake Huron'], 'Lake Huron', 'R1205151'],
  ['water', 'ミシガン湖', 'アメリカ合衆国', ['Lake Michigan'], 'Lake Michigan', 'R1205149'],
  ['water', 'タンガニーカ湖', 'タンザニア・コンゴ民主共和国・ブルンジ・ザンビア', ['Lake Tanganyika'], 'Lake Tanganyika', 'R1374224'],
  ['water', 'バイカル湖', 'ロシア', ['Lake Baikal'], 'Lake Baikal Russia', 'R555716'],
  ['water', 'グレートベア湖', 'ノースウエスト準州・カナダ', ['Great Bear Lake'], 'Great Bear Lake Canada', 'R2791372'],
  ['water', 'マラウイ湖', 'マラウイ・モザンビーク・タンザニア', ['ニアサ湖', 'Lake Malawi', 'Lake Nyasa'], 'Lake Malawi Africa'],
  ['water', 'グレートスレーブ湖', 'ノースウエスト準州・カナダ', ['Great Slave Lake'], 'Great Slave Lake Canada', 'R1834172'],
  ['water', 'エリー湖', 'カナダ・アメリカ合衆国', ['Lake Erie'], 'Lake Erie', 'R4039900'],
  ['water', 'ウィニペグ湖', 'マニトバ州・カナダ', ['Lake Winnipeg'], 'Lake Winnipeg Canada', 'R1259563'],
  ['water', 'オンタリオ湖', 'カナダ・アメリカ合衆国', ['Lake Ontario'], 'Lake Ontario', 'R1206310'],
  ['water', 'チチカカ湖', 'ペルー・ボリビア', ['Lake Titicaca'], 'Lake Titicaca'],
  ['water', 'ニカラグア湖', 'ニカラグア', ['コシボルカ湖', 'Lake Nicaragua', 'Lake Cocibolca'], 'Lake Nicaragua'],
  ['water', 'チャド湖', 'チャド・カメルーン・ニジェール・ナイジェリア', ['Lake Chad'], 'Lake Chad Africa'],
  ['water', '死海', 'ヨルダン・イスラエル・パレスチナ', ['Dead Sea'], 'Dead Sea'],
  ['water', 'グレートソルト湖', 'ユタ州・アメリカ合衆国', ['Great Salt Lake'], 'Great Salt Lake Utah'],
  ['water', 'レマン湖', 'スイス・フランス', ['ジュネーブ湖', 'Lake Geneva', 'Lac Leman'], 'Lake Geneva', 'R332617'],
  ['water', 'コモ湖', 'イタリア', ['Lake Como', 'Lago di Como'], 'Lake Como Italy'],
  ['water', 'ガルダ湖', 'イタリア', ['Lake Garda', 'Lago di Garda'], 'Lake Garda Italy'],
  ['water', 'ネス湖', 'スコットランド・イギリス', ['Loch Ness'], 'Loch Ness Scotland'],
  ['water', 'タホ湖', 'カリフォルニア州・ネバダ州・アメリカ合衆国', ['Lake Tahoe'], 'Lake Tahoe'],
  ['water', 'トバ湖', 'スマトラ島・インドネシア', ['Lake Toba', 'Danau Toba'], 'Lake Toba Indonesia'],
  ['water', 'ブレッド湖', 'スロベニア', ['Lake Bled', 'Blejsko jezero'], 'Lake Bled Slovenia'],
  ['water', 'ウォールデン池', 'マサチューセッツ州・アメリカ合衆国', ['Walden Pond'], 'Walden Pond Massachusetts'],
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function slug(kind, name) {
  return `${kind}-global-${name}`;
}

function geometryFileName(osmType, osmId) {
  const prefix = osmType === 'relation' ? 'R' : osmType === 'way' ? 'W' : 'N';
  return `${prefix}${osmId}.geojson`;
}

function hasPolygonGeometry(result) {
  return result && result.geojson && ['Polygon', 'MultiPolygon'].includes(result.geojson.type);
}

async function search(query, osmRef) {
  const params = new URLSearchParams({
    format: 'jsonv2',
    polygon_geojson: '1',
    polygon_threshold: '0.001'
  });
  if (osmRef) params.set('osm_ids', osmRef);
  else {
    params.set('q', query);
    params.set('limit', '5');
  }
  const endpoint = osmRef ? 'lookup' : 'search';
  let response;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    response = await fetch(`https://nominatim.openstreetmap.org/${endpoint}?${params}`, {
      headers: { 'User-Agent': userAgent, 'Accept-Language': 'en' }
    });
    if (response.ok) break;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 4) {
      throw new Error(`Nominatim ${response.status}: ${query}`);
    }
    await sleep(attempt * 2500);
  }
  const results = await response.json();
  const polygon = results.find(hasPolygonGeometry);
  if (!polygon) {
    const summary = results.map(item => `${item.osm_type}:${item.osm_id}:${item.type}`).join(', ');
    throw new Error(`Polygon not found: ${query} (${summary || 'no results'})`);
  }
  return polygon;
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const obsoleteOsm = new Set(['relation:10736687', 'way:1455268991', 'way:103900074']);
  catalog.features = catalog.features.filter(feature => {
    const p = feature.properties || {};
    return !obsoleteOsm.has(`${p.osmType}:${p.osmId}`);
  });
  for (const fileName of ['R10736687.geojson', 'W1455268991.geojson', 'W103900074.geojson']) {
    const obsoletePath = path.join(geometryDir, fileName);
    if (fs.existsSync(obsoletePath)) fs.rmSync(obsoletePath);
  }
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`);
  const existingIds = new Set(catalog.features.map(feature => feature.properties && feature.properties.id));
  const existingOsm = new Set(catalog.features.map(feature => {
    const p = feature.properties || {};
    return p.osmType && p.osmId ? `${p.osmType}:${p.osmId}` : '';
  }).filter(Boolean));

  let added = 0;
  for (const [kind, name, context, aliases, query, osmRef] of features) {
    const id = slug(kind, name);
    if (existingIds.has(id)) {
      console.log(`skip existing id: ${name}`);
      continue;
    }
    const result = await search(query, osmRef);
    const osmKey = `${result.osm_type}:${result.osm_id}`;
    if (existingOsm.has(osmKey)) {
      console.log(`skip duplicate OSM ${osmKey}: ${name}`);
      continue;
    }

    const fileName = geometryFileName(result.osm_type, result.osm_id);
    const properties = {
      id,
      kind,
      name,
      shortName: name,
      context,
      aliases,
      osmType: result.osm_type,
      osmId: result.osm_id,
      officialAreaKm2: null,
      geometryFile: `natural-features/${fileName}`
    };
    const feature = { type: 'Feature', id, properties, geometry: result.geojson };
    fs.writeFileSync(path.join(geometryDir, fileName), `${JSON.stringify(feature)}\n`);
    catalog.features.push({ type: 'Feature', id, properties, geometry: null });
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`);
    existingIds.add(id);
    existingOsm.add(osmKey);
    added += 1;
    console.log(`add ${kind}: ${name} <- ${result.display_name} (${osmKey}, ${result.geojson.type})`);
    await sleep(1100);
  }

  console.log(`done: ${added} added, ${catalog.features.length} total`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
