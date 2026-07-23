const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'data', 'natural-features.geojson');
const geometryDir = path.join(root, 'data', 'natural-features');
const osmBoundarySourceLabel = '© OpenStreetMap contributors';
const osmBoundarySourceUrl = 'https://www.openstreetmap.org/copyright';
const naturalEarthBoundarySourceLabel = 'Natural Earth 1:10m Cultural Vectors';
const naturalEarthBoundarySourceUrl =
  'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-0-countries/';
const userAgent = 'DokodemoNauruDataBuilder/1.0 (data maintenance)';

const osmIslands = [
  {
    osmRef: 'R17591670',
    name: '竹生島',
    context: '滋賀県長浜市・琵琶湖',
    aliases: ['ちくぶしま', 'Chikubushima'],
    officialAreaKm2: 0.14,
    areaSourceLabel: '長浜市「長浜市歴史的風致維持向上計画」',
    areaSourceUrl:
      'https://www.city.nagahama.lg.jp/cmsfiles/contents/0000001/1238/R5_keikaku2nd_02_87-134.pdf'
  },
  {
    osmRef: 'R5921711',
    name: '多景島',
    context: '滋賀県彦根市・琵琶湖',
    aliases: ['たけしま', '竹島', 'Takeshima', 'Takei Island'],
    officialAreaKm2: null
  },
  {
    osmRef: 'R13125026',
    name: '沖の白石',
    context: '滋賀県高島市・琵琶湖',
    aliases: ['おきのしらいし', '沖ノ白石', 'Oki-no-Shiraishi'],
    officialAreaKm2: null
  },
  {
    osmRef: 'R7349435',
    name: '沖ノ鳥島',
    context: '東京都小笠原村',
    aliases: ['おきのとりしま', '沖の鳥島', 'Okinotorishima'],
    officialAreaKm2: null
  },
  {
    osmRef: 'R3987424',
    name: '樺太',
    context: 'ロシア・サハリン州',
    aliases: ['からふと', 'サハリン島', 'Sakhalin', 'Sakhalin Island'],
    officialAreaKm2: null,
    global: true
  },
  {
    osmRef: 'R7219605',
    name: '台湾島',
    context: '台湾',
    aliases: ['台湾本島', 'Taiwan', 'Formosa', 'フォルモサ'],
    officialAreaKm2: null,
    global: true
  },
  {
    osmRef: 'R3478916',
    name: 'イスパニョーラ島',
    context: 'ハイチ・ドミニカ共和国',
    aliases: ['Hispaniola', 'La Española', 'ハイチ島'],
    officialAreaKm2: null,
    global: true
  },
  {
    osmRef: 'R7118334',
    name: 'マルタ島',
    context: 'マルタ',
    aliases: ['Malta Island', 'Malta'],
    officialAreaKm2: null,
    global: true
  }
];

const naturalEarthIslands = [
  {
    countryCode: 'CUB',
    name: 'キューバ島',
    context: 'キューバ',
    aliases: ['Cuba Island', 'Cuba'],
    global: true
  },
  {
    countryCode: 'JAM',
    name: 'ジャマイカ島',
    context: 'ジャマイカ',
    aliases: ['Jamaica Island', 'Jamaica'],
    global: true
  }
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function refParts(osmRef) {
  const prefix = osmRef[0];
  return {
    osmType: prefix === 'R' ? 'relation' : prefix === 'W' ? 'way' : 'node',
    osmId: Number(osmRef.slice(1))
  };
}

function polygonAreaScore(coordinates) {
  const ring = coordinates[0] || [];
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return Math.abs(area / 2);
}

function largestPolygon(geometry) {
  if (!geometry) throw new Error('Geometry is missing');
  if (geometry.type === 'Polygon') return geometry;
  if (geometry.type !== 'MultiPolygon') {
    throw new Error(`Unsupported geometry: ${geometry.type}`);
  }
  const coordinates = geometry.coordinates.reduce((largest, candidate) => {
    return polygonAreaScore(candidate) > polygonAreaScore(largest) ? candidate : largest;
  });
  return { type: 'Polygon', coordinates };
}

function propertiesFor(island, extra = {}) {
  const { idRef, ...properties } = extra;
  const id = island.global ? `island-global-${island.name}` : `island-${idRef || island.name}`;
  return {
    id,
    kind: 'island',
    name: island.name,
    shortName: island.name,
    context: island.context,
    aliases: island.aliases,
    officialAreaKm2: island.officialAreaKm2 ?? null,
    ...properties
  };
}

function upsert(catalog, properties, geometry) {
  const feature = { type: 'Feature', id: properties.id, properties, geometry };
  const catalogFeature = { type: 'Feature', id: properties.id, properties, geometry: null };
  const existingIndex = catalog.features.findIndex(item => {
    const candidate = item.properties || {};
    return candidate.id === properties.id || candidate.name === properties.name;
  });
  if (existingIndex >= 0) catalog.features[existingIndex] = catalogFeature;
  else catalog.features.push(catalogFeature);
  fs.writeFileSync(
    path.join(geometryDir, path.basename(properties.geometryFile)),
    `${JSON.stringify(feature)}\n`
  );
}

async function fetchOsmGeometry(osmRef) {
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
  if (!result) throw new Error(`Polygon not found: ${osmRef}`);
  return result.geojson;
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

  for (const island of osmIslands) {
    const { osmType, osmId } = refParts(island.osmRef);
    const properties = propertiesFor(island, {
      idRef: island.osmRef,
      osmType,
      osmId,
      boundarySourceLabel: osmBoundarySourceLabel,
      boundarySourceUrl: osmBoundarySourceUrl,
      geometryFile: `natural-features/${island.osmRef}.geojson`
    });
    if (island.areaSourceLabel) properties.areaSourceLabel = island.areaSourceLabel;
    if (island.areaSourceUrl) properties.areaSourceUrl = island.areaSourceUrl;
    const geometry = await fetchOsmGeometry(island.osmRef);
    upsert(catalog, properties, geometry);
    console.log(`add ${island.name}: OSM ${island.osmRef} (${geometry.type})`);
    await sleep(1100);
  }

  for (const island of naturalEarthIslands) {
    const country = JSON.parse(
      fs.readFileSync(path.join(root, 'data', 'countries', `${island.countryCode}.geojson`), 'utf8')
    );
    const geometry = largestPolygon(country.geometry);
    const geometryFile = `natural-features/NE-${island.countryCode}-MAIN.geojson`;
    const properties = propertiesFor(island, {
      boundarySourceLabel: naturalEarthBoundarySourceLabel,
      boundarySourceUrl: naturalEarthBoundarySourceUrl,
      naturalEarthCode: island.countryCode,
      geometryFile
    });
    upsert(catalog, properties, geometry);
    console.log(`add ${island.name}: Natural Earth ${island.countryCode} largest polygon`);
  }

  catalog.generatedAt = new Date().toISOString();
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`);
  console.log(`done: ${catalog.features.length} natural features`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
