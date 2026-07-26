const fs = require('fs');
const path = require('path');

const ROOT = process.env.DOKODEMO_NAURU_ROOT
  ? path.resolve(process.env.DOKODEMO_NAURU_ROOT)
  : path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUTPUT_PATH = path.join(DATA_DIR, 'search-area-index.json');
const AUDIT_PATH = path.join(ROOT, 'scripts', 'search-facets-audit.json');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function polygonGroups(value) {
  const polygons = [];
  const visit = item => {
    if (!item) return;
    if (item.type === 'FeatureCollection') {
      (item.features || []).forEach(visit);
    } else if (item.type === 'Feature') {
      visit(item.geometry);
    } else if (item.type === 'GeometryCollection') {
      (item.geometries || []).forEach(visit);
    } else if (item.type === 'Polygon') {
      polygons.push(item.coordinates || []);
    } else if (item.type === 'MultiPolygon') {
      (item.coordinates || []).forEach(polygon => polygons.push(polygon));
    }
  };
  visit(value);
  return polygons.filter(polygon =>
    polygon.some(ring => Array.isArray(ring) && ring.length >= 3));
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
  const toRadians = value => Number(value) * Math.PI / 180;
  let total = 0;
  for (let index = 0; index < ring.length; index++) {
    const lower = ring[(index + ring.length - 1) % ring.length];
    const middle = ring[index];
    const upper = ring[(index + 1) % ring.length];
    const longitudeDelta = normalizeRadians(
      toRadians(upper[0]) - toRadians(lower[0]));
    total += longitudeDelta * Math.sin(toRadians(middle[1]));
  }
  return Math.abs(total * radius * radius / 2) / 1e6;
}

function polygonsAreaKm2(polygons) {
  return polygons.reduce((sum, polygon) => {
    if (!polygon || !polygon.length) return sum;
    const outer = ringAreaKm2(polygon[0]);
    const holes = polygon.slice(1)
      .reduce((holeSum, ring) => holeSum + ringAreaKm2(ring), 0);
    return sum + Math.max(0, outer - holes);
  }, 0);
}

function roundedArea(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Number(value.toFixed(8));
}

function featureArea(feature) {
  const properties = feature && feature.properties || {};
  const geometryFile = properties.geometryFile;
  let geometryArea = null;
  if (geometryFile) {
    const geometryPath = path.join(DATA_DIR, geometryFile);
    if (fs.existsSync(geometryPath)) {
      const geometry = readJson(path.join('data', geometryFile));
      geometryArea = roundedArea(polygonsAreaKm2(polygonGroups(geometry)));
    }
  }
  if (properties.subtype === 'national-park'
      && (!Number.isFinite(geometryArea) || geometryArea < 10)) {
    throw new Error(
      `National park geometry is implausibly small: ${properties.name || properties.id} `
      + `(${geometryArea === null ? 'missing' : geometryArea} km²)`
    );
  }
  const official = Number(properties.officialAreaKm2);
  if (Number.isFinite(official) && official > 0) {
    return { area: roundedArea(official), source: 'official' };
  }
  if (!geometryFile) return { area: null, source: 'missing-geometry-file' };
  if (geometryArea === null) return { area: null, source: 'missing-geometry' };
  return {
    area: geometryArea,
    source: 'geometry'
  };
}

function createTopologyDecoder(topology) {
  const transform = topology.transform || {};
  const scale = transform.scale || [1, 1];
  const translate = transform.translate || [0, 0];
  const cache = new Map();
  const decodeArc = rawIndex => {
    const reversed = rawIndex < 0;
    const index = reversed ? ~rawIndex : rawIndex;
    if (!cache.has(index)) {
      let x = 0;
      let y = 0;
      const points = (topology.arcs[index] || []).map(([dx, dy]) => {
        x += Number(dx);
        y += Number(dy);
        return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
      });
      cache.set(index, points);
    }
    const points = cache.get(index);
    return reversed ? points.slice().reverse() : points;
  };
  const decodeRing = arcIndexes => {
    const ring = [];
    (arcIndexes || []).forEach(rawIndex => {
      const points = decodeArc(rawIndex);
      ring.push(...(ring.length ? points.slice(1) : points));
    });
    return ring;
  };
  return geometry => {
    if (geometry.type === 'Polygon') {
      return { type: 'Polygon', coordinates: (geometry.arcs || []).map(decodeRing) };
    }
    if (geometry.type === 'MultiPolygon') {
      return {
        type: 'MultiPolygon',
        coordinates: (geometry.arcs || []).map(polygon =>
          polygon.map(decodeRing))
      };
    }
    return null;
  };
}

function featureId(feature) {
  const properties = feature && feature.properties || {};
  return properties.id || feature.id || '';
}

function auditCatalog(label, collection, administrativePlaces, areas) {
  const result = {
    total: 0,
    missingName: [],
    missingGeometry: [],
    missingArea: [],
    missingAdministrativeRecord: [],
    missingPrefecture: [],
    missingMunicipality: []
  };
  for (const feature of collection.features || []) {
    const properties = feature && feature.properties || {};
    const id = featureId(feature);
    result.total += 1;
    if (!properties.name) result.missingName.push(id);
    if (!properties.geometryFile && !feature.geometry) result.missingGeometry.push(id);
    if (!(Number(areas[id]) > 0)) result.missingArea.push(id);
    if (label !== 'countries') {
      const administrative = administrativePlaces[id];
      if (!administrative) result.missingAdministrativeRecord.push(id);
      if (!(administrative && administrative.prefectures &&
        administrative.prefectures.length)) result.missingPrefecture.push(id);
      if (!(administrative && administrative.municipalities &&
        administrative.municipalities.length)) result.missingMunicipality.push(id);
    }
  }
  return result;
}

function build() {
  const countries = readJson('data/countries.geojson');
  const natural = readJson('data/natural-features.geojson');
  const attractions = readJson('data/attractions.geojson');
  const administrative = readJson('data/place-administrative-areas.json');
  const topology = readJson('data/jp-city-1995.topojson');
  const featureAreas = {};
  const areaSources = { official: 0, geometry: 0 };
  const missingFeatureAreas = [];

  for (const collection of [countries, natural, attractions]) {
    for (const feature of collection.features || []) {
      const id = featureId(feature);
      const result = featureArea(feature);
      if (result.area) {
        featureAreas[id] = result.area;
        areaSources[result.source] = (areaSources[result.source] || 0) + 1;
      } else {
        missingFeatureAreas.push(id);
      }
    }
  }

  const historicalMunicipalityAreas = {};
  const historicalMissingAreas = [];
  const geometries = topology.objects && topology.objects.city &&
    topology.objects.city.geometries || [];
  const decodeGeometry = createTopologyDecoder(topology);
  geometries.forEach((geometry, topologyIndex) => {
    const properties = geometry && geometry.properties || {};
    const municipality = String(properties.N03_004 || '');
    if (!municipality || municipality === '所属未定地') return;
    const geoshapeId = String(properties.id || geometry.id || `1995-${topologyIndex}`);
    const area = roundedArea(polygonsAreaKm2(polygonGroups(decodeGeometry(geometry))));
    if (area) historicalMunicipalityAreas[geoshapeId] = area;
    else historicalMissingAreas.push(geoshapeId);
  });

  const subtypeSummary = {};
  for (const feature of attractions.features || []) {
    const properties = feature && feature.properties || {};
    const subtype = properties.subtype || '(missing)';
    const key = `${subtype}\t${properties.subtypeLabel || ''}`;
    if (!subtypeSummary[key]) {
      subtypeSummary[key] = {
        subtype,
        label: properties.subtypeLabel || '',
        count: 0
      };
    }
    subtypeSummary[key].count += 1;
  }

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    featureAreas,
    historicalMunicipalityAreas
  };
  const audit = {
    generatedAt: output.generatedAt,
    areaCoverage: {
      featureTotal: countries.features.length + natural.features.length +
        attractions.features.length,
      featureWithArea: Object.keys(featureAreas).length,
      featureMissingArea: missingFeatureAreas,
      historicalMunicipalityTotal: Object.keys(historicalMunicipalityAreas).length +
        historicalMissingAreas.length,
      historicalMunicipalityWithArea: Object.keys(historicalMunicipalityAreas).length,
      historicalMunicipalityMissingArea: historicalMissingAreas,
      sources: areaSources
    },
    catalogs: {
      countries: auditCatalog(
        'countries', countries, administrative.places || {}, featureAreas),
      natural: auditCatalog(
        'natural', natural, administrative.places || {}, featureAreas),
      attractions: auditCatalog(
        'attractions', attractions, administrative.places || {}, featureAreas)
    },
    attractionCategories: Object.values(subtypeSummary)
      .sort((a, b) => a.label.localeCompare(b.label, 'ja'))
  };

  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output)}\n`);
  fs.writeFileSync(AUDIT_PATH, `${JSON.stringify(audit, null, 2)}\n`);
  console.log(JSON.stringify({
    output: path.relative(ROOT, OUTPUT_PATH),
    audit: path.relative(ROOT, AUDIT_PATH),
    featureAreas: Object.keys(featureAreas).length,
    missingFeatureAreas: missingFeatureAreas.length,
    historicalMunicipalityAreas: Object.keys(historicalMunicipalityAreas).length,
    historicalMissingAreas: historicalMissingAreas.length,
    attractionCategories: audit.attractionCategories.length
  }, null, 2));
}

build();
