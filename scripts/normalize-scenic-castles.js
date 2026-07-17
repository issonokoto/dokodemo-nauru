const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'data', 'attractions.geojson');
const reportPath = path.join(root, 'scripts', 'japan-scenic-castles-report.json');
const osmCopyrightUrl = 'https://www.openstreetmap.org/copyright';
const castleSourceUrl = 'https://www.bunka.go.jp/seisaku/bunkashingikai/kondankaito/shiseki_working/01/pdf/r1411437_02.pdf';
const matsuyamaGeoshapeUrl = 'https://geoshape.ex.nii.ac.jp/ka/topojson/2020/38/r2ka38201.topojson';
const marugameGeoshapeUrl = 'https://geoshape.ex.nii.ac.jp/ka/topojson/2020/37/r2ka37202.topojson';

const existingKeeps = new Set([
  '弘前城', '松本城', '丸岡城', '犬山城', '彦根城', '姫路城',
  '松江城', '備中松山城', '丸亀城', '松山城', '宇和島城', '高知城'
]);

const officialNationalParks = new Set([
  '利尻礼文サロベツ国立公園', '知床国立公園', '阿寒摩周国立公園', '釧路湿原国立公園',
  '大雪山国立公園', '日高山脈襟裳十勝国立公園', '支笏洞爺国立公園', '十和田八幡平国立公園',
  '三陸復興国立公園', '磐梯朝日国立公園', '日光国立公園', '尾瀬国立公園',
  '上信越高原国立公園', '妙高戸隠連山国立公園', '秩父多摩甲斐国立公園', '小笠原国立公園',
  '富士箱根伊豆国立公園', '中部山岳国立公園', '白山国立公園', '南アルプス国立公園',
  '伊勢志摩国立公園', '吉野熊野国立公園', '山陰海岸国立公園', '瀬戸内海国立公園',
  '大山隠岐国立公園', '足摺宇和海国立公園', '西海国立公園', '雲仙天草国立公園',
  '阿蘇くじゅう国立公園', '霧島錦江湾国立公園', '屋久島国立公園', '奄美群島国立公園',
  'やんばる国立公園', '慶良間諸島国立公園', '西表石垣国立公園'
]);

const manualReconstructed = [
  { name: '富山城', context: '富山県富山市', osmId: 338862862, statusLabel: '再建天守／富山城址公園境界' },
  { name: '小田原城', context: '神奈川県小田原市', osmId: 167050294, statusLabel: '外観復元天守／天守建物境界' },
  { name: '白石城', context: '宮城県白石市', osmId: 242787452, statusLabel: '木造復元天守／天守建物境界' }
];
const promoteToReconstructed = new Set(['名古屋城', '広島城']);

function circleGeometry(lon, lat, radiusMeters = 30, steps = 48) {
  const coordinates = [];
  const latScale = 1 / 111320;
  const lonScale = 1 / (111320 * Math.cos(lat * Math.PI / 180));
  for (let index = 0; index <= steps; index += 1) {
    const angle = index / steps * Math.PI * 2;
    coordinates.push([lon + Math.cos(angle) * radiusMeters * lonScale, lat + Math.sin(angle) * radiusMeters * latScale]);
  }
  return { type: 'Polygon', coordinates: [coordinates] };
}

function decodeRing(topology, arcIndexes) {
  const ring = [];
  for (const arcIndex of arcIndexes) {
    const source = topology.arcs[arcIndex < 0 ? ~arcIndex : arcIndex];
    const arc = arcIndex < 0 ? source.slice().reverse() : source;
    ring.push(...(ring.length ? arc.slice(1) : arc));
  }
  if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) ring.push(ring[0]);
  return ring;
}

function decodeTopologyGeometry(topology, geometry) {
  if (geometry.type === 'Polygon') return { type: 'Polygon', coordinates: geometry.arcs.map(ring => decodeRing(topology, ring)) };
  if (geometry.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geometry.arcs.map(polygon => polygon.map(ring => decodeRing(topology, ring))) };
  throw new Error(`Unsupported TopoJSON geometry: ${geometry.type}`);
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Dokodemo-Nauru catalog maintenance (https://issonokoto.github.io/dokodemo-nauru/)' } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

async function osmWayGeometry(osmId) {
  const data = await fetchJson(`https://api.openstreetmap.org/api/0.6/way/${osmId}/full.json`);
  const nodes = new Map(data.elements.filter(element => element.type === 'node').map(node => [node.id, [node.lon, node.lat]]));
  const way = data.elements.find(element => element.type === 'way' && element.id === osmId);
  if (!way) throw new Error(`OSM way not found: ${osmId}`);
  const ring = way.nodes.map(id => nodes.get(id)).filter(Boolean);
  if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

function writeFeature(properties, geometry) {
  const feature = { type: 'Feature', id: properties.id, properties, geometry };
  fs.writeFileSync(path.join(root, 'data', properties.geometryFile), `${JSON.stringify(feature)}\n`);
  return { type: 'Feature', id: properties.id, properties, geometry: null };
}

function castleProperties({ id, name, context, geometryFile, osmType, osmId, statusLabel, boundarySourceLabel, boundarySourceUrl }) {
  return {
    id, kind: 'attraction', name, shortName: name, context,
    subtype: 'castle-existing', subtypeLabel: '城郭・現存天守', statusLabel,
    aliases: [], osmType, osmId, osmDate: null,
    officialAreaKm2: null, areaSourceLabel: '', areaSourceUrl: '',
    eventSourceLabel: '文化庁「国指定文化財等データベース」', eventSourceUrl: 'https://kunishitei.bunka.go.jp/bsys/index',
    boundarySourceLabel, boundarySourceUrl, geometryFile
  };
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  let features = (catalog.features || []).filter(feature => {
    const properties = feature.properties || {};
    if (properties.subtype === 'castle-existing' && !existingKeeps.has(properties.name)) return false;
    if (properties.subtype === 'castle-ruins-large' && !/城/u.test(properties.name || '')) return false;
    if (properties.subtype === 'national-park' && !officialNationalParks.has(properties.name)) return false;
    if (['丸亀城', '松山城', '備中松山城', '史跡 備中松山城跡', ...manualReconstructed.map(item => item.name)].includes(properties.name)) return false;
    return true;
  });

  for (const feature of features) {
    if (!promoteToReconstructed.has(feature.properties.name)) continue;
    feature.properties.subtype = 'castle-reconstructed';
    feature.properties.subtypeLabel = '城郭・再建天守';
    feature.properties.statusLabel = '外観復元・復興天守を含む';
  }

  const bitchuSite = (catalog.features || []).find(feature => feature.properties && feature.properties.name === '史跡 備中松山城跡');
  if (!bitchuSite) throw new Error('備中松山城跡の史跡境界が見つかりません');
  const bitchuDetail = JSON.parse(fs.readFileSync(path.join(root, 'data', bitchuSite.properties.geometryFile), 'utf8'));
  const bitchuProperties = castleProperties({
    id: 'attraction-castle-bitchu-matsuyama-site', name: '備中松山城', context: '岡山県高梁市',
    geometryFile: 'attractions/castle-bitchu-matsuyama-site.geojson', osmType: bitchuSite.properties.osmType, osmId: bitchuSite.properties.osmId,
    statusLabel: '現存12天守／史跡区域境界',
    boundarySourceLabel: '© OpenStreetMap contributors', boundarySourceUrl: osmCopyrightUrl
  });
  features.push(writeFeature(bitchuProperties, bitchuDetail.geometry));

  const topology = await fetchJson(matsuyamaGeoshapeUrl);
  const towns = topology.objects.town.geometries.filter(geometry => ['382010070', '382010120'].includes(geometry.properties.KEY_CODE));
  if (towns.length !== 2) throw new Error('松山市堀之内・丸之内の境界が揃いません');
  const matsuyamaGeometry = { type: 'MultiPolygon', coordinates: towns.flatMap(town => {
    const geometry = decodeTopologyGeometry(topology, town);
    return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  }) };
  const matsuyamaProperties = castleProperties({
    id: 'attraction-castle-matsuyama-horinochi-marunouchi', name: '松山城', context: '愛媛県松山市',
    geometryFile: 'attractions/castle-matsuyama-horinochi-marunouchi.geojson', osmType: 'geoshape-town', osmId: null,
    statusLabel: '現存12天守／堀之内・丸之内の町丁境界',
    boundarySourceLabel: '国勢調査町丁・字等別境界データセット（CODH作成、CC BY 4.0）',
    boundarySourceUrl: 'https://geoshape.ex.nii.ac.jp/ka/resource/38/38201.html'
  });
  features.push(writeFeature(matsuyamaProperties, matsuyamaGeometry));

  const marugameTopology = await fetchJson(marugameGeoshapeUrl);
  const ichibancho = marugameTopology.objects.town.geometries.find(geometry => geometry.properties.KEY_CODE === '372020180');
  if (!ichibancho) throw new Error('丸亀市一番丁の境界が見つかりません');
  const marugameGeometry = decodeTopologyGeometry(marugameTopology, ichibancho);
  const marugameProperties = castleProperties({
    id: 'attraction-castle-node-1179835155', name: '丸亀城', context: '香川県丸亀市',
    geometryFile: 'attractions/castle-marugame-ichibancho.geojson', osmType: 'geoshape-town', osmId: null,
    statusLabel: '現存12天守／丸亀市一番丁の町丁境界',
    boundarySourceLabel: '国勢調査町丁・字等別境界データセット（CODH作成、CC BY 4.0）',
    boundarySourceUrl: 'https://geoshape.ex.nii.ac.jp/ka/resource/37/372020180.html'
  });
  features.push(writeFeature(marugameProperties, marugameGeometry));

  for (const item of manualReconstructed) {
    const geometry = await osmWayGeometry(item.osmId);
    const id = `attraction-castle-W${item.osmId}`;
    const geometryFile = `attractions/castle-W${item.osmId}.geojson`;
    const properties = {
      id, kind: 'attraction', name: item.name, shortName: item.name, context: item.context,
      subtype: 'castle-reconstructed', subtypeLabel: '城郭・再建天守', statusLabel: item.statusLabel,
      aliases: [], osmType: 'way', osmId: item.osmId, osmDate: null,
      officialAreaKm2: null, areaSourceLabel: '', areaSourceUrl: '',
      eventSourceLabel: '文化庁「近世城郭内の復元建造物等の実態について」等', eventSourceUrl: castleSourceUrl,
      boundarySourceLabel: '© OpenStreetMap contributors', boundarySourceUrl: osmCopyrightUrl, geometryFile
    };
    features.push(writeFeature(properties, geometry));
  }

  const rank = subtype => ({
    'expo-site': 0, 'event-site': 0, landmark: 0, 'imperial-site': 1,
    'castle-existing': 2, 'castle-reconstructed': 3, 'castle-ruins-large': 4,
    'scenic-large': 5, 'national-park': 6, 'theme-park': 7
  }[subtype] ?? 8);
  features.sort((a, b) => rank(a.properties.subtype) - rank(b.properties.subtype) || String(a.properties.name).localeCompare(String(b.properties.name), 'ja'));
  fs.writeFileSync(catalogPath, `${JSON.stringify({ type: 'FeatureCollection', features })}\n`);

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.normalizedAt = new Date().toISOString();
  report.totalCatalogFeatures = features.length;
  report.generatedFeatures = features.filter(feature => ['castle-existing', 'castle-reconstructed', 'castle-ruins-large', 'national-park', 'scenic-large', 'imperial-site'].includes(feature.properties.subtype)).length;
  report.existingKeepFeatures = features.filter(feature => feature.properties.subtype === 'castle-existing').length;
  report.reconstructedKeepFeatures = features.filter(feature => feature.properties.subtype === 'castle-reconstructed').length;
  report.largeCastleRuinFeatures = features.filter(feature => feature.properties.subtype === 'castle-ruins-large').length;
  report.nationalParkFeatures = features.filter(feature => feature.properties.subtype === 'national-park').length;
  report.scenicLargeFeatures = features.filter(feature => feature.properties.subtype === 'scenic-large').length;
  report.imperialSiteFeatures = features.filter(feature => feature.properties.subtype === 'imperial-site').length;
  report.missingExistingKeeps = [...existingKeeps].filter(name => !features.some(feature => feature.properties.subtype === 'castle-existing' && feature.properties.name === name));
  report.missingReconstructedKeeps = (report.missingReconstructedKeeps || []).filter(name => !features.some(feature => feature.properties.subtype === 'castle-reconstructed' && feature.properties.name === name));
  report.normalizationNotes = ['松山城は堀之内・丸之内を統合', '丸亀城は丸亀市一番丁を使用', '公式名称でない国立公園と城でない大規模historic=castleを除外'];
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
