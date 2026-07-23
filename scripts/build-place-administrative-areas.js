const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NATURAL_PATH = path.join(ROOT, 'data', 'natural-features.geojson');
const ATTRACTIONS_PATH = path.join(ROOT, 'data', 'attractions.geojson');
const OUTPUT_PATH = path.join(ROOT, 'data', 'place-administrative-areas.json');
const MUNICIPALITY_URL = 'https://madefor.github.io/jisx0402/api/v1/all.json';
const REVERSE_URL = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
const CONCURRENCY = 6;
const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'
];
const MANUAL_OVERRIDES = {
  // 25の構成資産をまとめた登録区域。単一形状の代表点では拾えない関係自治体も含める。
  'attraction-unesco-1418': {
    prefectures: ['山梨県', '静岡県'],
    municipalities: [
      '山梨県富士吉田市', '山梨県身延町', '山梨県鳴沢村', '山梨県富士河口湖町',
      '山梨県山中湖村', '山梨県忍野村', '静岡県静岡市', '静岡県富士宮市',
      '静岡県富士市', '静岡県裾野市', '静岡県御殿場市', '静岡県小山町'
    ]
  }
};

function cleanText(value) {
  return String(value || '').trim();
}

function unique(values) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = (yi > point[1]) !== (yj > point[1])
      && point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  if (!polygon.length || !pointInRing(point, polygon[0])) return false;
  return !polygon.slice(1).some(hole => pointInRing(point, hole));
}

function boundsForPolygon(polygon) {
  const points = polygon[0] || [];
  return points.reduce((bounds, [longitude, latitude]) => ({
    minLongitude: Math.min(bounds.minLongitude, longitude),
    minLatitude: Math.min(bounds.minLatitude, latitude),
    maxLongitude: Math.max(bounds.maxLongitude, longitude),
    maxLatitude: Math.max(bounds.maxLatitude, latitude)
  }), {
    minLongitude: Infinity,
    minLatitude: Infinity,
    maxLongitude: -Infinity,
    maxLatitude: -Infinity
  });
}

function representativePoint(polygon) {
  const bounds = boundsForPolygon(polygon);
  const center = [
    (bounds.minLongitude + bounds.maxLongitude) / 2,
    (bounds.minLatitude + bounds.maxLatitude) / 2
  ];
  if (pointInPolygon(center, polygon)) return center;
  let best = null;
  let bestDistance = Infinity;
  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      const point = [
        bounds.minLongitude + (bounds.maxLongitude - bounds.minLongitude) * (column + 0.5) / 9,
        bounds.minLatitude + (bounds.maxLatitude - bounds.minLatitude) * (row + 0.5) / 9
      ];
      if (!pointInPolygon(point, polygon)) continue;
      const distance = (point[0] - center[0]) ** 2 + (point[1] - center[1]) ** 2;
      if (distance < bestDistance) {
        best = point;
        bestDistance = distance;
      }
    }
  }
  return best || polygon[0][0];
}

function samplePolygon(polygon, dense) {
  const bounds = boundsForPolygon(polygon);
  if (!dense) return [representativePoint(polygon)];
  const points = [];
  const gridSize = 7;
  for (let row = 0; row < gridSize; row += 1) {
    for (let column = 0; column < gridSize; column += 1) {
      const point = [
        bounds.minLongitude + (bounds.maxLongitude - bounds.minLongitude) * (column + 0.5) / gridSize,
        bounds.minLatitude + (bounds.maxLatitude - bounds.minLatitude) * (row + 0.5) / gridSize
      ];
      if (pointInPolygon(point, polygon)) points.push(point);
    }
  }
  if (!points.length) points.push(representativePoint(polygon));
  if (points.length <= 25) return points;
  const step = points.length / 25;
  return Array.from({ length: 25 }, (_, index) => points[Math.floor(index * step)]);
}

function sampleGeometry(geometry, properties) {
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return [];
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const areaKm2 = Number(properties.officialAreaKm2);
  const broadContext = /[・／/]|地方|諸島|列島|群島|島しょ/.test(cleanText(properties.context));
  const samples = [];
  polygons.forEach(polygon => {
    const bounds = boundsForPolygon(polygon);
    const span = Math.max(
      bounds.maxLongitude - bounds.minLongitude,
      bounds.maxLatitude - bounds.minLatitude
    );
    const dense = broadContext || areaKm2 >= 20 || span >= 0.12;
    samples.push(...samplePolygon(polygon, dense));
  });
  return uniquePoints(samples, 40);
}

function uniquePoints(points, limit) {
  const seen = new Set();
  const result = [];
  points.forEach(point => {
    const key = `${point[0].toFixed(5)},${point[1].toFixed(5)}`;
    if (seen.has(key) || result.length >= limit) return;
    seen.add(key);
    result.push(point);
  });
  return result;
}

function deriveGroups(properties, municipalityNames) {
  const groups = [];
  const contextParts = cleanText(properties.context).split(/[／/]/).map(cleanText);
  contextParts.forEach(part => {
    if (/地方|諸島|列島|群島|島しょ|半島|国立公園/.test(part)) groups.push(part);
  });
  const inOgasawara = municipalityNames.some(name => name.endsWith('小笠原村'))
    || contextParts.some(part => part.includes('小笠原'));
  if (inOgasawara) {
    groups.push('小笠原諸島');
    const name = cleanText(properties.shortName || properties.name);
    if (['父島', '兄島', '弟島', '西島', '東島', '南島'].some(item => name.includes(item))) {
      groups.push('父島列島');
    }
    if (['母島', '姉島', '妹島', '姪島', '向島', '平島'].some(item => name.includes(item))) {
      groups.push('母島列島');
    }
    if (['聟島', '嫁島', '媒島', '北之島'].some(item => name.includes(item))) {
      groups.push('聟島列島');
    }
    if (['北硫黄島', '硫黄島（東京都）', '南硫黄島'].some(item => name.includes(item))) {
      groups.push('火山列島');
    }
  }
  return unique(groups);
}

async function loadMunicipalities() {
  const response = await fetch(MUNICIPALITY_URL);
  if (!response.ok) throw new Error(`自治体一覧を取得できません: HTTP ${response.status}`);
  const catalog = await response.json();
  const byAdminCode = new Map();
  Object.entries(catalog).forEach(([code, item]) => {
    if (!/^\d{6}$/.test(code) || !item || !item.prefecture || !item.city) return;
    byAdminCode.set(code.slice(0, -1), {
      prefecture: cleanText(item.prefecture),
      municipality: cleanText(item.city)
    });
  });
  return byAdminCode;
}

const reverseCache = new Map();

async function reverseGeocode(point) {
  const key = `${point[0].toFixed(5)},${point[1].toFixed(5)}`;
  if (reverseCache.has(key)) return reverseCache.get(key);
  const promise = (async () => {
    const url = new URL(REVERSE_URL);
    url.searchParams.set('lat', point[1].toFixed(7));
    url.searchParams.set('lon', point[0].toFixed(7));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`逆ジオコーダー HTTP ${response.status}`);
    const payload = await response.json();
    const code = cleanText(payload.results && payload.results.muniCd);
    return /^\d{5}$/.test(code) && code !== '00000' ? code : '';
  })().catch(() => '');
  reverseCache.set(key, promise);
  return promise;
}

async function enrichFeature(feature, municipalityCatalog) {
  const properties = feature && feature.properties || {};
  const geometryPath = properties.geometryFile ? path.join(ROOT, 'data', properties.geometryFile) : '';
  if (!geometryPath || !fs.existsSync(geometryPath)) {
    return { prefectures: [], municipalities: [], groups: deriveGroups(properties, []) };
  }
  const detailed = JSON.parse(fs.readFileSync(geometryPath, 'utf8'));
  const samples = sampleGeometry(detailed.geometry, properties);
  const codes = unique(await Promise.all(samples.map(reverseGeocode)));
  const entries = codes.map(code => municipalityCatalog.get(code)).filter(Boolean);
  const matchedContextPrefectures = PREFECTURES.filter(prefecture => cleanText(properties.context).includes(prefecture));
  // 自然地物の複数県 context は掲載グループを表す場合があるため、単一県だけを所在地として採用する。
  // 複数構成資産を束ねる観光地・世界遺産では context の全県を検索対象に残す。
  const contextPrefectures = matchedContextPrefectures.length === 1 || properties.kind === 'attraction'
    ? matchedContextPrefectures
    : [];
  const override = MANUAL_OVERRIDES[cleanText(properties.id || feature.id)] || {};
  const detectedMunicipalities = entries.map(entry => `${entry.prefecture}${entry.municipality}`);
  const municipalitiesAllowedByContext = matchedContextPrefectures.length === 1
    ? detectedMunicipalities.filter(name => name.startsWith(matchedContextPrefectures[0]))
    : detectedMunicipalities;
  const detectedPrefectures = entries.map(entry => entry.prefecture);
  const prefectures = unique([
    ...(matchedContextPrefectures.length === 1 ? [] : detectedPrefectures),
    ...contextPrefectures,
    ...(override.prefectures || [])
  ]);
  const municipalities = unique([
    ...municipalitiesAllowedByContext,
    ...(override.municipalities || [])
  ]);
  return {
    prefectures,
    municipalities,
    groups: deriveGroups(properties, municipalities)
  };
}

async function mapWithConcurrency(items, worker, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
      if ((index + 1) % 100 === 0) console.log(`${index + 1}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  return results;
}

async function main() {
  const natural = JSON.parse(fs.readFileSync(NATURAL_PATH, 'utf8'));
  const attractions = JSON.parse(fs.readFileSync(ATTRACTIONS_PATH, 'utf8'));
  const municipalityCatalog = await loadMunicipalities();
  const features = [...(natural.features || []), ...(attractions.features || [])];
  const results = await mapWithConcurrency(
    features,
    feature => enrichFeature(feature, municipalityCatalog),
    CONCURRENCY
  );
  const places = {};
  features.forEach((feature, index) => {
    const properties = feature && feature.properties || {};
    const id = cleanText(properties.id || feature.id);
    if (id) places[id] = results[index];
  });
  const summary = Object.values(places).reduce((result, item) => {
    if (item.prefectures.length) result.withPrefectures += 1;
    if (item.municipalities.length) result.withMunicipalities += 1;
    if (item.prefectures.length > 1) result.multiPrefecture += 1;
    if (item.municipalities.length > 1) result.multiMunicipality += 1;
    if (item.groups.length) result.withGroups += 1;
    return result;
  }, {
    total: Object.keys(places).length,
    withPrefectures: 0,
    withMunicipalities: 0,
    multiPrefecture: 0,
    multiMunicipality: 0,
    withGroups: 0
  });
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: '国土交通省 国土数値情報（行政区域）由来の国土地理院 位置参照情報 逆ジオコーダー',
    summary,
    places
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
