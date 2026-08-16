const fs = require('fs');
const path = require('path');

const ROOT = process.env.DOKODEMO_NAURU_ROOT
  ? path.resolve(process.env.DOKODEMO_NAURU_ROOT)
  : path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUTPUT_PATH = path.join(ROOT, 'scripts', 'facet-boundary-audit.json');

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function polygonsFromGeometry(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates || []];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates || [];
  return [];
}

function normalizeRadians(value) {
  let normalized = value;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
}

function ringAreaKm2(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
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
  return polygonsFromGeometry(geometry).reduce((sum, polygon) => {
    const outer = ringAreaKm2(polygon[0] || []);
    const holes = polygon.slice(1).reduce((holeSum, ring) => holeSum + ringAreaKm2(ring), 0);
    return sum + Math.max(0, outer - holes);
  }, 0);
}

function geometryCenter(geometry) {
  const points = polygonsFromGeometry(geometry)
    .flatMap(polygon => polygon[0] || []);
  if (!points.length) return null;
  let minimumLongitude = Infinity;
  let maximumLongitude = -Infinity;
  let minimumLatitude = Infinity;
  let maximumLatitude = -Infinity;
  for (const point of points) {
    const longitude = Number(point[0]);
    const latitude = Number(point[1]);
    minimumLongitude = Math.min(minimumLongitude, longitude);
    maximumLongitude = Math.max(maximumLongitude, longitude);
    minimumLatitude = Math.min(minimumLatitude, latitude);
    maximumLatitude = Math.max(maximumLatitude, latitude);
  }
  return [
    (minimumLongitude + maximumLongitude) / 2,
    (minimumLatitude + maximumLatitude) / 2
  ];
}

function geometryBounds(geometry) {
  const points = polygonsFromGeometry(geometry).flatMap(polygon => polygon[0] || []);
  if (!points.length) return null;
  return points.reduce((bounds, point) => [
    Math.min(bounds[0], Number(point[0])),
    Math.min(bounds[1], Number(point[1])),
    Math.max(bounds[2], Number(point[0])),
    Math.max(bounds[3], Number(point[1]))
  ], [Infinity, Infinity, -Infinity, -Infinity]);
}

function distanceKm(first, second) {
  if (!first || !second) return Infinity;
  const radians = value => value * Math.PI / 180;
  const latitudeDelta = radians(second[1] - first[1]);
  const longitudeDelta = radians(second[0] - first[0]);
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(first[1])) * Math.cos(radians(second[1]))
    * Math.sin(longitudeDelta / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function normalizedName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[・･\s　()（）「」『』【】［］\-_]/g, '');
}

function featureRecord(feature) {
  const properties = feature.properties || {};
  const geometryFile = properties.geometryFile;
  const geometryPath = geometryFile && path.join(DATA_DIR, geometryFile);
  const detailed = geometryPath && fs.existsSync(geometryPath)
    ? readJson(geometryPath)
    : null;
  const geometry = detailed && detailed.geometry;
  return {
    id: properties.id || feature.id,
    name: properties.name || '',
    normalizedName: normalizedName(properties.name),
    subtype: properties.subtype || '',
    subtypeLabel: properties.subtypeLabel || '',
    context: properties.context || '',
    osmType: properties.osmType || '',
    osmId: properties.osmId ?? null,
    officialAreaKm2: Number(properties.officialAreaKm2) || null,
    geometryAreaKm2: geometry ? Number(geometryAreaKm2(geometry).toFixed(8)) : null,
    center: geometryCenter(geometry),
    bounds: geometryBounds(geometry),
    geometryFile
  };
}

function nearbyDuplicateGroups(records) {
  const byName = new Map();
  records.forEach(record => {
    if (!record.normalizedName) return;
    const values = byName.get(record.normalizedName) || [];
    values.push(record);
    byName.set(record.normalizedName, values);
  });
  const groups = [];
  for (const values of byName.values()) {
    if (values.length < 2) continue;
    const visited = new Set();
    for (let start = 0; start < values.length; start++) {
      if (visited.has(start)) continue;
      const queue = [start];
      const indexes = [];
      visited.add(start);
      while (queue.length) {
        const current = queue.shift();
        indexes.push(current);
        for (let candidate = 0; candidate < values.length; candidate++) {
          if (visited.has(candidate)) continue;
          if (distanceKm(values[current].center, values[candidate].center) <= 5) {
            visited.add(candidate);
            queue.push(candidate);
          }
        }
      }
      if (indexes.length > 1) {
        groups.push(indexes.map(index => values[index])
          .sort((a, b) => (b.geometryAreaKm2 || 0) - (a.geometryAreaKm2 || 0)));
      }
    }
  }
  return groups.sort((a, b) => b.length - a.length
    || String(a[0].name).localeCompare(String(b[0].name), 'ja'));
}

function isMajorAirportName(record) {
  return /空港/.test(record.name)
    && !/ヘリ|場外|滑空|スカイ|パラグライダー|飛行クラブ/.test(record.name);
}

function nestedCandidates(records) {
  const bySubtype = new Map();
  records.forEach(record => {
    const values = bySubtype.get(record.subtype) || [];
    values.push(record);
    bySubtype.set(record.subtype, values);
  });
  const candidates = [];
  for (const values of bySubtype.values()) {
    for (const smaller of values) {
      if (!smaller.center || !smaller.geometryAreaKm2) continue;
      for (const larger of values) {
        if (larger === smaller || !larger.bounds || !larger.geometryAreaKm2) continue;
        if (larger.geometryAreaKm2 < smaller.geometryAreaKm2 * 1.5) continue;
        const [longitude, latitude] = smaller.center;
        if (longitude < larger.bounds[0] || longitude > larger.bounds[2]
            || latitude < larger.bounds[1] || latitude > larger.bounds[3]) continue;
        if (distanceKm(smaller.center, larger.center) > 10) continue;
        candidates.push({
          subtype: smaller.subtype,
          smaller,
          larger,
          areaRatio: Number((smaller.geometryAreaKm2 / larger.geometryAreaKm2).toFixed(4))
        });
      }
    }
  }
  return candidates.sort((a, b) => a.areaRatio - b.areaRatio);
}

function suspiciousMinimum(record) {
  const thresholds = {
    'national-park': 10,
    'scenic-large': 0.1,
    'large-park': 0.05,
    'large-sports-park': 0.05,
    'industrial-complex': 0.1,
    'large-port': 0.05,
    'large-farm': 0.1,
    'large-mine': 0.05,
    'military-base': 0.02,
    'sports-arena': 0.005,
    'world-heritage': 0.001
  };
  if (record.subtype === 'airport' && isMajorAirportName(record)
      && !record.officialAreaKm2) return 0.1;
  return thresholds[record.subtype] || null;
}

function main() {
  const catalogs = [
    readJson(path.join(DATA_DIR, 'natural-features.geojson')),
    readJson(path.join(DATA_DIR, 'attractions.geojson'))
  ];
  const records = catalogs.flatMap(catalog => catalog.features || []).map(featureRecord);
  const attractionRecords = records.filter(record => record.id.startsWith('attraction-'));
  const duplicateGroups = nearbyDuplicateGroups(attractionRecords);
  const nested = nestedCandidates(attractionRecords);
  const suspiciousSmall = attractionRecords.filter(record => {
    const minimum = suspiciousMinimum(record);
    return minimum && (!Number.isFinite(record.geometryAreaKm2) || record.geometryAreaKm2 < minimum);
  }).map(record => ({ ...record, minimumKm2: suspiciousMinimum(record) }))
    .sort((a, b) => (a.geometryAreaKm2 || 0) - (b.geometryAreaKm2 || 0));
  const officialGeometryMismatches = records.filter(record => {
    if (!record.officialAreaKm2 || !record.geometryAreaKm2) return false;
    const ratio = record.geometryAreaKm2 / record.officialAreaKm2;
    return ratio < 0.2 || ratio > 5;
  }).map(record => ({
    ...record,
    geometryOfficialRatio: Number((record.geometryAreaKm2 / record.officialAreaKm2).toFixed(4))
  })).sort((a, b) => a.geometryOfficialRatio - b.geometryOfficialRatio);

  const payload = {
    generatedAt: new Date().toISOString(),
    summary: {
      total: records.length,
      attractions: attractionRecords.length,
      nearbyDuplicateGroups: duplicateGroups.length,
      nearbyDuplicateRecords: duplicateGroups.reduce((sum, group) => sum + group.length, 0),
      nestedCandidates: nested.length,
      suspiciousSmall: suspiciousSmall.length,
      officialGeometryMismatches: officialGeometryMismatches.length
    },
    nearbyDuplicateGroups: duplicateGroups,
    nestedCandidates: nested,
    suspiciousSmall,
    officialGeometryMismatches
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(payload.summary, null, 2));
}

main();
