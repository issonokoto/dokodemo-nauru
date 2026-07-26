const fs = require('fs');
const path = require('path');

const ROOT = process.env.DOKODEMO_NAURU_ROOT
  ? path.resolve(process.env.DOKODEMO_NAURU_ROOT)
  : path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'data', 'attractions.geojson');
const WDPA_LAYER_URL =
  'https://services5.arcgis.com/Mj0hjvkNtV7NRhA7/arcgis/rest/services/WDPA_v0/FeatureServer/1';
const WDPA_INFO_URL = 'https://www.protectedplanet.net/en/thematic-areas/wdpa';
const SIMPLIFY_TOLERANCE = 0.0005;

const PARKS = [
  {
    name: '吉野熊野国立公園',
    sourceName: '吉野熊野',
    id: 'attraction-national-park-W979504733',
    context: '三重県・奈良県・和歌山県',
    officialAreaKm2: 960.52,
    areaSourceLabel: '環境省「吉野熊野国立公園」陸域・海域面積',
    areaSourceUrl: 'https://www.env.go.jp/park/yoshino/intro/index.html'
  },
  {
    name: '三陸復興国立公園',
    sourceName: '三陸復興',
    id: 'attraction-national-park-W761166517',
    context: '青森県・岩手県・宮城県',
    officialAreaKm2: 1013.74,
    areaSourceLabel: '環境省「三陸復興国立公園」陸域・海域面積',
    areaSourceUrl: 'https://tohoku.env.go.jp/park.html'
  }
];

function squaredDistance(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function squaredSegmentDistance(point, start, end) {
  let x = start[0];
  let y = start[1];
  let dx = end[0] - x;
  let dy = end[1] - y;
  if (dx || dy) {
    const ratio = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
    if (ratio > 1) {
      x = end[0];
      y = end[1];
    } else if (ratio > 0) {
      x += dx * ratio;
      y += dy * ratio;
    }
  }
  dx = point[0] - x;
  dy = point[1] - y;
  return dx * dx + dy * dy;
}

function simplifyStep(points, first, last, toleranceSquared, simplified) {
  let maxDistance = toleranceSquared;
  let index = -1;
  for (let cursor = first + 1; cursor < last; cursor++) {
    const distance = squaredSegmentDistance(points[cursor], points[first], points[last]);
    if (distance > maxDistance) {
      index = cursor;
      maxDistance = distance;
    }
  }
  if (index < 0) return;
  if (index - first > 1) simplifyStep(points, first, index, toleranceSquared, simplified);
  simplified.push(points[index]);
  if (last - index > 1) simplifyStep(points, index, last, toleranceSquared, simplified);
}

function simplifyOpenLine(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const toleranceSquared = tolerance * tolerance;
  const radial = [points[0]];
  let previous = points[0];
  for (let index = 1; index < points.length; index++) {
    if (squaredDistance(points[index], previous) > toleranceSquared) {
      radial.push(points[index]);
      previous = points[index];
    }
  }
  if (previous !== points[points.length - 1]) radial.push(points[points.length - 1]);
  if (radial.length <= 2) return radial;
  const simplified = [radial[0]];
  simplifyStep(radial, 0, radial.length - 1, toleranceSquared, simplified);
  simplified.push(radial[radial.length - 1]);
  return simplified;
}

function simplifyRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const open = ring.slice(0, -1);
  const simplified = simplifyOpenLine(open, SIMPLIFY_TOLERANCE)
    .map(([longitude, latitude]) => [
      Number(Number(longitude).toFixed(6)),
      Number(Number(latitude).toFixed(6))
    ]);
  if (simplified.length < 3) return null;
  simplified.push(simplified[0].slice());
  return simplified;
}

function simplifyGeometry(geometry) {
  const simplifyPolygon = polygon => polygon.map(simplifyRing).filter(Boolean);
  if (geometry.type === 'Polygon') {
    return { type: 'Polygon', coordinates: simplifyPolygon(geometry.coordinates) };
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map(simplifyPolygon).filter(polygon => polygon.length)
    };
  }
  throw new Error(`Unsupported WDPA geometry type: ${geometry.type}`);
}

function normalizeRadians(value) {
  let normalized = value;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
}

function ringAreaKm2(ring) {
  const radius = 6378137;
  const radians = value => Number(value) * Math.PI / 180;
  let total = 0;
  for (let index = 0; index < ring.length; index++) {
    const lower = ring[(index + ring.length - 1) % ring.length];
    const middle = ring[index];
    const upper = ring[(index + 1) % ring.length];
    const delta = normalizeRadians(radians(upper[0]) - radians(lower[0]));
    total += delta * Math.sin(radians(middle[1]));
  }
  return Math.abs(total * radius * radius / 2) / 1e6;
}

function geometryAreaKm2(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((total, polygon) => {
    const outer = ringAreaKm2(polygon[0] || []);
    const holes = polygon.slice(1).reduce((sum, ring) => sum + ringAreaKm2(ring), 0);
    return total + Math.max(0, outer - holes);
  }, 0);
}

async function fetchBoundaries() {
  const names = PARKS.map(park => `'${park.sourceName}'`).join(',');
  const params = new URLSearchParams({
    where: `name IN (${names})`,
    outFields: 'name,rep_area,rep_m_area,gis_area,gis_m_area',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson'
  });
  const response = await fetch(`${WDPA_LAYER_URL}/query?${params}`);
  if (!response.ok) throw new Error(`WDPA request failed: ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.features)) {
    throw new Error('WDPA response did not contain a FeatureCollection');
  }
  return payload.features;
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const boundaries = await fetchBoundaries();
  for (const park of PARKS) {
    const boundary = boundaries.find(feature =>
      feature.properties && feature.properties.name === park.sourceName);
    if (!boundary || !boundary.geometry) throw new Error(`WDPA boundary not found: ${park.name}`);
    const geometry = simplifyGeometry(boundary.geometry);
    const sourceArea = geometryAreaKm2(boundary.geometry);
    const simplifiedArea = geometryAreaKm2(geometry);
    if (sourceArea < 100 || simplifiedArea < 100) {
      throw new Error(`National park boundary is implausibly small: ${park.name}`);
    }
    const ratio = simplifiedArea / sourceArea;
    if (ratio < 0.97 || ratio > 1.03) {
      throw new Error(`Simplification changed area too much: ${park.name} (${ratio})`);
    }
    const catalogFeature = catalog.features.find(feature =>
      feature.id === park.id || feature.properties && feature.properties.id === park.id);
    if (!catalogFeature) throw new Error(`Catalog feature not found: ${park.id}`);
    const properties = {
      ...catalogFeature.properties,
      context: park.context,
      statusLabel: '環境省指定国立公園／陸域・海域を含む区域',
      osmType: 'composite',
      osmId: null,
      officialAreaKm2: park.officialAreaKm2,
      areaSourceLabel: park.areaSourceLabel,
      areaSourceUrl: park.areaSourceUrl,
      boundarySourceLabel: 'Protected Planet / WDPA（環境省提供データ）',
      boundarySourceUrl: WDPA_INFO_URL
    };
    catalogFeature.properties = properties;
    const geometryPath = path.join(ROOT, 'data', properties.geometryFile);
    const detailedFeature = {
      type: 'Feature',
      id: park.id,
      properties,
      geometry
    };
    fs.writeFileSync(geometryPath, `${JSON.stringify(detailedFeature)}\n`, 'utf8');
    console.log(`${park.name}: official=${park.officialAreaKm2.toFixed(2)}km2 `
      + `geometry=${simplifiedArea.toFixed(2)}km2 source=${sourceArea.toFixed(2)}km2`);
  }
  fs.writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog)}\n`, 'utf8');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
