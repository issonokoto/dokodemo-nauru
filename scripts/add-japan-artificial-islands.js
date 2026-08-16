const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'data', 'natural-features.geojson');
const geometryDir = path.join(root, 'data', 'natural-features');
const defaultSourceDir = path.resolve(
  root,
  '..',
  'tmp',
  'artificial-island-boundaries-20260809'
);
const sourceDir = path.resolve(process.env.ARTIFICIAL_ISLAND_SOURCE_DIR || defaultSourceDir);
const boundarySourceLabel = '© OpenStreetMap contributors';
const boundarySourceUrl = 'https://www.openstreetmap.org/copyright';
const userAgent = 'Dokodemo-Nauru island catalog maintenance';

const islands = [
  {
    osmRef: 'R6421263',
    name: 'ポートアイランド',
    context: '兵庫県神戸市中央区',
    aliases: ['神戸ポートアイランド', 'Port Island', 'Port Island (Kobe)'],
    officialAreaKm2: null
  },
  {
    osmRef: 'R6421262',
    name: '六甲アイランド',
    context: '兵庫県神戸市東灘区',
    aliases: ['六甲人工島', 'Rokko Island', 'Rokko Artificial Island'],
    officialAreaKm2: 5.8,
    areaSourceLabel: '国土交通省「第3章」',
    areaSourceUrl: 'https://www.mlit.go.jp/common/000116602.pdf'
  },
  {
    osmRef: 'R6421264',
    name: '神戸空港島',
    context: '兵庫県神戸市中央区',
    aliases: ['神戸空港', 'Kobe Airport Island', '空港島'],
    officialAreaKm2: 2.72,
    areaSourceLabel: '神戸空港「よくあるご質問」',
    areaSourceUrl: 'https://www.kairport.co.jp/support/faq'
  },
  {
    osmRef: 'W484294967',
    name: '出島（長崎）',
    context: '長崎県長崎市',
    aliases: ['出島', '出島和蘭商館跡', 'Dejima', 'Dejima Dutch Trading Post'],
    officialAreaKm2: 0.015387,
    areaSourceLabel: '公式「出島」：小さな島の魅力',
    areaSourceUrl: 'https://nagasakidejima.jp/2091/',
    territoryNote: '旧人工島。現在の復元史跡区画の面境界を比較範囲とする。'
  },
  {
    osmRef: 'R3782450',
    name: 'お台場',
    context: '東京都港区・江東区',
    aliases: ['台場', 'Daiba', 'Odaiba'],
    officialAreaKm2: null
  },
  {
    osmRef: 'R12608090',
    name: '東扇島',
    context: '神奈川県川崎市川崎区',
    aliases: ['Higashi-Ogishima', '東扇島人工島'],
    officialAreaKm2: null
  },
  {
    osmRef: 'W674864602',
    name: '浮島',
    context: '神奈川県川崎市川崎区',
    aliases: ['浮島人工島', 'Ukishima'],
    officialAreaKm2: null
  },
  {
    osmRef: 'R12752844',
    name: '夢の島',
    context: '東京都江東区',
    aliases: ['夢の島公園', 'Yumenoshima', 'Yume no Shima'],
    officialAreaKm2: null,
    territoryNote: '人工島。OSMの町名境界（夢の島）を比較範囲とする。'
  }
];

function refParts(osmRef) {
  return {
    osmType: osmRef[0] === 'R' ? 'relation' : osmRef[0] === 'W' ? 'way' : 'node',
    osmId: Number(osmRef.slice(1))
  };
}

function geometryPath(osmRef) {
  return path.join(geometryDir, `${osmRef}.geojson`);
}

function validateGeometry(geometry, name) {
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) {
    throw new Error(`${name}: unsupported geometry ${geometry && geometry.type}`);
  }
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  if (!polygons.length) throw new Error(`${name}: empty polygon`);
  for (const polygon of polygons) {
    if (!polygon.length) throw new Error(`${name}: polygon has no rings`);
    for (const ring of polygon) {
      if (ring.length < 4) throw new Error(`${name}: ring has fewer than four points`);
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        throw new Error(`${name}: ring is not closed`);
      }
      for (const point of ring) {
        if (!Array.isArray(point) || point.length < 2 || point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90) {
          throw new Error(`${name}: invalid coordinate`);
        }
      }
    }
  }
}

async function fetchNominatimGeometry(osmRef, name) {
  const params = new URLSearchParams({
    format: 'jsonv2',
    polygon_geojson: '1',
    osm_ids: osmRef
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/lookup?${params}`, {
    headers: { 'User-Agent': userAgent, 'Accept-Language': 'ja,en' }
  });
  if (!response.ok) throw new Error(`Nominatim ${response.status}: ${osmRef}`);
  const results = await response.json();
  const result = results.find(item => item.geojson && ['Polygon', 'MultiPolygon'].includes(item.geojson.type));
  if (!result) throw new Error(`${name}: polygon not found for ${osmRef}`);
  return result.geojson;
}

async function loadGeometry(island) {
  const sourcePath = path.join(sourceDir, `${island.osmRef}.geojson`);
  if (fs.existsSync(sourcePath)) {
    const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    validateGeometry(source.geometry, island.name);
    return { geometry: source.geometry, source: 'validated converter output' };
  }

  const targetPath = geometryPath(island.osmRef);
  if (fs.existsSync(targetPath)) {
    const source = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    validateGeometry(source.geometry, island.name);
    return { geometry: source.geometry, source: 'existing catalog geometry' };
  }

  const geometry = await fetchNominatimGeometry(island.osmRef, island.name);
  validateGeometry(geometry, island.name);
  return { geometry, source: 'Nominatim pinned-object lookup' };
}

function propertiesFor(island) {
  const { osmType, osmId } = refParts(island.osmRef);
  return {
    id: `island-${island.osmRef}`,
    kind: 'island',
    name: island.name,
    shortName: island.name,
    context: island.context,
    aliases: island.aliases,
    osmType,
    osmId,
    officialAreaKm2: island.officialAreaKm2,
    areaSourceLabel: island.areaSourceLabel || '',
    areaSourceUrl: island.areaSourceUrl || '',
    boundarySourceLabel,
    boundarySourceUrl,
    geometryFile: `natural-features/${island.osmRef}.geojson`,
    ...(island.territoryNote ? { territoryNote: island.territoryNote } : {})
  };
}

function renameExistingMiyagiDejima(catalog) {
  const existing = catalog.features.find(feature => {
    const properties = feature.properties || {};
    return properties.osmType === 'way' && Number(properties.osmId) === 131255662;
  });
  if (!existing) return;

  existing.properties.name = '出島（宮城県）';
  existing.properties.shortName = '出島（宮城県）';
  existing.properties.aliases = ['出島', 'でじま', 'Dejima (Miyagi)'];

  const detailPath = path.join(root, 'data', existing.properties.geometryFile);
  if (fs.existsSync(detailPath)) {
    const detail = JSON.parse(fs.readFileSync(detailPath, 'utf8'));
    detail.properties = {
      ...detail.properties,
      name: '出島（宮城県）',
      shortName: '出島（宮城県）',
      aliases: ['出島', 'でじま', 'Dejima (Miyagi)']
    };
    fs.writeFileSync(detailPath, `${JSON.stringify(detail)}\n`);
  }
}

function upsert(catalog, properties, geometry) {
  const feature = { type: 'Feature', id: properties.id, properties, geometry };
  const catalogFeature = { type: 'Feature', id: properties.id, properties, geometry: null };
  const index = catalog.features.findIndex(item => {
    const candidate = item.properties || {};
    return candidate.id === properties.id || (candidate.osmType === properties.osmType && Number(candidate.osmId) === properties.osmId);
  });
  if (index >= 0) catalog.features[index] = catalogFeature;
  else catalog.features.push(catalogFeature);
  fs.writeFileSync(geometryPath(properties.id.replace('island-', '')), `${JSON.stringify(feature)}\n`);
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const prepared = [];
  for (const island of islands) {
    const loaded = await loadGeometry(island);
    prepared.push({ island, properties: propertiesFor(island), ...loaded });
    console.log(`${island.name}: ${island.osmRef}, ${loaded.geometry.type}, ${loaded.source}`);
    if (loaded.source === 'Nominatim pinned-object lookup') await new Promise(resolve => setTimeout(resolve, 1200));
  }

  renameExistingMiyagiDejima(catalog);
  for (const item of prepared) upsert(catalog, item.properties, item.geometry);
  catalog.generatedAt = new Date().toISOString();
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`);
  console.log(`done: ${catalog.features.length} natural features`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
