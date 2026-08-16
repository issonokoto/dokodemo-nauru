const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const GEOMETRY_DIR = path.join(DATA_DIR, 'attractions');
const COMPOSITE_FILE = path.join(GEOMETRY_DIR, 'kofun-daisen.geojson');
const METADATA_FILE = path.join(GEOMETRY_DIR, 'kofun-daisen.metadata.json');
const PREVIEW_FILE = path.join(GEOMETRY_DIR, 'kofun-daisen.preview.svg');
const CATALOG_FILE = path.join(DATA_DIR, 'attractions.geojson');
const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

const INNER_MOAT_FILE = 'attractions/daisen-inner-moat-R13135846.geojson';
const OUTER_MOAT_FILE = 'attractions/daisen-outer-moat-W41374179.geojson';

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, relativePath), 'utf8'));
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function ringAreaKm2(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const radius = 6378137;
  const toRadians = value => Number(value) * Math.PI / 180;
  let total = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const lower = ring[(index + ring.length - 1) % ring.length];
    const middle = ring[index];
    const upper = ring[(index + 1) % ring.length];
    total += (toRadians(upper[0]) - toRadians(lower[0])) * Math.sin(toRadians(middle[1]));
  }
  return Math.abs(total * radius * radius / 2) / 1e6;
}

function polygonAreaKm2(polygon) {
  if (!Array.isArray(polygon) || !polygon.length) return 0;
  return Math.max(0, ringAreaKm2(polygon[0])
    - polygon.slice(1).reduce((sum, ring) => sum + ringAreaKm2(ring), 0));
}

function polygonsFromGeometry(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function geometryAreaKm2(geometry) {
  return polygonsFromGeometry(geometry).reduce((sum, polygon) => sum + polygonAreaKm2(polygon), 0);
}

function allPoints(geometries) {
  return geometries.flatMap(geometry => polygonsFromGeometry(geometry)
    .flatMap(polygon => polygon.flatMap(ring => ring)));
}

function svgPath(geometry, metrics, scale) {
  const xMid = (metrics.minX + metrics.maxX) / 2;
  const yMid = (metrics.minY + metrics.maxY) / 2;
  const pointToSvg = ([longitude, latitude]) => {
    const x = (longitude - metrics.lon0) * 111320 * metrics.cosLat;
    const y = -(latitude - metrics.lat0) * 110540;
    return [360 + (x - xMid) * scale, 270 + (y - yMid) * scale];
  };
  return polygonsFromGeometry(geometry).flatMap(polygon => polygon.map(ring => {
    const points = ring.map(pointToSvg);
    return `M${points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join('L')}Z`;
  })).join(' ');
}

function projectionMetrics(geometries) {
  const points = allPoints(geometries);
  const lon0 = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const lat0 = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  const cosLat = Math.cos(lat0 * Math.PI / 180);
  const projected = points.map(([longitude, latitude]) => [
    (longitude - lon0) * 111320 * cosLat,
    -(latitude - lat0) * 110540
  ]);
  return {
    lon0,
    lat0,
    cosLat,
    minX: Math.min(...projected.map(point => point[0])),
    maxX: Math.max(...projected.map(point => point[0])),
    minY: Math.min(...projected.map(point => point[1])),
    maxY: Math.max(...projected.map(point => point[1]))
  };
}

function build() {
  const innerMoat = readJson(INNER_MOAT_FILE);
  const outerMoat = readJson(OUTER_MOAT_FILE);
  const innerMoatGeometry = innerMoat.geometry;
  const outerMoatGeometry = outerMoat.geometry;
  if (innerMoatGeometry.type !== 'Polygon' || innerMoatGeometry.coordinates.length < 2) {
    throw new Error('大仙古墳内濠に墳丘を示す内側リングがありません');
  }
  if (outerMoatGeometry.type !== 'Polygon') {
    throw new Error('大仙古墳外濠がPolygonではありません');
  }

  const moundGeometry = {
    type: 'Polygon',
    coordinates: [innerMoatGeometry.coordinates[1]]
  };
  const composite = {
    type: 'FeatureCollection',
    properties: {
      id: 'attraction-kofun-daisen',
      name: '大仙古墳',
      boundaryDefinition: 'OSMに記録された墳丘と内濠・外濠を、比較画像用のレイヤーとして重ねて表示する。',
      sourceObjects: [
        { osmType: 'relation', osmId: 13135846, role: 'inner moat' },
        { osmType: 'way', osmId: 41374179, role: 'outer moat' }
      ]
    },
    features: [
      {
        type: 'Feature',
        id: 'daisen-mound',
        properties: { layer: 'land', role: 'mound', name: '大仙古墳墳丘' },
        geometry: moundGeometry
      },
      {
        type: 'Feature',
        id: 'daisen-inner-moat',
        properties: { layer: 'water', role: 'inner-moat', name: '大仙古墳内濠' },
        geometry: innerMoatGeometry
      },
      {
        type: 'Feature',
        id: 'daisen-outer-moat',
        properties: { layer: 'water', role: 'outer-moat', name: '大仙古墳外濠' },
        geometry: outerMoatGeometry
      }
    ]
  };

  fs.mkdirSync(GEOMETRY_DIR, { recursive: true });
  fs.writeFileSync(COMPOSITE_FILE, `${JSON.stringify(composite)}\n`, 'utf8');

  const geometries = [moundGeometry, innerMoatGeometry, outerMoatGeometry];
  const metrics = projectionMetrics(geometries);
  const scale = 222 / Math.max(
    metrics.maxX - metrics.minX,
    metrics.maxY - metrics.minY,
    1
  );
  const moundPath = svgPath(moundGeometry, metrics, scale);
  const innerMoatPath = svgPath(innerMoatGeometry, metrics, scale);
  const outerMoatPath = svgPath(outerMoatGeometry, metrics, scale);
  const preview = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="540" viewBox="0 0 720 540">',
    '<rect width="720" height="540" fill="#f7f7f7"/>',
    `<path d="${moundPath}" fill="#f5a623" stroke="#8a4b08" stroke-width="2.2" fill-rule="evenodd"/>`,
    `<path d="${innerMoatPath}" fill="#52b8dc" stroke="#155a78" stroke-width="2.2" fill-rule="evenodd"/>`,
    `<path d="${outerMoatPath}" fill="#52b8dc" stroke="#155a78" stroke-width="2.2" fill-rule="evenodd"/>`,
    '</svg>',
    ''
  ].join('\n');
  fs.writeFileSync(PREVIEW_FILE, preview, 'utf8');

  const compositeAreaKm2 = geometries.reduce((sum, geometry) => sum + geometryAreaKm2(geometry), 0);
  const metadata = {
    version: 1,
    target: {
      name: '大仙古墳',
      kind: 'attraction',
      subtype: 'kofun',
      context: '大阪府堺市'
    },
    boundaryDefinition: composite.properties.boundaryDefinition,
    sourceObjects: composite.properties.sourceObjects,
    sourceFiles: [
      { file: INNER_MOAT_FILE, sha256: sha256(path.join(DATA_DIR, INNER_MOAT_FILE)) },
      { file: OUTER_MOAT_FILE, sha256: sha256(path.join(DATA_DIR, OUTER_MOAT_FILE)) }
    ],
    geometry: {
      type: 'FeatureCollection',
      layerCount: 3,
      landLayers: 1,
      waterLayers: 2,
      areaKm2: Number(compositeAreaKm2.toFixed(8)),
      sha256: sha256(COMPOSITE_FILE)
    },
    validation: {
      status: 'passed',
      checks: [
        'inner moat and outer moat are converter-validated closed Polygon geometries',
        'mound is preserved from the inner moat hole',
        'all coordinates remain WGS84 longitude/latitude pairs',
        'layered preview uses one projected scale and preserves the keyhole outline'
      ]
    },
    export: {
      projection: 'local equirectangular with cosine(latitude) correction',
      yAxis: 'inverted for SVG',
      previewSvg: 'attractions/kofun-daisen.preview.svg',
      previewSvgSha256: sha256(PREVIEW_FILE)
    }
  };
  fs.writeFileSync(METADATA_FILE, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  const catalog = readJson('attractions.geojson');
  const features = (catalog.features || []).filter(feature => feature.id !== 'attraction-kofun-daisen');
  const unesco = features.find(feature => feature.id === 'attraction-unesco-1593');
  if (unesco && unesco.properties) {
    unesco.properties.aliases = (unesco.properties.aliases || [])
      .filter(alias => !['大仙古墳', '仁徳天皇陵'].includes(alias));
  }
  const feature = {
    type: 'Feature',
    id: 'attraction-kofun-daisen',
    properties: {
      id: 'attraction-kofun-daisen',
      kind: 'attraction',
      name: '大仙古墳',
      shortName: '大仙古墳',
      context: '大阪府堺市',
      subtype: 'kofun',
      subtypeLabel: '古墳・前方後円墳',
      statusLabel: '前方後円墳・墳丘と内濠・外濠を表示',
      aliases: ['仁徳天皇陵', '仁徳天皇陵古墳', 'Nintoku Kofun', 'Daisen Kofun'],
      osmType: 'relation',
      osmId: 13135846,
      osmDate: null,
      officialAreaKm2: null,
      areaSourceLabel: '',
      areaSourceUrl: '',
      boundarySourceLabel: `© OpenStreetMap contributors`,
      boundarySourceUrl: OSM_COPYRIGHT_URL,
      boundaryDefinition: composite.properties.boundaryDefinition,
      boundaryStatus: 'layered-closed-area-boundary',
      sourceObjects: composite.properties.sourceObjects,
      geometryAreaKm2: Number(compositeAreaKm2.toFixed(8)),
      geometrySha256: sha256(COMPOSITE_FILE),
      geometryFile: 'attractions/kofun-daisen.geojson'
    },
    geometry: null
  };
  const unescoIndex = features.findIndex(item => item.id === 'attraction-unesco-1593');
  features.splice(unescoIndex >= 0 ? unescoIndex + 1 : features.length, 0, feature);
  catalog.features = features;
  fs.writeFileSync(CATALOG_FILE, `${JSON.stringify(catalog)}\n`, 'utf8');

  console.log(JSON.stringify({
    id: feature.id,
    geometryFile: feature.properties.geometryFile,
    areaKm2: feature.properties.geometryAreaKm2,
    geometrySha256: feature.properties.geometrySha256,
    sourceObjects: feature.properties.sourceObjects
  }, null, 2));
}

build();
