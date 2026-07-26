const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'data', 'natural-features.geojson');
const geometryDir = path.join(root, 'data', 'natural-features');
const userAgent = 'DokodemoNauruDataBuilder/1.0 (data maintenance)';
const boundarySourceLabel = '© OpenStreetMap contributors';
const boundarySourceUrl = 'https://www.openstreetmap.org/copyright';

const islands = [
  {
    name: 'ファラリョン・デ・パハロス島',
    aliases: ['ウラカス島', 'Farallon de Pajaros', 'Urracas', 'Uracas'],
    osmRef: 'R7262544'
  },
  {
    name: 'マウグ島',
    aliases: ['マウグ諸島', 'Maug Islands', 'Måug'],
    osmRef: 'R7262543'
  },
  {
    name: 'アスンシオン島',
    aliases: ['Asuncion Island', 'Asunción Island'],
    osmRef: 'R7262527'
  },
  {
    name: 'アグリハン島',
    aliases: ['アグリガン島', 'Agrihan', 'Agrigan'],
    osmRef: 'R14087576'
  },
  {
    name: 'パガン島',
    aliases: ['Pagan Island', 'Pagan', 'Pågan'],
    osmRef: 'R7262520'
  },
  {
    name: 'アラマガン島',
    aliases: ['Alamagan Island', 'Alamagan', 'Alamågan'],
    osmRef: 'W23719153'
  },
  {
    name: 'ググアン島',
    aliases: ['Guguan Island', 'Guguan'],
    osmRef: 'W23719123'
  },
  {
    name: 'サリガン島',
    aliases: ['Sarigan Island', 'Sarigan'],
    osmRef: 'W93996245'
  },
  {
    name: 'アナタハン島',
    aliases: ['Anatahan Island', 'Anatahan', 'Anatåhån'],
    osmRef: 'W23719121'
  },
  {
    name: 'ファラリョン・デ・メディニラ島',
    aliases: ['Farallon de Medinilla'],
    osmRef: 'W23719189'
  },
  {
    name: 'アギガン島',
    aliases: ['アグイハン島', 'Aguigan', 'Aguihan', 'Aguijan'],
    osmRef: 'W23719196'
  }
];

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function osmParts(osmRef) {
  const prefix = osmRef[0];
  return {
    osmType: prefix === 'R' ? 'relation' : prefix === 'W' ? 'way' : 'node',
    osmId: Number(osmRef.slice(1))
  };
}

function coordinatesBounds(geometry) {
  const points = [];
  const visit = value => {
    if (Array.isArray(value) && value.length >= 2 &&
        Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      points.push(value);
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
  };
  visit(geometry.coordinates);
  return {
    minLon: Math.min(...points.map(point => point[0])),
    minLat: Math.min(...points.map(point => point[1])),
    maxLon: Math.max(...points.map(point => point[0])),
    maxLat: Math.max(...points.map(point => point[1]))
  };
}

async function fetchGeometry(island) {
  const params = new URLSearchParams({
    format: 'jsonv2',
    polygon_geojson: '1',
    osm_ids: island.osmRef
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/lookup?${params}`, {
    headers: { 'User-Agent': userAgent, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) throw new Error(`Nominatim ${response.status}: ${island.osmRef}`);
  const results = await response.json();
  const result = results.find(item =>
    item.geojson && ['Polygon', 'MultiPolygon'].includes(item.geojson.type)
  );
  if (!result) throw new Error(`Polygon not found: ${island.name} (${island.osmRef})`);
  const bounds = coordinatesBounds(result.geojson);
  if (bounds.minLat < 14 || bounds.maxLat > 21 ||
      bounds.minLon < 144 || bounds.maxLon > 147) {
    throw new Error(`Unexpected bounds: ${island.name} ${JSON.stringify(bounds)}`);
  }
  return result.geojson;
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const existingOsm = new Map(catalog.features.map(feature => {
    const properties = feature.properties || {};
    const key = properties.osmType && properties.osmId
      ? `${properties.osmType}:${properties.osmId}`
      : '';
    return [key, properties.id];
  }).filter(([key]) => key));
  const staged = [];

  for (const island of islands) {
    const { osmType, osmId } = osmParts(island.osmRef);
    const id = `island-overseas-${island.name}`;
    const duplicateId = existingOsm.get(`${osmType}:${osmId}`);
    if (duplicateId && duplicateId !== id) {
      throw new Error(`Duplicate OSM object: ${island.name} conflicts with ${duplicateId}`);
    }
    const geometry = await fetchGeometry(island);
    const properties = {
      id,
      kind: 'island',
      name: island.name,
      shortName: island.name,
      context: '北マリアナ諸島・アメリカ合衆国',
      aliases: island.aliases,
      osmType,
      osmId,
      officialAreaKm2: null,
      boundarySourceLabel,
      boundarySourceUrl,
      geometryFile: `natural-features/${island.osmRef}.geojson`
    };
    staged.push({
      catalogFeature: { type: 'Feature', id, properties, geometry: null },
      detailFeature: { type: 'Feature', id, properties, geometry }
    });
    console.log(`resolve ${island.name}: ${island.osmRef} (${geometry.type})`);
    await sleep(1100);
  }

  for (const item of staged) {
    const existingIndex = catalog.features.findIndex(feature => {
      const properties = feature.properties || {};
      return properties.id === item.catalogFeature.id ||
        properties.name === item.catalogFeature.properties.name;
    });
    if (existingIndex >= 0) catalog.features[existingIndex] = item.catalogFeature;
    else catalog.features.push(item.catalogFeature);
    fs.writeFileSync(
      path.join(root, 'data', item.catalogFeature.properties.geometryFile),
      `${JSON.stringify(item.detailFeature)}\n`
    );
  }

  catalog.generatedAt = new Date().toISOString();
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`);
  console.log(`done: ${staged.length} northern Mariana islands; ${catalog.features.length} total`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
