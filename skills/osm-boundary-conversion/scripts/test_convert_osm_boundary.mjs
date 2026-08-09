import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SVG_MAX_QUANTIZATION_ERROR_PX,
  assembledCoastlineRings,
  buildCoastlineIndex,
  canonicalRingKey,
  coastlinePath,
  defaultBoundaryDefinitionForKind,
  fetchOverpassJson,
  parseArgs,
  polygonsAreaOverlap,
  rasterDimensions,
  relationBoundaryQuery,
  relationGeometry,
  relationHasMaritimeOuter,
  relationHasResolvableOuter,
  ringContainedByPolygon,
  selectCandidate,
  selfIntersectionDetails,
  svgQuantizationErrorPx,
  svgText,
  svgTransform,
  validateGeometryIntegrity,
} from './convert_osm_boundary.mjs';

const close = (points) => [...points, [...points[0]]];

test('CLI rejects unknown options and missing values', () => {
  assert.throws(() => parseArgs(['--wat']), /Unknown option/);
  assert.throws(() => parseArgs(['--name']), /requires a value/);
  assert.deepEqual(parseArgs(['--name', '淡路島', '--cache-dir', '.cache', '--deep']), { name: '淡路島', 'cache-dir': '.cache', deep: true });
});

test('hedged Overpass fetch accepts the first success and cancels slower requests', async () => {
  const fetcher = (url, { signal }) => {
    if (url === 'fast') return Promise.resolve({ json: { ok: true }, text: '{"ok":true}' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ json: { slow: true }, text: '{"slow":true}' }), 100);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        const error = new Error('cancelled');
        error.code = 'ECANCELLED';
        reject(error);
      }, { once: true });
    });
  };
  const result = await fetchOverpassJson('query', { endpoints: ['slow', 'fast'], hedgeDelayMs: 1, fetcher });
  assert.equal(result.url, 'fast');
  assert.deepEqual(result.json, { ok: true });
  assert.equal(result.attempts.find((attempt) => attempt.url === 'slow').status, 'cancelled');
  assert.equal(result.attempts.find((attempt) => attempt.url === 'fast').status, 'succeeded');
});

test('candidate selection requires the complete supplied context', () => {
  const candidates = [
    { osm_type: 'relation', osm_id: 1, name: '同名市', display_name: '同名市, 大阪府, 日本', category: 'boundary', type: 'administrative', address: { province: '大阪府', country: '日本' } },
    { osm_type: 'relation', osm_id: 2, name: '同名市', display_name: '同名市, 兵庫県, 日本', category: 'boundary', type: 'administrative', address: { province: '兵庫県', country: '日本' } },
  ];
  assert.equal(selectCandidate(candidates, '同名市', '兵庫県 日本', 'administrative-area').osm_id, 2);
  assert.equal(selectCandidate(candidates, '同名市', '香川県 日本', 'administrative-area'), null);
});

test('ring identity is independent of start point and direction', () => {
  const ring = close([[0, 0], [3, 0], [3, 2], [0, 2]]);
  const rotated = close([[3, 2], [0, 2], [0, 0], [3, 0]]);
  const reversed = close([[0, 0], [0, 2], [3, 2], [3, 0]]);
  assert.equal(canonicalRingKey(ring), canonicalRingKey(rotated));
  assert.equal(canonicalRingKey(ring), canonicalRingKey(reversed));
});

test('coastline islands assembled from several open ways become one ring', () => {
  const response = { elements: [
    { type: 'way', id: 10, geometry: [{ lon: 0, lat: 0 }, { lon: 1, lat: 0 }] },
    { type: 'way', id: 11, geometry: [{ lon: 1, lat: 0 }, { lon: 1, lat: 1 }] },
    { type: 'way', id: 12, geometry: [{ lon: 1, lat: 1 }, { lon: 0, lat: 1 }] },
    { type: 'way', id: 13, geometry: [{ lon: 0, lat: 1 }, { lon: 0, lat: 0 }] },
  ] };
  const assembled = assembledCoastlineRings(buildCoastlineIndex(response));
  assert.equal(assembled.joinedRingCount, 1);
  assert.equal(assembled.joinedWayCount, 4);
  assert.equal(assembled.rings.length, 1);
  assert.deepEqual(assembled.rings[0].ring[0], assembled.rings[0].ring.at(-1));
});

test('coastline routing follows OSM direction and supports a closed way', () => {
  const index = buildCoastlineIndex({ elements: [
    { type: 'way', id: 10, geometry: [
      { lon: 0, lat: 0 }, { lon: 1, lat: 0 }, { lon: 1, lat: 1 }, { lon: 0, lat: 1 }, { lon: 0, lat: 0 },
    ] },
  ] });
  const route = coastlinePath(
    index,
    { wayId: '10', segmentIndex: 0, t: 0.25, point: [0.25, 0] },
    { wayId: '10', segmentIndex: 0, t: 0.75, point: [0.75, 0] },
  );
  assert.deepEqual(route, [[0.25, 0], [0.75, 0]]);
});

test('island containment respects holes instead of treating an outer ring as solid', () => {
  const polygon = [
    close([[0, 0], [10, 0], [10, 10], [0, 10]]),
    close([[4, 4], [4, 6], [6, 6], [6, 4]]),
  ];
  assert.equal(ringContainedByPolygon(close([[1, 1], [2, 1], [2, 2], [1, 2]]), polygon), true);
  assert.equal(ringContainedByPolygon(close([[4.5, 4.5], [5.5, 4.5], [5.5, 5.5], [4.5, 5.5]]), polygon), false);
});

test('subarea overlap detection permits shared borders but rejects shared area', () => {
  const left = [close([[0, 0], [1, 0], [1, 1], [0, 1]])];
  const adjacent = [close([[1, 0], [2, 0], [2, 1], [1, 1]])];
  const overlapping = [close([[0.5, 0], [1.5, 0], [1.5, 1], [0.5, 1]])];
  assert.equal(polygonsAreaOverlap(left, adjacent), false);
  assert.equal(polygonsAreaOverlap(left, overlapping), true);
});

test('spatial self-intersection scan finds crossings without collinear false positives', () => {
  const bowTie = close([[0, 0], [2, 2], [0, 2], [2, 0]]);
  assert.deepEqual(selfIntersectionDetails(bowTie).map(({ segmentA, segmentB, kind }) => ({ segmentA, segmentB, kind })), [
    { segmentA: 0, segmentB: 2, kind: 'proper-crossing' },
  ]);
  const nearlyCollinear = [[135.269014, 34.848242], [135.269033, 34.848241], [135.269034, 34.848241], [135.269153, 34.848238]];
  assert.equal(selfIntersectionDetails(nearlyCollinear, false).length, 0);
});

test('relation query starts with the parent and expands to direct subareas only on demand', () => {
  const query = relationBoundaryQuery(900329);
  assert.match(query, /relation\(900329\)->\.root/);
  assert.ok(!query.includes('"subarea"'));
  assert.ok(!query.includes('>>'));
  const expanded = relationBoundaryQuery(900329, { includeDirectSubareas: true });
  assert.match(expanded, /relation\(r\.root:"subarea"\)/);
  assert.ok(!expanded.includes('>>'));
});

test('maritime detection traverses direct subareas', () => {
  const full = { elements: [
    { type: 'relation', id: 1, members: [{ type: 'relation', ref: 2, role: 'subarea' }] },
    { type: 'relation', id: 2, members: [{ type: 'way', ref: 20, role: 'outer' }] },
    { type: 'way', id: 20, tags: { maritime: 'yes' }, nodes: [1, 2] },
  ] };
  assert.equal(relationHasMaritimeOuter(full, 1), true);
});

test('parent-only fetch is accepted only when every outer way node is present', () => {
  const complete = { elements: [
    { type: 'node', id: 1, lon: 0, lat: 0 },
    { type: 'node', id: 2, lon: 1, lat: 0 },
    { type: 'way', id: 20, nodes: [1, 2] },
    { type: 'relation', id: 1, members: [{ type: 'way', ref: 20, role: 'outer' }] },
  ] };
  assert.equal(relationHasResolvableOuter(complete, 1), true);
  assert.equal(relationHasResolvableOuter({ elements: complete.elements.filter((item) => item.id !== 2) }, 1), false);
  const compact = { elements: [
    { type: 'way', id: 20, nodes: [1, 2, 3, 4, 1], geometry: [
      { lon: 0, lat: 0 }, { lon: 1, lat: 0 }, { lon: 1, lat: 1 }, { lon: 0, lat: 1 }, { lon: 0, lat: 0 },
    ] },
    { type: 'relation', id: 1, members: [{ type: 'way', ref: 20, role: 'outer' }] },
  ] };
  assert.equal(relationHasResolvableOuter(compact, 1), true);
  assert.equal(relationGeometry(compact, 1).geometry.type, 'Polygon');
});

test('direct subarea geometry is clipped to its real coastline', () => {
  const nodes = [
    [1, 0, 0], [2, 0.01, 0], [3, 0.01, 0.01], [4, 0, 0.01],
  ].map(([id, lon, lat]) => ({ type: 'node', id, lon, lat }));
  const full = { elements: [
    ...nodes,
    { type: 'way', id: 100, tags: { maritime: 'yes' }, nodes: [1, 2] },
    { type: 'way', id: 101, nodes: [2, 3, 4, 1] },
    { type: 'relation', id: 2, tags: { name: '沿岸区' }, members: [
      { type: 'way', ref: 100, role: 'outer' },
      { type: 'way', ref: 101, role: 'outer' },
    ] },
    { type: 'relation', id: 1, tags: { name: '沿岸市' }, members: [
      { type: 'relation', ref: 2, role: 'subarea' },
    ] },
  ] };
  const coastlineResponse = { elements: [
    { type: 'way', id: 200, geometry: [
      { lon: 0, lat: 0 }, { lon: 0.005, lat: 0.002 }, { lon: 0.01, lat: 0 },
    ] },
  ] };
  const result = relationGeometry(full, 1, { coastlineResponse });
  assert.equal(result.geometry.type, 'Polygon');
  assert.equal(result.subareaAudit.sourceMode, 'direct-subarea-coastline-land-mask');
  assert.equal(result.landMaskAudit.maskedOuterCount, 1);
  assert.ok(result.geometry.coordinates[0].some(([lon, lat]) => lon === 0.005 && lat === 0.002));
  assert.equal(validateGeometryIntegrity(result.geometry).outerOrientation, 'counterclockwise');
});

test('a complete parent boundary remains canonical when direct subareas exist', () => {
  const nodes = [
    [1, 0, 0], [2, 4, 0], [3, 4, 4], [4, 0, 4],
    [5, 1, 1], [6, 3, 1], [7, 3, 3], [8, 1, 3],
  ].map(([id, lon, lat]) => ({ type: 'node', id, lon, lat }));
  const full = { elements: [
    ...nodes,
    { type: 'way', id: 100, nodes: [1, 2, 3, 4, 1] },
    { type: 'way', id: 200, nodes: [5, 6, 7, 8, 5] },
    { type: 'relation', id: 2, tags: { name: '内側区' }, members: [{ type: 'way', ref: 200, role: 'outer' }] },
    { type: 'relation', id: 1, tags: { name: '親市' }, members: [
      { type: 'way', ref: 100, role: 'outer' },
      { type: 'relation', ref: 2, role: 'subarea' },
    ] },
  ] };
  const result = relationGeometry(full, 1);
  assert.equal(result.geometry.type, 'Polygon');
  assert.deepEqual(result.geometry.coordinates[0], close([[0, 0], [4, 0], [4, 4], [0, 4]]));
  assert.equal(result.subareaAudit.directComponents[0].disposition, 'covered-by-parent');
  assert.equal(result.subareaAudit.sourceMode, 'parent-boundary-with-subarea-audit');

  const parentOnly = { elements: full.elements.filter((item) => !(
    (item.type === 'relation' && item.id === 2)
    || (item.type === 'way' && item.id === 200)
    || (item.type === 'node' && [5, 6, 7, 8].includes(item.id))
  )) };
  const parentOnlyResult = relationGeometry(parentOnly, 1);
  assert.equal(parentOnlyResult.geometry.type, 'Polygon');
  assert.equal(parentOnlyResult.subareaAudit.directAuditComplete, false);
  assert.deepEqual(parentOnlyResult.subareaAudit.unresolvedDirectRelationIds, ['2']);
  assert.equal(parentOnlyResult.subareaAudit.sourceMode, 'parent-boundary');
});

test('overlapping direct subareas are rejected when they are the only geometry source', () => {
  const nodes = [
    [1, 0, 0], [2, 2, 0], [3, 2, 2], [4, 0, 2],
    [5, 1, 0], [6, 3, 0], [7, 3, 2], [8, 1, 2],
  ].map(([id, lon, lat]) => ({ type: 'node', id, lon, lat }));
  const full = { elements: [
    ...nodes,
    { type: 'way', id: 200, nodes: [1, 2, 3, 4, 1] },
    { type: 'way', id: 300, nodes: [5, 6, 7, 8, 5] },
    { type: 'relation', id: 2, members: [{ type: 'way', ref: 200, role: 'outer' }] },
    { type: 'relation', id: 3, members: [{ type: 'way', ref: 300, role: 'outer' }] },
    { type: 'relation', id: 1, members: [
      { type: 'relation', ref: 2, role: 'subarea' },
      { type: 'relation', ref: 3, role: 'subarea' },
    ] },
  ] };
  assert.throws(() => relationGeometry(full, 1), /overlaps component/);
});

test('multipolygon relation joins split outers and preserves holes', () => {
  const nodes = [
    [1, 0, 0], [2, 4, 0], [3, 4, 4], [4, 0, 4],
    [5, 1, 1], [6, 1, 2], [7, 2, 2], [8, 2, 1],
  ].map(([id, lon, lat]) => ({ type: 'node', id, lon, lat }));
  const full = { elements: [
    ...nodes,
    { type: 'way', id: 101, nodes: [1, 2, 3] },
    { type: 'way', id: 102, nodes: [3, 4, 1] },
    { type: 'way', id: 103, nodes: [5, 6, 7, 8, 5] },
    { type: 'relation', id: 1000, tags: { type: 'multipolygon' }, members: [
      { type: 'way', ref: 101, role: 'outer' },
      { type: 'way', ref: 102, role: 'outer' },
      { type: 'way', ref: 103, role: 'inner' },
    ] },
  ] };
  const { geometry } = relationGeometry(full, 1000);
  assert.equal(geometry.type, 'Polygon');
  assert.equal(geometry.coordinates.length, 2);
  assert.deepEqual(validateGeometryIntegrity(geometry), {
    ringCount: 2,
    holeCount: 1,
    duplicateRingCount: 0,
    outerOrientation: 'counterclockwise',
    innerOrientation: 'clockwise',
  });
});

test('pixel-space SVG remains precise for a tiny footprint', () => {
  const bbox = [135, 35, 135.000001, 35.000001];
  const geometry = { type: 'Polygon', coordinates: [close([
    [135, 35], [135.000001, 35], [135.000001, 35.000001], [135, 35.000001],
  ])] };
  const projectedRatio = ((bbox[2] - bbox[0]) * Math.cos(35.0000005 * Math.PI / 180)) / (bbox[3] - bbox[1]);
  const dimensions = rasterDimensions(projectedRatio);
  const transform = svgTransform(bbox, dimensions.width, dimensions.height, 0.04);
  const svg = svgText(geometry, bbox, transform);
  assert.match(svg, new RegExp(`viewBox="0 0 ${dimensions.width} ${dimensions.height}"`));
  assert.ok(!svg.includes('viewBox="0 0 0.'));
  assert.ok(transform.scale > 1_000_000);
  assert.ok(svgQuantizationErrorPx() <= SVG_MAX_QUANTIZATION_ERROR_PX);
});

test('vertical LineString receives a finite, non-zero preview transform', () => {
  const bbox = [135, 34, 135, 34.1];
  const geometry = { type: 'LineString', coordinates: [[135, 34], [135, 34.1]] };
  const transform = svgTransform(bbox, 40, 2048, 0.04);
  const svg = svgText(geometry, bbox, transform);
  assert.ok(Number.isFinite(transform.scale) && transform.scale > 0);
  assert.match(svg, /stroke-width="2"/);
});

test('every supported kind gets an explicit boundary definition', () => {
  for (const kind of ['administrative-area', 'island', 'water', 'park', 'facility', 'boundary']) {
    assert.ok(defaultBoundaryDefinitionForKind(kind, kind === 'water' ? 'LineString' : 'Polygon'));
  }
});
