const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'data', 'attractions.geojson');
const geometryDir = path.join(root, 'data', 'attractions');
const cachePath = path.join(root, '.world-heritage-nominatim-cache.json');

// 日本の世界遺産のうち、構成資産の自動抽出だけでは代表名称で検索できない物件。
const missingSites = [
  { id: 775, name: '原爆ドーム', context: '広島県広島市中区', query: '原爆ドーム, 広島市', aliases: ['広島平和記念碑', '広島平和記念公園', 'Hiroshima Peace Memorial', 'Genbaku Dome'], area: 0.004 },
  { id: 661, name: '姫路城', context: '兵庫県姫路市・姫路公園', query: ['姫路公園, 姫路市', '姫路城, 姫路市'], cacheKey: '661-park', aliases: ['白鷺城', '姫路公園', 'Himeji-jo'], area: 1.07 },
  { id: 734, name: '白川郷・五箇山の合掌造り集落', context: '岐阜県・富山県', query: ['荻町, 白川村', '白川郷, 岐阜県', '白川村, 岐阜県'], aliases: ['白川郷', '五箇山', '荻町', 'Historic Villages of Shirakawa-go and Gokayama'] },
  { id: 776, name: '厳島神社', context: '広島県廿日市市宮島町', query: '厳島神社, 廿日市市', aliases: ['宮島', 'Itsukushima Shinto Shrine'] },
  { id: 972, name: '琉球王国のグスク及び関連遺産群', context: '沖縄県', query: ['首里城公園, 那覇市', '今帰仁城, 沖縄県'], aliases: ['首里城', 'グスク', '今帰仁城', 'Gusuku Sites and Related Properties of the Kingdom of Ryukyu'] },
  { id: 1246, name: '石見銀山遺跡とその文化的景観', context: '島根県大田市', query: '石見銀山, 大田市', aliases: ['石見銀山', 'Iwami Ginzan Silver Mine and its Cultural Landscape'] },
  { id: 1362, name: '小笠原諸島', context: '東京都小笠原村', query: '小笠原諸島, 東京都', aliases: ['Bonin Islands'] },
  { id: 1418, name: '富士山－信仰の対象と芸術の源泉', context: '山梨県・静岡県', geometryFileSource: 'attractions/large-world-heritage-R9442691.geojson', osmType: 'relation', osmId: 9442691, aliases: ['富士山', '富士山域', '富士山世界遺産', 'Fujisan', 'Mount Fuji', 'Fujisan, sacred place and source of artistic inspiration'], area: 207.021 },
  { id: 1484, name: '明治日本の産業革命遺産', context: '九州・山口ほか', query: '端島, 長崎県', aliases: ['軍艦島', '端島', "Sites of Japan's Meiji Industrial Revolution"] },
  { id: 1321, name: '国立西洋美術館', context: '東京都台東区上野公園', query: '国立西洋美術館, 台東区', aliases: ['ル・コルビュジエの建築作品', 'The Architectural Work of Le Corbusier'] },
  { id: 1535, name: '「神宿る島」宗像・沖ノ島と関連遺産群', context: '福岡県宗像市', query: '宗像大社辺津宮, 宗像市', aliases: ['宗像大社', '沖ノ島', 'Sacred Island of Okinoshima'] },
  { id: 1495, name: '長崎と天草地方の潜伏キリシタン関連遺産', context: '長崎県・熊本県', query: '大浦天主堂, 長崎市', aliases: ['潜伏キリシタン', '大浦天主堂', 'Hidden Christian Sites in the Nagasaki Region'] },
  { id: 1593, name: '百舌鳥・古市古墳群', context: '大阪府堺市・羽曳野市・藤井寺市', query: '大仙陵古墳, 堺市', aliases: ['仁徳天皇陵', '大仙古墳', 'Mozu-Furuichi Kofun Group'] },
  { id: 1574, name: '奄美大島、徳之島、沖縄島北部及び西表島', context: '鹿児島県・沖縄県', query: 'やんばる国立公園, 沖縄県', aliases: ['奄美大島', '徳之島', '沖縄島北部', '西表島', 'Amami-Oshima Island, Tokunoshima Island, Northern part of Okinawa Island, and Iriomote Island'] },
  { id: 1632, name: '北海道・北東北の縄文遺跡群', context: '北海道・青森県・岩手県・秋田県', query: '三内丸山遺跡, 青森市', aliases: ['縄文遺跡群', '三内丸山遺跡', 'Jomon Prehistoric Sites in Northern Japan'] },
  { id: 1698, name: '佐渡島の金山', context: '新潟県佐渡市', query: ['史跡 佐渡金山, 佐渡市', '佐渡金山, 佐渡市', '佐渡市, 新潟県'], aliases: ['佐渡金山', 'Sado Island Gold Mines'] }
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchGeometry(site, cache) {
  const cacheKey = site.cacheKey || site.id;
  if (cache[cacheKey]) return cache[cacheKey];
  let selected = null;
  for (const query of Array.isArray(site.query) ? site.query : [site.query]) {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('polygon_geojson', '1');
    url.searchParams.set('limit', '5');
    const response = await fetch(url, { headers: { 'User-Agent': 'dokodemo-nauru-data-maintenance/1.0' } });
    if (!response.ok) throw new Error(`${site.name}: Nominatim HTTP ${response.status}`);
    const results = await response.json();
    selected = results.find(item => item.geojson && ['Polygon', 'MultiPolygon'].includes(item.geojson.type));
    if (selected) break;
    await sleep(1100);
  }
  if (!selected) throw new Error(`${site.name}: 面境界が見つかりません`);
  cache[cacheKey] = selected;
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  await sleep(1100);
  return selected;
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
  const siteIds = new Set(missingSites.map(site => `attraction-unesco-${site.id}`));
  catalog.features = catalog.features.filter(feature => !siteIds.has(feature.id));

  for (const site of missingSites) {
    const result = site.geometryFileSource
      ? {
          geojson: JSON.parse(fs.readFileSync(path.join(root, 'data', site.geometryFileSource), 'utf8')).geometry,
          osm_type: site.osmType,
          osm_id: site.osmId
        }
      : await fetchGeometry(site, cache);
    const geometryFile = `attractions/unesco-${site.id}.geojson`;
    const id = `attraction-unesco-${site.id}`;
    const properties = {
      id, kind: 'attraction', name: site.name, shortName: site.name, context: site.context,
      subtype: 'world-heritage', subtypeLabel: '世界遺産・登録区域', statusLabel: `UNESCO世界遺産 No.${site.id}`,
      aliases: site.aliases, osmType: result.osm_type, osmId: result.osm_id, osmDate: null,
      officialAreaKm2: site.area || null,
      areaSourceLabel: site.area ? 'UNESCO World Heritage Centre' : '',
      areaSourceUrl: site.area ? `https://whc.unesco.org/en/list/${site.id}` : '',
      boundarySourceLabel: '© OpenStreetMap contributors', boundarySourceUrl: 'https://www.openstreetmap.org/copyright',
      geometryFile
    };
    const geometryFeature = { type: 'Feature', id, properties, geometry: result.geojson };
    fs.writeFileSync(path.join(root, 'data', geometryFile), JSON.stringify(geometryFeature));
    catalog.features.push({ type: 'Feature', id, properties, geometry: null });
  }

  catalog.features.sort((a, b) => String(a.properties.name).localeCompare(String(b.properties.name), 'ja'));
  catalog.generatedAt = new Date().toISOString();
  fs.writeFileSync(catalogPath, JSON.stringify(catalog));
  console.log(`世界遺産の代表検索項目を${missingSites.length}件追加しました`);
}

main().catch(error => { console.error(error); process.exit(1); });
