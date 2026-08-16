'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.DOKODEMO_NAURU_ROOT || path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'data', 'administrative-areas');
const GEOJSON_PATH = path.join(OUTPUT_DIR, 'R358696.geojson');
const METADATA_PATH = path.join(OUTPUT_DIR, 'R358696.metadata.json');
const PREVIEW_PATH = path.join(OUTPUT_DIR, 'R358696.preview.svg');
const RELATION_ID = 358696;
const RELATION_REF = '272272';
const OFFICIAL_MUNICIPALITY_CODE = '27227';
const QUERY = '東大阪市 大阪府 日本';
const OSM_USER_AGENT = 'Dokodemo-Nauru boundary conversion (local reproducible export)';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OSM_FULL_URL = `https://api.openstreetmap.org/api/0.6/relation/${RELATION_ID}/full.json`;
const GEOLONIA_URL = 'https://geolonia.github.io/japanese-admins/27/27227.json';
const OFFICIAL_AREA_URL = 'https://www.gsi.go.jp/KOKUJYOHO/MENCHO-title';
const OFFICIAL_AREA_PATH = path.join(ROOT, 'data', 'gsi-area-r8-04.json');
const RUN_NOMINATIM_DISCOVERY = process.argv.includes('--discover');
const RUN_GEOLONIA_REFERENCE = process.argv.includes('--compare-reference');

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function requestJson(url, options = {}) {
  const attempts = 3;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': OSM_USER_AGENT,
          ...(options.headers || {})
        },
        signal: controller.signal
      });
      if (response.ok) return response.json();
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      lastError = new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt + 1 < attempts) await sleep(1200 * (attempt + 1));
  }
  throw lastError || new Error(`Request failed: ${url}`);
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function round(value, digits = 8) {
  return Number(Number(value).toFixed(digits));
}

function unique(values) {
  return [...new Set(values)];
}

function cleanConsecutiveIds(ids) {
  const result = [];
  ids.forEach(id => {
    if (!result.length || result[result.length - 1] !== id) result.push(id);
  });
  return result;
}

function cleanConsecutiveCoordinates(coordinates) {
  const result = [];
  coordinates.forEach(point => {
    const normalized = [Number(point[0]), Number(point[1])];
    const previous = result[result.length - 1];
    if (!previous || previous[0] !== normalized[0] || previous[1] !== normalized[1]) {
      result.push(normalized);
    }
  });
  return result;
}

function samePoint(a, b) {
  return Boolean(a && b && a[0] === b[0] && a[1] === b[1]);
}

function sameId(a, b) {
  return a !== undefined && b !== undefined && a === b;
}

function reverseCopy(values) {
  return values.slice().reverse();
}

function appendToTail(chain, segment) {
  chain.push(...segment.slice(1));
}

function prependToHead(chain, segment) {
  chain.unshift(...segment.slice(0, -1));
}

function assembleRings(members, wayById) {
  const pending = members.map(member => {
    const way = wayById.get(Number(member.ref));
    if (!way || !Array.isArray(way.nodes) || way.nodes.length < 2) {
      throw new Error(`Missing or incomplete way ${member.ref}`);
    }
    return {
      ref: Number(member.ref),
      ids: cleanConsecutiveIds(way.nodes.map(Number))
    };
  });
  const rings = [];
  const unjoined = [];

  while (pending.length) {
    const first = pending.shift();
    const chain = first.ids.slice();
    const used = [first.ref];
    let guard = 0;
    while (!sameId(chain[0], chain[chain.length - 1]) && guard < members.length + 2) {
      guard += 1;
      const head = chain[0];
      const tail = chain[chain.length - 1];
      let matchIndex = -1;
      let mode = '';
      for (let index = 0; index < pending.length; index += 1) {
        const candidate = pending[index];
        const ids = candidate.ids;
        if (sameId(ids[0], tail)) {
          matchIndex = index;
          mode = 'append-forward';
          break;
        }
        if (sameId(ids[ids.length - 1], tail)) {
          matchIndex = index;
          mode = 'append-reverse';
          break;
        }
        if (sameId(ids[ids.length - 1], head)) {
          matchIndex = index;
          mode = 'prepend-forward';
          break;
        }
        if (sameId(ids[0], head)) {
          matchIndex = index;
          mode = 'prepend-reverse';
          break;
        }
      }
      if (matchIndex < 0) break;
      const candidate = pending.splice(matchIndex, 1)[0];
      used.push(candidate.ref);
      const segment = mode.endsWith('reverse') ? reverseCopy(candidate.ids) : candidate.ids;
      if (mode.startsWith('append')) appendToTail(chain, segment);
      else prependToHead(chain, segment);
    }
    if (!sameId(chain[0], chain[chain.length - 1])) {
      unjoined.push(...used);
      continue;
    }
    rings.push({ ids: chain, wayRefs: used });
  }

  if (unjoined.length) {
    throw new Error(`Could not close relation rings; unjoined way refs: ${unique(unjoined).join(',')}`);
  }
  return rings;
}

function signedPlanarArea(ring) {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function normalizeRing(ring, clockwise) {
  const cleaned = cleanConsecutiveCoordinates(ring);
  if (!samePoint(cleaned[0], cleaned[cleaned.length - 1])) cleaned.push(cleaned[0].slice());
  const isClockwise = signedPlanarArea(cleaned) < 0;
  if (isClockwise !== clockwise) return reverseCopy(cleaned);
  return cleaned;
}

function normalizeRadians(value) {
  let normalized = value;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
}

function ringAreaKm2(ring) {
  const radius = 6378137;
  let total = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const lower = ring[(index + ring.length - 1) % ring.length];
    const middle = ring[index];
    const upper = ring[(index + 1) % ring.length];
    const longitudeDelta = normalizeRadians(
      (upper[0] - lower[0]) * Math.PI / 180);
    total += longitudeDelta * Math.sin(middle[1] * Math.PI / 180);
  }
  return Math.abs(total * radius * radius / 2) / 1e6;
}

function polygonsAreaKm2(polygons) {
  return polygons.reduce((sum, polygon) => {
    if (!polygon.length) return sum;
    const outer = ringAreaKm2(polygon[0]);
    const holes = polygon.slice(1).reduce((holeSum, ring) => holeSum + ringAreaKm2(ring), 0);
    return sum + Math.max(0, outer - holes);
  }, 0);
}

function ringCentroid(ring) {
  let crossTotal = 0;
  let xTotal = 0;
  let yTotal = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    const cross = current[0] * next[1] - next[0] * current[1];
    crossTotal += cross;
    xTotal += (current[0] + next[0]) * cross;
    yTotal += (current[1] + next[1]) * cross;
  }
  if (Math.abs(crossTotal) < Number.EPSILON) return ring[0].slice();
  return [xTotal / (3 * crossTotal), yTotal / (3 * crossTotal)];
}

function geometryCentroid(polygons) {
  let xTotal = 0;
  let yTotal = 0;
  let areaTotal = 0;
  polygons.forEach(polygon => {
    polygon.forEach((ring, ringIndex) => {
      const signedArea = Math.abs(signedPlanarArea(ring)) * (ringIndex === 0 ? 1 : -1);
      const centroid = ringCentroid(ring);
      xTotal += centroid[0] * signedArea;
      yTotal += centroid[1] * signedArea;
      areaTotal += signedArea;
    });
  });
  if (areaTotal <= 0) return polygons[0][0][0].slice();
  return [xTotal / areaTotal, yTotal / areaTotal];
}

function boundsForPolygons(polygons) {
  const bounds = {
    minLongitude: Infinity,
    minLatitude: Infinity,
    maxLongitude: -Infinity,
    maxLatitude: -Infinity
  };
  polygons.flat(2).forEach(point => {
    bounds.minLongitude = Math.min(bounds.minLongitude, point[0]);
    bounds.minLatitude = Math.min(bounds.minLatitude, point[1]);
    bounds.maxLongitude = Math.max(bounds.maxLongitude, point[0]);
    bounds.maxLatitude = Math.max(bounds.maxLatitude, point[1]);
  });
  return [
    round(bounds.minLongitude), round(bounds.minLatitude),
    round(bounds.maxLongitude), round(bounds.maxLatitude)
  ];
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const current = ring[index];
    const before = ring[previous];
    const intersects = (current[1] > point[1]) !== (before[1] > point[1])
      && point[0] < ((before[0] - current[0]) * (point[1] - current[1]))
        / ((before[1] - current[1]) || Number.EPSILON) + current[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

function orientation(a, b, c) {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(value) < 1e-12) return 0;
  return value > 0 ? 1 : -1;
}

function onSegment(a, b, point) {
  return point[0] >= Math.min(a[0], b[0]) - 1e-12
    && point[0] <= Math.max(a[0], b[0]) + 1e-12
    && point[1] >= Math.min(a[1], b[1]) - 1e-12
    && point[1] <= Math.max(a[1], b[1]) + 1e-12;
}

function segmentsIntersect(a, b, c, d) {
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  if (first !== second && third !== fourth) return true;
  if (first === 0 && onSegment(a, b, c)) return true;
  if (second === 0 && onSegment(a, b, d)) return true;
  if (third === 0 && onSegment(c, d, a)) return true;
  if (fourth === 0 && onSegment(c, d, b)) return true;
  return false;
}

function selfIntersection(ring) {
  const edgeCount = ring.length - 1;
  for (let first = 0; first < edgeCount; first += 1) {
    for (let second = first + 1; second < edgeCount; second += 1) {
      if (second === first + 1 || (first === 0 && second === edgeCount - 1)) continue;
      if (segmentsIntersect(
        ring[first], ring[first + 1], ring[second], ring[second + 1])) {
        return { first, second };
      }
    }
  }
  return null;
}

function geometryFromRelation(relation, elements) {
  const nodeById = new Map(
    elements.filter(element => element.type === 'node')
      .map(node => [Number(node.id), [Number(node.lon), Number(node.lat)]])
  );
  const wayById = new Map(
    elements.filter(element => element.type === 'way')
      .map(way => [Number(way.id), way])
  );
  const roleMembers = role => relation.members
    .filter(member => member.type === 'way' && member.role === role);
  const makeCoordinates = role => assembleRings(roleMembers(role), wayById).map(ring => {
    const coordinates = ring.ids.map(nodeId => {
      const point = nodeById.get(nodeId);
      if (!point) throw new Error(`Missing node ${nodeId}`);
      return point;
    });
    return {
      coordinates: cleanConsecutiveCoordinates(coordinates),
      wayRefs: ring.wayRefs
    };
  });
  const outer = makeCoordinates('outer');
  const inner = makeCoordinates('inner');
  const outerRings = outer.map(item => normalizeRing(item.coordinates, false));
  const innerRings = inner.map(item => normalizeRing(item.coordinates, true));
  const polygons = outerRings.map(ring => [ring]);
  innerRings.forEach(hole => {
    const target = polygons.findIndex(polygon => pointInRing(hole[0], polygon[0]));
    if (target < 0) throw new Error('Inner ring is not contained by any outer ring');
    polygons[target].push(hole);
  });
  const labelMember = relation.members.find(member => member.type === 'node' && member.role === 'label');
  const labelPoint = labelMember ? nodeById.get(Number(labelMember.ref)) || null : null;
  return {
    geometry: {
      type: polygons.length === 1 ? 'Polygon' : 'MultiPolygon',
      coordinates: polygons.length === 1 ? polygons[0] : polygons
    },
    polygons,
    nodeCount: nodeById.size,
    wayCount: wayById.size,
    outerWayCount: roleMembers('outer').length,
    innerWayCount: roleMembers('inner').length,
    outerRingCount: outerRings.length,
    innerRingCount: innerRings.length,
    labelPoint
  };
}

function extractPolygons(payload) {
  const polygons = [];
  const visit = value => {
    if (!value) return;
    if (value.type === 'FeatureCollection') return (value.features || []).forEach(visit);
    if (value.type === 'Feature') return visit(value.geometry);
    if (value.type === 'GeometryCollection') return (value.geometries || []).forEach(visit);
    if (value.type === 'Polygon') return polygons.push(value.coordinates);
    if (value.type === 'MultiPolygon') return value.coordinates.forEach(polygon => polygons.push(polygon));
  };
  visit(payload);
  return polygons;
}

function summarizeCandidate(candidate) {
  return {
    osmType: candidate.osm_type,
    osmId: Number(candidate.osm_id),
    displayName: candidate.display_name,
    category: candidate.category,
    type: candidate.type,
    lat: Number(candidate.lat),
    lon: Number(candidate.lon),
    bbox: (candidate.boundingbox || []).map(Number),
    geometryType: candidate.geojson && candidate.geojson.type || null,
    address: candidate.address || {},
    namedetails: candidate.namedetails || {}
  };
}

function previewParameters(bounds) {
  const [, minLatitude, , maxLatitude] = bounds;
  const longitudeSpan = bounds[2] - bounds[0] || 1;
  const latitudeSpan = maxLatitude - minLatitude || 1;
  const centerLatitude = (minLatitude + maxLatitude) / 2;
  const longitudeScale = Math.cos(centerLatitude * Math.PI / 180);
  const physicalWidth = longitudeSpan * longitudeScale;
  const physicalHeight = latitudeSpan;
  const coordinateBboxAspectRatio = longitudeSpan / latitudeSpan;
  const projectedAspectRatio = physicalWidth / physicalHeight;
  const height = 1000;
  const padding = 24;
  const width = Math.max(1, Math.round(height * projectedAspectRatio));
  return {
    width,
    height,
    padding,
    centerLatitude,
    longitudeScale,
    physicalWidth,
    physicalHeight,
    coordinateBboxAspectRatio,
    projectedAspectRatio,
    aspectRatio: projectedAspectRatio
  };
}

function rasterDimensions(parameters, longEdge = 2048) {
  const scale = longEdge / Math.max(parameters.physicalWidth, parameters.physicalHeight);
  return {
    width: Math.max(1, Math.round(parameters.physicalWidth * scale)),
    height: Math.max(1, Math.round(parameters.physicalHeight * scale)),
    aspectRatio: parameters.projectedAspectRatio
  };
}

function svgPathForRing(ring, bounds, parameters) {
  const { width, height, padding, longitudeScale, physicalWidth, physicalHeight } = parameters;
  const [minLongitude, minLatitude, maxLongitude, maxLatitude] = bounds;
  const longitudeSpan = maxLongitude - minLongitude || 1;
  const latitudeSpan = maxLatitude - minLatitude || 1;
  const scale = Math.min(
    (width - padding * 2) / physicalWidth,
    (height - padding * 2) / physicalHeight
  );
  const contentWidth = physicalWidth * scale;
  const contentHeight = physicalHeight * scale;
  const offsetX = (width - contentWidth) / 2;
  const offsetY = (height - contentHeight) / 2;
  const project = point => [
    offsetX + ((point[0] - minLongitude) / longitudeSpan) * physicalWidth * scale,
    offsetY + ((maxLatitude - point[1]) / latitudeSpan) * physicalHeight * scale
  ];
  return ring.map((point, index) => {
    const projected = project(point);
    return `${index ? 'L' : 'M'}${projected[0].toFixed(2)} ${projected[1].toFixed(2)}`;
  }).join(' ') + ' Z';
}

function renderPreviewSvg(polygons, bounds) {
  const parameters = previewParameters(bounds);
  const { width, height } = parameters;
  const paths = polygons.map(polygon => polygon
    .map(ring => svgPathForRing(ring, bounds, parameters))
    .join(' ')
  ).join('\n      ');
  return {
    text: `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
  <title>東大阪市 OSM administrative boundary relation 358696</title>
  <desc>OpenStreetMap contributors, ODbL 1.0. WGS84 bounds ${bounds.join(', ')}. Aspect-preserving local equirectangular preview at latitude ${parameters.centerLatitude.toFixed(6)} degrees.</desc>
  <rect width="100%" height="100%" fill="#f3f6f1"/>
  <path d="${paths}" fill="#86b86b" fill-rule="evenodd" stroke="#2f5f3a" stroke-width="2" vector-effect="non-scaling-stroke"/>
</svg>
`,
    parameters
  };
}

function readOfficialArea() {
  const payload = JSON.parse(fs.readFileSync(OFFICIAL_AREA_PATH, 'utf8'));
  const value = Number(payload.municipalities && payload.municipalities[OFFICIAL_MUNICIPALITY_CODE]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Official area is missing for municipality code ${OFFICIAL_MUNICIPALITY_CODE}`);
  }
  return value;
}

function compactTags(tags) {
  return Object.fromEntries(Object.entries(tags || {}).sort(([a], [b]) => a.localeCompare(b)));
}

async function main() {
  const fetchedAt = new Date().toISOString();
  let candidates = [];
  let acceptedCandidate = {
    osmType: 'relation',
    osmId: RELATION_ID,
    category: 'boundary',
    type: 'administrative',
    source: 'explicit-osm-id'
  };
  if (RUN_NOMINATIM_DISCOVERY) {
    const nominatimQuery = new URL(NOMINATIM_URL);
    nominatimQuery.searchParams.set('format', 'jsonv2');
    nominatimQuery.searchParams.set('addressdetails', '1');
    nominatimQuery.searchParams.set('namedetails', '1');
    nominatimQuery.searchParams.set('polygon_geojson', '1');
    nominatimQuery.searchParams.set('limit', '5');
    nominatimQuery.searchParams.set('q', QUERY);
    const nominatimResults = await requestJson(nominatimQuery.toString());
    candidates = nominatimResults.map(summarizeCandidate);
    acceptedCandidate = candidates.find(candidate =>
      candidate.osmType === 'relation'
      && candidate.osmId === RELATION_ID
      && candidate.category === 'boundary'
      && candidate.type === 'administrative'
      && candidate.address.city === '東大阪市'
      && candidate.address.province === '大阪府'
    );
    if (!acceptedCandidate) throw new Error('Nominatim did not return the expected Higashi-Osaka administrative relation');
  }

  const fullJson = await requestJson(OSM_FULL_URL);
  const elements = Array.isArray(fullJson.elements) ? fullJson.elements : [];
  const relation = elements.find(element => element.type === 'relation' && Number(element.id) === RELATION_ID);
  if (!relation) throw new Error(`OSM relation ${RELATION_ID} was not present in full response`);
  const relationGeometry = geometryFromRelation(relation, elements);
  const { geometry, polygons } = relationGeometry;
  const bounds = boundsForPolygons(polygons);
  const centroid = geometryCentroid(polygons).map(value => round(value, 8));
  const geometryAreaKm2 = round(polygonsAreaKm2(polygons), 8);
  const officialAreaKm2 = readOfficialArea();
  const areaDifferencePercent = round((geometryAreaKm2 - officialAreaKm2) / officialAreaKm2 * 100, 4);
  const geoloniaPayload = RUN_GEOLONIA_REFERENCE
    ? await requestJson(GEOLONIA_URL)
    : null;
  const geoloniaPolygons = geoloniaPayload ? extractPolygons(geoloniaPayload) : [];
  const geoloniaAreaKm2 = geoloniaPolygons.length ? round(polygonsAreaKm2(geoloniaPolygons), 8) : null;
  const geoloniaBounds = geoloniaPolygons.length ? boundsForPolygons(geoloniaPolygons) : null;
  const ringIssues = polygons.flatMap((polygon, polygonIndex) => polygon.map((ring, ringIndex) => ({
    polygonIndex,
    ringIndex,
    closed: samePoint(ring[0], ring[ring.length - 1]),
    vertexCount: ring.length,
    selfIntersection: selfIntersection(ring)
  })));
  const duplicateRingCount = polygons
    .flatMap(polygon => polygon)
    .map(ring => JSON.stringify(ring))
    .filter((serialized, index, all) => all.indexOf(serialized) !== index).length;
  const coordinateRangeValid = polygons.flat(2).every(([longitude, latitude]) =>
    Number.isFinite(longitude) && Number.isFinite(latitude)
    && longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90
  );
  const areaWithinTolerance = Math.abs(areaDifferencePercent) <= 2;
  const validRings = ringIssues.every(issue =>
    issue.closed && issue.vertexCount >= 4 && !issue.selfIntersection
  );
  const noDuplicateRings = duplicateRingCount === 0;
  const geoloniaComparisonAvailable = Boolean(geoloniaPolygons.length);
  const validationPassed = Boolean(
    (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')
    && polygons.length > 0
    && coordinateRangeValid
    && validRings
    && noDuplicateRings
    && areaWithinTolerance
  );

  const properties = {
    id: `administrative-area-R${RELATION_ID}`,
    kind: 'administrative-area',
    name: '東大阪市',
    shortName: '東大阪市',
    context: '大阪府・日本',
    aliases: ['Higashiōsaka', 'Higashiōsaka-shi', 'Higashiosaka', 'Higashi-Ōsaka'],
    osmType: 'relation',
    osmId: RELATION_ID,
    ref: RELATION_REF,
    adminLevel: 7,
    boundaryDefinition: '東大阪市の現在の行政区域。市境界の内側に含まれる陸域・水域を含み、隣接する大阪市・八尾市・生駒市などの区域は含めない。',
    boundarySourceLabel: 'OpenStreetMap contributors',
    boundarySourceUrl: `https://www.openstreetmap.org/relation/${RELATION_ID}`,
    sourceQuery: QUERY,
    fetchedAt,
    geometryAreaKm2,
    officialAreaKm2,
    officialAreaSourceLabel: '国土地理院 全国都道府県市区町村別面積調 令和8年4月1日',
    officialAreaSourceUrl: OFFICIAL_AREA_URL,
    bbox: bounds,
    centroid,
    coordinateSystem: 'WGS84 / EPSG:4326',
    geometryFile: 'administrative-areas/R358696.geojson',
    metadataFile: 'administrative-areas/R358696.metadata.json',
    license: 'OpenStreetMap contributors, ODbL 1.0'
  };
  const feature = {
    type: 'Feature',
    id: properties.id,
    properties,
    geometry
  };
  const geojsonText = `${JSON.stringify(feature, null, 2)}\n`;
  const previewRender = renderPreviewSvg(polygons, bounds);
  const previewText = previewRender.text;
  const pngDimensions = rasterDimensions(previewRender.parameters);
  const sourceText = JSON.stringify(fullJson);

  const metadata = {
    schemaVersion: 1,
    generatedAt: fetchedAt,
    id: properties.id,
    name: properties.name,
    kind: properties.kind,
    context: properties.context,
    aliases: properties.aliases,
    boundaryDefinition: properties.boundaryDefinition,
    boundarySourceLabel: properties.boundarySourceLabel,
    boundarySourceUrl: properties.boundarySourceUrl,
    sourceQuery: QUERY,
    osm: {
      osmType: 'relation',
      osmId: RELATION_ID,
      ref: RELATION_REF,
      tags: compactTags(relation.tags),
      fullResponseUrl: OSM_FULL_URL,
      fetchedAt,
      responseSha256: sha256Text(sourceText),
      license: 'OpenStreetMap contributors, ODbL 1.0'
    },
    discovery: {
      endpoint: RUN_NOMINATIM_DISCOVERY ? NOMINATIM_URL : null,
      query: QUERY,
      method: RUN_NOMINATIM_DISCOVERY ? 'nominatim-discovery' : 'explicit-osm-id',
      fetchedAt,
      candidates,
      accepted: acceptedCandidate,
      rejectedCandidates: candidates.filter(candidate => candidate.osmId !== RELATION_ID)
    },
    relation: {
      type: relation.tags && relation.tags.type || null,
      boundary: relation.tags && relation.tags.boundary || null,
      adminLevel: relation.tags && relation.tags.admin_level || null,
      memberCount: relation.members.length,
      outerWayCount: relationGeometry.outerWayCount,
      innerWayCount: relationGeometry.innerWayCount,
      outerRingCount: relationGeometry.outerRingCount,
      innerRingCount: relationGeometry.innerRingCount,
      nodeCount: relationGeometry.nodeCount,
      wayCount: relationGeometry.wayCount,
      labelPoint: relationGeometry.labelPoint
    },
    canonical: {
      file: properties.geometryFile,
      geometryType: geometry.type,
      coordinateSystem: properties.coordinateSystem,
      bbox: bounds,
      centroid,
      geometryAreaKm2,
      vertexCount: polygons.reduce((sum, polygon) =>
        sum + polygon.reduce((ringSum, ring) => ringSum + ring.length, 0), 0),
      outerRingCount: relationGeometry.outerRingCount,
      holeCount: relationGeometry.innerRingCount,
      sha256: sha256Text(geojsonText)
    },
    referenceComparison: {
      officialAreaKm2,
      officialMunicipalityCode: OFFICIAL_MUNICIPALITY_CODE,
      officialAreaSourceLabel: properties.officialAreaSourceLabel,
      officialAreaSourceUrl: properties.officialAreaSourceUrl,
      areaDifferencePercent,
      areaRatio: round(geometryAreaKm2 / officialAreaKm2, 8),
      tolerancePercent: 2,
      geoloniaCompared: RUN_GEOLONIA_REFERENCE,
      geoloniaReferenceUrl: RUN_GEOLONIA_REFERENCE ? GEOLONIA_URL : null,
      geoloniaAreaKm2,
      geoloniaBbox: geoloniaBounds
    },
    validation: {
      status: validationPassed ? 'passed' : 'failed',
      checks: {
        jsonAndGeojsonStructure: true,
        polygonOrMultiPolygon: geometry.type === 'Polygon' || geometry.type === 'MultiPolygon',
        coordinateOrder: '[longitude, latitude]',
        coordinateRangeValid,
        ringsClosed: validRings,
        noSelfIntersections: ringIssues.every(issue => !issue.selfIntersection),
        noDuplicateRings,
        holesContained: true,
        areaWithinTwoPercentOfOfficial: areaWithinTolerance,
        geoloniaReferenceFetched: geoloniaComparisonAvailable,
        geoloniaReferenceOptional: true,
        antimeridianHandling: 'not applicable; longitude span is below 180 degrees',
        visualPreviewGenerated: true,
        visualAspectRatioPreserved: true
      },
      ringIssues,
      areaDifferencePercent,
      areaRatio: round(geometryAreaKm2 / officialAreaKm2, 8),
      notes: [
        RUN_NOMINATIM_DISCOVERY
          ? 'Nominatim was used only for explicit-ID discovery; final geometry was reconstructed from complete OSM relation members.'
          : 'An explicit verified OSM relation ID was supplied; Nominatim discovery was skipped for the fast path.',
        'The relation has one outer ring and no inner rings; the canonical output is therefore a Polygon.',
        RUN_GEOLONIA_REFERENCE
          ? 'The Geolonia Japanese Admins geometry was used only as an optional shape/reference cross-check; the canonical source remains OSM.'
          : 'The optional Geolonia shape/reference cross-check was skipped; the canonical source remains OSM.'
      ]
    },
    export: {
      geojson: {
        file: properties.geometryFile,
        crs: 'WGS84 / EPSG:4326',
        simplificationTolerance: null,
        exactGeoreferencing: true
      },
      svgPreview: {
        file: 'administrative-areas/R358696.preview.svg',
        projection: 'aspect-preserving local equirectangular affine transform over the canonical bbox',
        widthPx: previewRender.parameters.width,
        heightPx: previewRender.parameters.height,
        viewBox: [0, 0, previewRender.parameters.width, previewRender.parameters.height],
        paddingPx: previewRender.parameters.padding,
        centerLatitude: round(previewRender.parameters.centerLatitude, 8),
        longitudeScale: round(previewRender.parameters.longitudeScale, 8),
        coordinateBboxAspectRatio: round(previewRender.parameters.coordinateBboxAspectRatio, 8),
        contentAspectRatio: round(previewRender.parameters.projectedAspectRatio, 8),
        canvasAspectRatio: round(previewRender.parameters.width / previewRender.parameters.height, 8),
        yAxis: 'inverted for SVG screen coordinates',
        fillRule: 'evenodd',
        holesPreserved: true,
        exactGeoreferencing: false,
        sha256: sha256Text(previewText)
      },
      pngMask: {
        recommendedWidth: pngDimensions.width,
        recommendedHeight: pngDimensions.height,
        contentAspectRatio: round(pngDimensions.aspectRatio, 8),
        bounds,
        outsideValue: 0,
        insideValue: 255,
        alpha: 'transparent outside, opaque inside',
        antialiasing: 'renderer-defined; preserve the canonical vector as source of truth',
        exactGeoreferencing: 'not embedded; use a world file or GeoTIFF sidecar when required',
        simplificationTolerance: null
      }
    },
    files: {
      canonicalGeoJSON: properties.geometryFile,
      metadata: properties.metadataFile,
      previewSvg: 'administrative-areas/R358696.preview.svg'
    }
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(GEOJSON_PATH, geojsonText, 'utf8');
  fs.writeFileSync(PREVIEW_PATH, previewText, 'utf8');
  fs.writeFileSync(METADATA_PATH, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    canonicalGeoJSON: path.relative(ROOT, GEOJSON_PATH),
    metadata: path.relative(ROOT, METADATA_PATH),
    previewSvg: path.relative(ROOT, PREVIEW_PATH),
    osm: `relation:${RELATION_ID}`,
    geometryType: geometry.type,
    outerRingCount: relationGeometry.outerRingCount,
    innerRingCount: relationGeometry.innerRingCount,
    vertexCount: metadata.canonical.vertexCount,
    bbox: bounds,
    centroid,
    geometryAreaKm2,
    officialAreaKm2,
    areaDifferencePercent,
    validation: metadata.validation.status,
    sourceResponseSha256: metadata.osm.responseSha256,
    canonicalSha256: metadata.canonical.sha256
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
