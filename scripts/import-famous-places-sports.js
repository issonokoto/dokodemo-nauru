const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'data', 'attractions.geojson');
const geometryDir = path.join(root, 'data', 'attractions');
const reportPath = path.join(__dirname, 'famous-places-sports-report.json');
const osmCopyrightUrl = 'https://www.openstreetmap.org/copyright';
const managedSubtypes = new Set([
  'funny-place', 'sports-baseball', 'sports-football', 'sports-rugby', 'sports-park', 'sports-arena'
]);

const entries = [
  // 日本語話者には意外な響きになる海外地名。漫湖は水域データに収録済み。
  { name: 'エロマンガ', context: 'オーストラリア・クイーンズランド州', subtype: 'funny-place', subtypeLabel: '海外の印象的な地名', statusLabel: '町', aliases: ['Eromanga'], queries: ['Eromanga, Queensland, Australia'] },
  { name: 'キンタマーニ', context: 'インドネシア・バリ島', subtype: 'funny-place', subtypeLabel: '海外の印象的な地名', statusLabel: '地区・高原', aliases: ['Kintamani', 'キンタマーニ高原'], queries: ['Kintamani, Bangli, Bali, Indonesia'] },
  { name: 'スケベニンゲン', context: 'オランダ・デン・ハーグ', subtype: 'funny-place', subtypeLabel: '海外の印象的な地名', statusLabel: '海岸地区', aliases: ['Scheveningen', 'スヘフェニンゲン'], queries: ['Scheveningen, Den Haag, Netherlands'] },
  { name: 'マンコス', context: 'アメリカ・コロラド州', subtype: 'funny-place', subtypeLabel: '海外の印象的な地名', statusLabel: '町', aliases: ['Mancos', 'Town of Mancos'], queries: ['Mancos, Colorado, USA'] },
  { name: 'ボイン川', context: 'アイルランド', subtype: 'funny-place', subtypeLabel: '海外の印象的な地名', statusLabel: '河川中心線から片側25mの暫定比較範囲', aliases: ['River Boyne', 'Boyne River'], queries: ['River Boyne, Ireland'], referenceBufferMeters: 25 },
  { name: 'パンティ山', context: 'マレーシア・ジョホール州', subtype: 'funny-place', subtypeLabel: '海外の印象的な地名', statusLabel: '山頂から半径1kmの暫定比較範囲', aliases: ['Gunung Panti', 'Mount Panti'], queries: ['Gunung Panti Johor Malaysia'], referenceBufferMeters: 1000 },
  { name: 'オナラスカ', context: 'アメリカ・ウィスコンシン州', subtype: 'funny-place', subtypeLabel: '海外の印象的な地名', statusLabel: '市', aliases: ['Onalaska', 'City of Onalaska'], queries: ['Onalaska, Wisconsin, USA'] },
  { name: 'マル・デ・アホ', context: 'アルゼンチン・ブエノスアイレス州', subtype: 'funny-place', subtypeLabel: '海外の印象的な地名', statusLabel: '海岸都市', aliases: ['Mar de Ajó', 'Mar de Ajo'], queries: ['Mar de Ajo, Buenos Aires, Argentina'] },

  // NPB 12球団本拠地（NPB公式の2026年一覧）。
  ...[
    ['エスコンフィールドHOKKAIDO', '北海道北広島市', ['ES CON FIELD HOKKAIDO', 'エスコンフィールド'], 'ES CON FIELD HOKKAIDO, Kitahiroshima, Japan'],
    ['楽天モバイル 最強パーク宮城', '宮城県仙台市', ['宮城球場', '楽天モバイルパーク宮城'], '楽天モバイル 最強パーク宮城', 'way', 663912122],
    ['ベルーナドーム', '埼玉県所沢市', ['西武ドーム', 'メットライフドーム'], 'ベルーナドーム, Tokorozawa, Japan'],
    ['東京ドーム', '東京都文京区', ['TOKYO DOME'], '東京ドーム, Tokyo, Japan'],
    ['明治神宮野球場', '東京都新宿区', ['神宮球場'], '明治神宮野球場, Tokyo, Japan'],
    ['ZOZOマリンスタジアム', '千葉県千葉市', ['千葉マリンスタジアム'], 'ZOZOマリンスタジアム, Chiba, Japan'],
    ['横浜スタジアム', '神奈川県横浜市', ['ハマスタ'], '横浜スタジアム, Yokohama, Japan'],
    ['バンテリンドーム ナゴヤ', '愛知県名古屋市', ['ナゴヤドーム'], 'バンテリンドーム ナゴヤ, Nagoya, Japan'],
    ['京セラドーム大阪', '大阪府大阪市', ['大阪ドーム'], '京セラドーム大阪, Osaka, Japan'],
    ['阪神甲子園球場', '兵庫県西宮市', ['甲子園球場'], '阪神甲子園球場, Nishinomiya, Japan'],
    ['MAZDA Zoom-Zoom スタジアム広島', '広島県広島市', ['マツダスタジアム', '広島市民球場'], 'MAZDA Zoom-Zoom スタジアム広島, Hiroshima, Japan'],
    ['みずほPayPayドーム福岡', '福岡県福岡市', ['福岡ドーム', 'PayPayドーム'], 'Fukuoka Dome', 'way', 28445837]
  ].map(([name, context, aliases, query, osmType, osmId]) => ({ name, context, subtype: 'sports-baseball', subtypeLabel: '野球場・NPB本拠地', statusLabel: 'NPB 12球団本拠地（2026年）', aliases, queries: [query], osmType, osmId })),

  // 地方開催・準本拠地・歴史的本拠地として著名な野球場。
  ...[
    ['ほっともっとフィールド神戸', '兵庫県神戸市', ['グリーンスタジアム神戸', '神戸総合運動公園野球場'], 'ほっともっとフィールド神戸, Kobe, Japan'],
    ['大和ハウス プレミストドーム', '北海道札幌市', ['札幌ドーム'], '大和ハウス プレミストドーム', 'way', 127094824],
    ['HARD OFF ECOスタジアム新潟', '新潟県新潟市', ['新潟県立野球場'], 'HARD OFF ECOスタジアム新潟, Japan'],
    ['静岡県草薙総合運動場硬式野球場', '静岡県静岡市', ['草薙球場'], '静岡県草薙総合運動場', 'way', 701143779],
    ['ひなたサンマリンスタジアム宮崎', '宮崎県宮崎市', ['サンマリンスタジアム宮崎'], 'サンマリンスタジアム宮崎, Miyazaki, Japan'],
    ['沖縄セルラースタジアム那覇', '沖縄県那覇市', ['沖縄県営奥武山野球場'], '沖縄セルラースタジアム那覇, Japan'],
    ['倉敷マスカットスタジアム', '岡山県倉敷市', ['マスカットスタジアム'], 'Muscat Stadium Kurashiki', 'relation', 9469160],
    ['坊っちゃんスタジアム', '愛媛県松山市', ['松山中央公園野球場'], 'Botchan Stadium', 'way', 109501413],
    ['長野オリンピックスタジアム', '長野県長野市', ['南長野運動公園野球場'], '長野オリンピックスタジアム, Japan'],
    ['こまちスタジアム', '秋田県秋田市', ['秋田県立野球場'], 'こまちスタジアム, Akita, Japan'],
    ['きたぎんボールパーク', '岩手県盛岡市', ['いわて盛岡ボールパーク'], 'きたぎんボールパーク, Morioka, Japan'],
    ['荘内銀行・日新製薬スタジアムやまがた', '山形県中山町', ['山形県野球場', 'きらやかスタジアム'], '山形県野球場, Nakayama, Yamagata, Japan'],
    ['福島県営あづま球場', '福島県福島市', ['あづま球場'], 'Azuma Baseball Stadium Fukushima', 'way', 967258955],
    ['宇都宮清原球場', '栃木県宇都宮市', ['清原球場'], '宇都宮清原球場, Japan']
  ].map(([name, context, aliases, query, osmType, osmId]) => ({ name, context, subtype: 'sports-baseball', subtypeLabel: '野球場・地方開催等', statusLabel: name.includes('草薙') ? 'NPB地方開催球場／草薙総合運動場の敷地境界' : 'NPB地方開催・準本拠地級の著名球場', aliases, queries: [query], osmType, osmId })),

  // Jリーグ・日本代表戦・国際大会で著名なサッカースタジアム。
  ...[
    ['茨城県立カシマサッカースタジアム', '茨城県鹿嶋市', ['カシマスタジアム'], 'カシマサッカースタジアム, Japan'],
    ['埼玉スタジアム2002', '埼玉県さいたま市', ['埼玉スタジアム'], '埼玉スタジアム2002, Japan'],
    ['フクダ電子アリーナ', '千葉県千葉市', ['千葉市蘇我球技場'], 'フクダ電子アリーナ, Chiba, Japan'],
    ['味の素スタジアム', '東京都調布市', ['東京スタジアム'], '味の素スタジアム, Tokyo, Japan'],
    ['日産スタジアム', '神奈川県横浜市', ['横浜国際総合競技場'], '日産スタジアム, Yokohama, Japan'],
    ['ニッパツ三ツ沢球技場', '神奈川県横浜市', ['三ツ沢公園球技場', 'NHKスプリング三ツ沢球技場'], 'ニッパツ三ツ沢球技場, Yokohama, Japan'],
    ['IAIスタジアム日本平', '静岡県静岡市', ['日本平スタジアム'], 'IAIスタジアム日本平, Japan'],
    ['豊田スタジアム', '愛知県豊田市', ['TOYOTA STADIUM'], '豊田スタジアム, Japan'],
    ['パナソニック スタジアム 吹田', '大阪府吹田市', ['市立吹田サッカースタジアム'], 'パナソニック スタジアム 吹田', 'way', 685986996],
    ['エディオンピースウイング広島', '広島県広島市', ['広島サッカースタジアム'], 'エディオンピースウイング広島, Japan'],
    ['国立競技場', '東京都新宿区', ['日本国立競技場', 'Japan National Stadium'], '国立競技場, Tokyo, Japan'],
    ['ノエビアスタジアム神戸', '兵庫県神戸市', ['神戸ウイングスタジアム'], 'ノエビアスタジアム神戸, Japan'],
    ['デンカビッグスワンスタジアム', '新潟県新潟市', ['新潟スタジアム'], 'デンカビッグスワンスタジアム, Japan'],
    ['キューアンドエースタジアムみやぎ', '宮城県利府町', ['宮城スタジアム'], 'Miyagi Stadium Rifu', 'way', 103894920],
    ['静岡スタジアム エコパ', '静岡県袋井市', ['エコパスタジアム'], 'Shizuoka Stadium Ecopa', 'way', 175920589],
    ['クラサスドーム大分', '大分県大分市', ['大分スポーツ公園総合競技場', '大分銀行ドーム'], '大分スポーツ公園総合競技場, Japan'],
    ['サンガスタジアム by KYOCERA', '京都府亀岡市', ['京都スタジアム'], 'サンガスタジアム, Kameoka, Japan'],
    ['ベスト電器スタジアム', '福岡県福岡市', ['博多の森球技場', 'レベルファイブスタジアム'], 'ベスト電器スタジアム, Fukuoka, Japan'],
    ['駅前不動産スタジアム', '佐賀県鳥栖市', ['鳥栖スタジアム'], 'Tosu Stadium', 'way', 243123619],
    ['Uvanceとどろきスタジアム by Fujitsu', '神奈川県川崎市', ['等々力陸上競技場'], 'Todoroki Athletics Stadium', 'way', 87377060],
    ['NACK5スタジアム大宮', '埼玉県さいたま市', ['大宮公園サッカー場'], 'NACK5スタジアム大宮, Japan'],
    ['三協フロンテア柏スタジアム', '千葉県柏市', ['日立柏サッカー場'], 'Hitachi Kashiwa Soccer Stadium', 'way', 463900052]
  ].map(([name, context, aliases, query, osmType, osmId]) => ({ name, context, subtype: 'sports-football', subtypeLabel: 'サッカー場・大規模競技場', statusLabel: ['駅前不動産スタジアム', 'Uvanceとどろきスタジアム by Fujitsu'].includes(name) ? 'Jリーグ著名会場／競技フィールド境界' : 'Jリーグ・日本代表戦等の著名会場', aliases, queries: [query], osmType, osmId })),

  ...[
    ['東大阪市花園ラグビー場', '大阪府東大阪市', ['花園ラグビー場'], '花園ラグビー場, Higashiosaka, Japan'],
    ['花園中央公園', '大阪府東大阪市', ['花園ラグビー場公園'], '花園中央公園, Higashiosaka, Japan'],
    ['秩父宮ラグビー場', '東京都港区', ['秩父宮'], '秩父宮ラグビー場, Tokyo, Japan'],
    ['熊谷ラグビー場', '埼玉県熊谷市', ['熊谷スポーツ文化公園ラグビー場'], '熊谷ラグビー場, Japan'],
    ['熊谷スポーツ文化公園', '埼玉県熊谷市', ['熊谷ラグビー場公園'], '熊谷スポーツ文化公園, Japan']
  ].map(([name, context, aliases, query], index) => ({ name, context, subtype: index === 1 || index === 4 ? 'sports-park' : 'sports-rugby', subtypeLabel: index === 1 || index === 4 ? '大規模スポーツ公園' : 'ラグビー場', statusLabel: 'ラグビーの主要会場', aliases, queries: [query] })),

  ...[
    ['日本武道館', '東京都千代田区', ['Nippon Budokan'], '日本武道館, Tokyo, Japan'],
    ['国立代々木競技場 第一体育館', '東京都渋谷区', ['代々木第一体育館'], 'Yoyogi National Gymnasium', 'way', 1452614349],
    ['東京体育館', '東京都渋谷区', ['Tokyo Metropolitan Gymnasium'], '東京体育館, Japan'],
    ['有明アリーナ', '東京都江東区', ['Ariake Arena'], '有明アリーナ, Tokyo, Japan'],
    ['さいたまスーパーアリーナ', '埼玉県さいたま市', ['Saitama Super Arena'], 'さいたまスーパーアリーナ, Japan'],
    ['横浜アリーナ', '神奈川県横浜市', ['Yokohama Arena'], '横浜アリーナ, Japan'],
    ['大阪城ホール', '大阪府大阪市', ['Osaka-jō Hall'], 'Osaka-jo Hall', 'way', 176303041],
    ['Asueアリーナ大阪', '大阪府大阪市', ['大阪市中央体育館', '丸善インテックアリーナ大阪'], 'Asueアリーナ大阪, Japan'],
    ['IGアリーナ', '愛知県名古屋市', ['愛知国際アリーナ', '愛知県新体育館'], 'IGアリーナ, Nagoya, Japan'],
    ['マリンメッセ福岡A館', '福岡県福岡市', ['マリンメッセ福岡'], 'マリンメッセ福岡, Japan'],
    ['沖縄アリーナ', '沖縄県沖縄市', ['Okinawa Arena'], '沖縄アリーナ, Japan'],
    ['両国国技館', '東京都墨田区', ['国技館'], '両国国技館, Tokyo, Japan']
  ].map(([name, context, aliases, query, osmType, osmId]) => ({ name, context, subtype: 'sports-arena', subtypeLabel: '武道館・大規模アリーナ', statusLabel: '大規模スポーツ・競技会場', aliases, queries: [query], osmType, osmId }))
];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function isAreaGeometry(geometry) {
  return geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon');
}

function circleGeometry(lon, lat, radiusMeters, steps = 72) {
  const ring = [];
  const latScale = 1 / 111320;
  const lonScale = 1 / (111320 * Math.cos(lat * Math.PI / 180));
  for (let index = 0; index <= steps; index += 1) {
    const angle = index / steps * Math.PI * 2;
    ring.push([lon + Math.cos(angle) * radiusMeters * lonScale, lat + Math.sin(angle) * radiusMeters * latScale]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

function lineBufferGeometry(geometry, radiusMeters) {
  const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
  const polygons = [];
  for (const line of lines) {
    for (let index = 0; index < line.length - 1; index += 1) {
      const a = line[index];
      const b = line[index + 1];
      const midLat = (a[1] + b[1]) / 2 * Math.PI / 180;
      const dx = (b[0] - a[0]) * 111320 * Math.cos(midLat);
      const dy = (b[1] - a[1]) * 111320;
      const length = Math.hypot(dx, dy);
      if (!length) continue;
      const ox = -dy / length * radiusMeters / (111320 * Math.cos(midLat));
      const oy = dx / length * radiusMeters / 111320;
      polygons.push([[a[0] + ox, a[1] + oy], [b[0] + ox, b[1] + oy], [b[0] - ox, b[1] - oy], [a[0] - ox, a[1] - oy], [a[0] + ox, a[1] + oy]]);
    }
  }
  return { type: 'MultiPolygon', coordinates: polygons.map(ring => [ring]) };
}

function referenceAreaGeometry(geometry, radiusMeters) {
  if (!geometry) return null;
  if (geometry.type === 'Point') return circleGeometry(geometry.coordinates[0], geometry.coordinates[1], radiusMeters);
  if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') return lineBufferGeometry(geometry, radiusMeters);
  return geometry;
}

async function searchNominatim(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('polygon_geojson', '1');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '8');
  url.searchParams.set('q', query);
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Dokodemo-Nauru/1.0 (famous places and sports catalog; https://issonokoto.github.io/dokodemo-nauru/)' },
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) throw new Error(`Nominatim ${response.status}: ${await response.text()}`);
  return response.json();
}

async function lookupNominatim(osmType, osmId) {
  const prefix = osmType === 'relation' ? 'R' : osmType === 'way' ? 'W' : 'N';
  const url = new URL('https://nominatim.openstreetmap.org/lookup');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('polygon_geojson', '1');
  url.searchParams.set('osm_ids', `${prefix}${osmId}`);
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Dokodemo-Nauru/1.0 (famous places and sports catalog; https://issonokoto.github.io/dokodemo-nauru/)' },
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) throw new Error(`Nominatim ${response.status}: ${await response.text()}`);
  const results = await response.json();
  return results[0] || null;
}

async function resolveEntry(entry, existingByName) {
  const existing = existingByName.get(entry.name);
  if (existing && existing.properties && existing.properties.geometryFile) {
    const filePath = path.join(root, 'data', existing.properties.geometryFile);
    if (fs.existsSync(filePath)) {
      const feature = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (isAreaGeometry(feature.geometry)) return { query: 'existing', result: { ...existing.properties, osm_type: existing.properties.osmType, osm_id: existing.properties.osmId, geojson: feature.geometry, display_name: entry.name } };
    }
  }
  if (entry.osmType && entry.osmId) {
    const result = await lookupNominatim(entry.osmType, entry.osmId);
    if (result && isAreaGeometry(result.geojson)) return { query: `lookup:${entry.osmType}/${entry.osmId}`, result };
  }
  for (const query of entry.queries) {
    const results = await searchNominatim(query);
    const match = results.find(result => isAreaGeometry(result.geojson)) || (entry.referenceBufferMeters ? results.find(result => result.geojson) : null);
    if (match) {
      if (entry.referenceBufferMeters && !isAreaGeometry(match.geojson)) {
        match.geojson = referenceAreaGeometry(match.geojson, entry.referenceBufferMeters);
      }
      if (isAreaGeometry(match.geojson)) return { query, result: match };
    }
    await sleep(1100);
  }
  return null;
}

function osmPrefix(type) {
  return type === 'relation' ? 'R' : type === 'way' ? 'W' : 'N';
}

async function main() {
  fs.mkdirSync(geometryDir, { recursive: true });
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const existingByName = new Map((catalog.features || []).filter(feature => feature.properties).map(feature => [feature.properties.name, feature]));
  const preserved = (catalog.features || []).filter(feature => !managedSubtypes.has(feature.properties && feature.properties.subtype));
  const imported = [];
  const report = { generatedAt: new Date().toISOString(), imported: [], unresolved: [] };

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    process.stdout.write(`[${index + 1}/${entries.length}] ${entry.name}: `);
    let resolved = null;
    try {
      resolved = await resolveEntry(entry, existingByName);
    } catch (error) {
      report.unresolved.push({ name: entry.name, queries: entry.queries, error: error.message });
      console.log(`ERROR ${error.message}`);
      await sleep(1100);
      continue;
    }
    if (!resolved) {
      report.unresolved.push({ name: entry.name, queries: entry.queries, error: '面の境界を取得できませんでした' });
      console.log('UNRESOLVED');
      await sleep(1100);
      continue;
    }

    const source = resolved.result;
    const prefix = osmPrefix(source.osm_type);
    const id = `attraction-${prefix}${source.osm_id}`;
    const geometryFile = `attractions/${prefix}${source.osm_id}.geojson`;
    const properties = {
      id,
      kind: 'attraction',
      name: entry.name,
      shortName: entry.name,
      context: entry.context,
      subtype: entry.subtype,
      subtypeLabel: entry.subtypeLabel,
      statusLabel: entry.statusLabel,
      aliases: entry.aliases || [],
      osmType: source.osm_type,
      osmId: Number(source.osm_id),
      osmDate: null,
      officialAreaKm2: null,
      areaSourceLabel: '',
      areaSourceUrl: '',
      boundarySourceLabel: entry.referenceBufferMeters ? '© OpenStreetMap contributors（中心線・代表点から作成した暫定比較範囲）' : '© OpenStreetMap contributors',
      boundarySourceUrl: osmCopyrightUrl,
      geometryFile
    };
    const fullFeature = { type: 'Feature', id, properties, geometry: source.geojson };
    fs.writeFileSync(path.join(root, 'data', geometryFile), `${JSON.stringify(fullFeature)}\n`);
    imported.push({ type: 'Feature', id, properties, geometry: null });
    report.imported.push({ name: entry.name, query: resolved.query, osmType: source.osm_type, osmId: Number(source.osm_id), displayName: source.display_name, geometryType: source.geojson.type });
    console.log(`${source.osm_type} ${source.osm_id}`);
    await sleep(1100);
  }

  const deduped = new Map();
  for (const feature of [...preserved, ...imported]) deduped.set(feature.properties.id, feature);
  catalog.features = [...deduped.values()];
  catalog.generatedAt = new Date().toISOString();
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Imported ${imported.length}; unresolved ${report.unresolved.length}; catalog ${catalog.features.length}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
