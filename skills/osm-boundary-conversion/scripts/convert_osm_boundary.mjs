#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const USER_AGENT = 'Codex osm-boundary-conversion/2.0';
const REQUEST_TIMEOUT_MS = 15_000;
const EARTH_RADIUS_M = 6_371_008.8;

function fail(message) { throw new Error(message); }

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'help' || key === 'deep' || key === 'no-svg' || key === 'keep-raw' || key === 'reuse-cache') args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) fail(`HTTP ${response.status} from ${url}: ${text.slice(0, 240)}`);
    return { json: JSON.parse(text), text };
  } finally { clearTimeout(timer); }
}

function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function samePoint(a, b) { return a[0] === b[0] && a[1] === b[1]; }

function cleanClosedRing(points) {
  if (!Array.isArray(points) || points.length < 3) fail('A way has fewer than three nodes');
  const ring = [];
  for (const point of points) {
    if (!point) fail('A way references a missing node');
    if (!ring.length || !samePoint(ring[ring.length - 1], point)) ring.push(point);
  }
  if (!samePoint(ring[0], ring[ring.length - 1])) ring.push([...ring[0]]);
  if (ring.length < 4) fail('A ring has fewer than four coordinates');
  return ring;
}

function cleanOpenLine(points) {
  if (!Array.isArray(points) || points.length < 2) fail('A line has fewer than two nodes');
  const line = [];
  for (const point of points) {
    if (!point) fail('A line references a missing node');
    if (!line.length || !samePoint(line[line.length - 1], point)) line.push(point);
  }
  if (line.length < 2) fail('A line has fewer than two distinct coordinates');
  return line;
}

function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return sum / 2;
}

function reverseRing(ring) {
  const open = ring.slice(0, -1).reverse();
  return [...open, [...open[0]]];
}

function normalizeOrientation(ring, outer) {
  return (signedArea(ring) > 0) === outer ? ring : reverseRing(ring);
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const crosses = ((a[1] > point[1]) !== (b[1] > point[1])) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

function orientation(a, b, c) {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(value) < 1e-12) return 0;
  return value > 0 ? 1 : -1;
}

function onSegment(a, b, point) {
  return point[0] >= Math.min(a[0], b[0]) - 1e-12 && point[0] <= Math.max(a[0], b[0]) + 1e-12 && point[1] >= Math.min(a[1], b[1]) - 1e-12 && point[1] <= Math.max(a[1], b[1]) + 1e-12;
}

function segmentsIntersect(a, b, c, d) {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (abC === 0 && onSegment(a, b, c)) return true;
  if (abD === 0 && onSegment(a, b, d)) return true;
  if (cdA === 0 && onSegment(c, d, a)) return true;
  if (cdB === 0 && onSegment(c, d, b)) return true;
  return abC !== abD && cdA !== cdB;
}

function selfIntersectionCount(ring, closed = true) {
  let count = 0;
  const segmentCount = ring.length - 1;
  for (let i = 0; i < segmentCount; i += 1) {
    for (let j = i + 1; j < segmentCount; j += 1) {
      if (j === i + 1 || (closed && i === 0 && j === segmentCount - 1)) continue;
      if (segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) count += 1;
    }
  }
  return count;
}

function reverseSegment(segment) {
  return { ...segment, nodes: segment.nodes.slice().reverse(), coords: segment.coords.slice().reverse() };
}

function joinSegmentChains(segments) {
  const remaining = new Map(segments.map((segment) => [segment.id, segment]));
  const endpointIndex = new Map();
  for (const segment of segments) {
    for (const node of new Set([segment.nodes[0], segment.nodes[segment.nodes.length - 1]])) {
      if (!endpointIndex.has(node)) endpointIndex.set(node, new Set());
      endpointIndex.get(node).add(segment.id);
    }
  }
  const removeSegment = (segment) => {
    remaining.delete(segment.id);
    for (const node of new Set([segment.nodes[0], segment.nodes[segment.nodes.length - 1]])) {
      const ids = endpointIndex.get(node);
      if (!ids) continue;
      ids.delete(segment.id);
      if (!ids.size) endpointIndex.delete(node);
    }
  };
  const findAt = (node) => {
    for (const id of endpointIndex.get(node) ?? []) {
      const segment = remaining.get(id);
      if (segment) return segment;
    }
    return null;
  };
  const chains = [];
  while (remaining.size) {
    const first = remaining.values().next().value;
    removeSegment(first);
    let nodes = first.nodes.slice();
    let coords = first.coords.map((point) => [...point]);
    const chain = [first];
    let steps = 0;
    while (nodes[0] !== nodes[nodes.length - 1]) {
      const head = nodes[0];
      const tail = nodes[nodes.length - 1];
      const candidate = findAt(tail) ?? findAt(head);
      if (!candidate) fail(`Open ${first.role} ring near nodes ${head}/${tail}`);
      const joinsTail = candidate.nodes[0] === tail || candidate.nodes[candidate.nodes.length - 1] === tail;
      const oriented = joinsTail
        ? (candidate.nodes[0] === tail ? candidate : reverseSegment(candidate))
        : (candidate.nodes[candidate.nodes.length - 1] === head ? candidate : reverseSegment(candidate));
      removeSegment(candidate);
      if (joinsTail) {
        nodes = nodes.concat(oriented.nodes.slice(1));
        coords = coords.concat(oriented.coords.slice(1).map((point) => [...point]));
        chain.push(oriented);
      } else {
        nodes = oriented.nodes.slice(0, -1).concat(nodes);
        coords = oriented.coords.slice(0, -1).map((point) => [...point]).concat(coords);
        chain.unshift(oriented);
      }
      steps += 1;
      if (steps > segments.length) fail(`Too many ways while joining ${first.role} ring`);
    }
    chains.push({ segments: chain, ring: cleanClosedRing(coords) });
  }
  return chains;
}

function joinRings(segments) {
  return joinSegmentChains(segments).map((chain) => chain.ring);
}

const COASTLINE_CELL_DEG = 0.05;
const COASTLINE_CONTACT_MAX_KM = 0.05;

function relationHasMaritimeOuter(full, relationId) {
  const elements = Array.isArray(full.elements) ? full.elements : [];
  const ways = new Map(elements.filter((item) => item.type === 'way').map((item) => [String(item.id), item]));
  const relation = elements.find((item) => item.type === 'relation' && String(item.id) === String(relationId));
  return Boolean((relation?.members ?? []).some((member) => {
    if (member.type !== 'way' || member.role !== 'outer') return false;
    const maritime = normalizedText(ways.get(String(member.ref))?.tags?.maritime);
    return maritime === 'yes' || maritime === 'true';
  }));
}

function relationMemberBbox(full, relationId) {
  const elements = Array.isArray(full.elements) ? full.elements : [];
  const nodes = new Map(elements.filter((item) => item.type === 'node').map((item) => [String(item.id), [Number(item.lon), Number(item.lat)]]));
  const ways = new Map(elements.filter((item) => item.type === 'way').map((item) => [String(item.id), item]));
  const relation = elements.find((item) => item.type === 'relation' && String(item.id) === String(relationId));
  if (!relation) fail(`Relation ${relationId} is missing from the OSM response`);
  const points = [];
  for (const member of relation.members ?? []) {
    if (member.type !== 'way') continue;
    const way = ways.get(String(member.ref));
    for (const nodeId of way?.nodes ?? []) {
      const point = nodes.get(String(nodeId));
      if (point) points.push(point);
    }
  }
  if (!points.length) fail(`Relation ${relationId} has no way coordinates for coastline lookup`);
  return [
    Math.min(...points.map((point) => point[0])),
    Math.min(...points.map((point) => point[1])),
    Math.max(...points.map((point) => point[0])),
    Math.max(...points.map((point) => point[1])),
  ];
}

function coastlineQueryBbox(bbox) {
  const longitudeSpan = bbox[2] - bbox[0];
  const latitudeSpan = bbox[3] - bbox[1];
  const buffer = Math.min(0.1, Math.max(0.01, Math.max(longitudeSpan, latitudeSpan) * 0.02));
  return [
    Math.max(-90, bbox[1] - buffer),
    Math.max(-180, bbox[0] - buffer),
    Math.min(90, bbox[3] + buffer),
    Math.min(180, bbox[2] + buffer),
  ];
}

function coastlineWaysFromResponse(response) {
  const elements = Array.isArray(response?.elements) ? response.elements : [];
  return elements.filter((item) => item.type === 'way' && Array.isArray(item.geometry) && item.geometry.length >= 2).map((item) => {
    const coords = item.geometry.map((point) => [Number(point.lon), Number(point.lat)]);
    return {
      id: String(item.id),
      coords,
      closed: samePoint(coords[0], coords[coords.length - 1]),
      bbox: [
        Math.min(...coords.map((point) => point[0])),
        Math.min(...coords.map((point) => point[1])),
        Math.max(...coords.map((point) => point[0])),
        Math.max(...coords.map((point) => point[1])),
      ],
    };
  });
}

function coastlineGridKey(x, y) { return `${x}:${y}`; }

function buildCoastlineIndex(response) {
  const ways = coastlineWaysFromResponse(response);
  if (!ways.length) fail('The coastline query returned no natural=coastline ways');
  const minLon = Math.min(...ways.map((way) => way.bbox[0]));
  const minLat = Math.min(...ways.map((way) => way.bbox[1]));
  const cellSize = Math.max(COASTLINE_CELL_DEG, Math.min(1, Math.max(
    Math.max(...ways.map((way) => way.bbox[2])) - minLon,
    Math.max(...ways.map((way) => way.bbox[3])) - minLat,
  ) / 100));
  const grid = new Map();
  const broad = new Set();
  ways.forEach((way, index) => {
    const minX = Math.floor(way.bbox[0] / cellSize);
    const maxX = Math.floor(way.bbox[2] / cellSize);
    const minY = Math.floor(way.bbox[1] / cellSize);
    const maxY = Math.floor(way.bbox[3] / cellSize);
    if ((maxX - minX + 1) * (maxY - minY + 1) > 10_000) {
      broad.add(index);
      return;
    }
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const key = coastlineGridKey(x, y);
        if (!grid.has(key)) grid.set(key, new Set());
        grid.get(key).add(index);
      }
    }
  });
  return { ways, grid, broad, cellSize };
}

function projectedPointOnSegment(point, start, end) {
  const cosLat = Math.cos(point[1] * Math.PI / 180);
  const ax = start[0] * cosLat;
  const ay = start[1];
  const bx = end[0] * cosLat;
  const by = end[1];
  const px = point[0] * cosLat;
  const py = point[1];
  const dx = bx - ax;
  const dy = by - ay;
  const denominator = dx * dx + dy * dy;
  const t = denominator > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denominator)) : 0;
  return [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
}

function coastlineCandidateIndices(index, point, maxDistanceKm) {
  const centerX = Math.floor(point[0] / index.cellSize);
  const centerY = Math.floor(point[1] / index.cellSize);
  const radius = Math.max(2, Math.ceil((maxDistanceKm / 110) / index.cellSize) + 1);
  const candidates = new Set(index.broad);
  for (let x = centerX - radius; x <= centerX + radius; x += 1) {
    for (let y = centerY - radius; y <= centerY + radius; y += 1) {
      for (const wayIndex of index.grid.get(coastlineGridKey(x, y)) ?? []) candidates.add(wayIndex);
    }
  }
  return candidates;
}

function nearestCoastlinePoint(point, index, { openOnly = true, maxDistanceKm = COASTLINE_CONTACT_MAX_KM } = {}) {
  let best = null;
  for (const wayIndex of coastlineCandidateIndices(index, point, maxDistanceKm)) {
    const way = index.ways[wayIndex];
    if (openOnly && way.closed) continue;
    for (let i = 0; i < way.coords.length - 1; i += 1) {
      const projected = projectedPointOnSegment(point, way.coords[i], way.coords[i + 1]);
      const distanceKm = haversineKm(point, projected);
      if (!best || distanceKm < best.distanceKm) {
        const segmentStart = way.coords[i];
        const segmentEnd = way.coords[i + 1];
        const cosLat = Math.cos(point[1] * Math.PI / 180);
        const dx = (segmentEnd[0] - segmentStart[0]) * cosLat;
        const dy = segmentEnd[1] - segmentStart[1];
        const px = (projected[0] - segmentStart[0]) * cosLat;
        const py = projected[1] - segmentStart[1];
        const denominator = dx * dx + dy * dy;
        const t = denominator > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / denominator)) : 0;
        best = { wayId: way.id, wayIndex, segmentIndex: i, t, point: projected, distanceKm };
      }
    }
  }
  return best;
}

function findCoastlineContact(ring, startIndex, direction, coastlineIndex, label) {
  const ringSize = ring.length - 1;
  let best = null;
  let nearRunMisses = 0;
  for (let offset = 0; offset < ringSize; offset += 1) {
    const index = ((startIndex + direction * offset) % ringSize + ringSize) % ringSize;
    const parentPoint = ring[index];
    const nearest = nearestCoastlinePoint(parentPoint, coastlineIndex, { openOnly: true });
    if (nearest && nearest.distanceKm <= COASTLINE_CONTACT_MAX_KM) {
      if (!best || nearest.distanceKm < best.distanceKm) best = { index, parentPoint, ...nearest };
      nearRunMisses = 0;
      continue;
    }
    if (best) {
      nearRunMisses += 1;
      if (nearRunMisses >= 2) return best;
    }
  }
  if (best) return best;
  fail(`Could not find a mainland coastline contact while resolving ${label}`);
}

function circularRingPath(ring, fromIndex, toIndex, direction = 1) {
  const ringSize = ring.length - 1;
  const points = [ring[fromIndex]];
  let index = fromIndex;
  let steps = 0;
  while (index !== toIndex) {
    index = ((index + direction) % ringSize + ringSize) % ringSize;
    points.push(ring[index]);
    steps += 1;
    if (steps > ringSize) fail(`Could not close a circular relation path from ${fromIndex} to ${toIndex}`);
  }
  return points;
}

function coastlineWayPieces(way, marks) {
  const boundaries = [{ position: 0, point: way.coords[0] }, ...marks, { position: way.coords.length - 1, point: way.coords[way.coords.length - 1] }]
    .sort((a, b) => a.position - b.position);
  const uniqueBoundaries = [];
  for (const boundary of boundaries) {
    const previous = uniqueBoundaries.at(-1);
    if (previous && Math.abs(previous.position - boundary.position) < 1e-9) {
      if (boundary.key) uniqueBoundaries[uniqueBoundaries.length - 1] = boundary;
      continue;
    }
    uniqueBoundaries.push(boundary);
  }
  const pieces = [];
  for (let i = 0; i < uniqueBoundaries.length - 1; i += 1) {
    const start = uniqueBoundaries[i];
    const end = uniqueBoundaries[i + 1];
    if (end.position - start.position < 1e-9) continue;
    const coords = [start.point];
    for (let vertexIndex = 1; vertexIndex < way.coords.length - 1; vertexIndex += 1) {
      if (vertexIndex > start.position + 1e-9 && vertexIndex < end.position - 1e-9) coords.push(way.coords[vertexIndex]);
    }
    coords.push(end.point);
    const cleaned = cleanOpenLine(coords);
    pieces.push({ id: `${way.id}:${i}`, coords: cleaned, start: cleaned[0], end: cleaned[cleaned.length - 1] });
  }
  return pieces;
}

function coastlinePath(coastlineIndex, startSnap, endSnap) {
  const marksByWay = new Map();
  for (const snap of [startSnap, endSnap]) {
    if (!marksByWay.has(snap.wayId)) marksByWay.set(snap.wayId, []);
    marksByWay.get(snap.wayId).push({ position: snap.segmentIndex + snap.t, point: snap.point, key: snap.wayId });
  }
  const edges = [];
  for (const way of coastlineIndex.ways) {
    if (way.closed) continue;
    const pieces = coastlineWayPieces(way, marksByWay.get(way.id) ?? []);
    for (const piece of pieces) {
      edges.push({ ...piece, lengthKm: lineLengthKm({ type: 'LineString', coordinates: piece.coords }) });
    }
  }
  const graph = new Map();
  const addEdge = (key, edgeIndex) => {
    if (!graph.has(key)) graph.set(key, []);
    graph.get(key).push(edgeIndex);
  };
  edges.forEach((edge, index) => {
    addEdge(coastlineGridKey(edge.start[0].toFixed(7), edge.start[1].toFixed(7)), index);
    addEdge(coastlineGridKey(edge.end[0].toFixed(7), edge.end[1].toFixed(7)), index);
  });
  const pointKey = (point) => coastlineGridKey(point[0].toFixed(7), point[1].toFixed(7));
  const startKey = pointKey(startSnap.point);
  const endKey = pointKey(endSnap.point);
  if (startKey === endKey) return [startSnap.point, endSnap.point];
  const distances = new Map([[startKey, 0]]);
  const previous = new Map();
  const queue = [{ key: startKey, distance: 0 }];
  while (queue.length) {
    queue.sort((a, b) => a.distance - b.distance);
    const current = queue.shift();
    if (current.distance !== distances.get(current.key)) continue;
    if (current.key === endKey) break;
    for (const edgeIndex of graph.get(current.key) ?? []) {
      const edge = edges[edgeIndex];
      const start = pointKey(edge.start);
      const end = pointKey(edge.end);
      const nextKey = start === current.key ? end : start;
      const nextDistance = current.distance + (edge.lengthKm ?? 0);
      if (nextDistance >= (distances.get(nextKey) ?? Infinity)) continue;
      distances.set(nextKey, nextDistance);
      previous.set(nextKey, { key: current.key, edgeIndex, forward: start === current.key });
      queue.push({ key: nextKey, distance: nextDistance });
    }
  }
  if (!distances.has(endKey)) fail(`No connected OSM coastline path between ${startSnap.wayId} and ${endSnap.wayId}`);
  const route = [];
  let currentKey = endKey;
  while (currentKey !== startKey) {
    const step = previous.get(currentKey);
    if (!step) fail('OSM coastline path reconstruction stopped before the contact point');
    route.push(step);
    currentKey = step.key;
  }
  route.reverse();
  const points = [startSnap.point];
  currentKey = startKey;
  for (const step of route) {
    const edge = edges[step.edgeIndex];
    const oriented = step.forward ? edge.coords : edge.coords.slice().reverse();
    points.push(...oriented.slice(1));
    currentKey = pointKey(oriented.at(-1));
  }
  if (currentKey !== endKey) fail('OSM coastline path ended at an unexpected node');
  points[points.length - 1] = [...endSnap.point];
  return cleanOpenLine(points);
}

function pointInPolygonRings(point, polygon) {
  return pointInRing(point, polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(point, hole));
}

function applyAdministrativeLandMask({ basePolygons, outerChains, coastlineResponse }) {
  const coastlineIndex = buildCoastlineIndex(coastlineResponse);
  const maskedPolygons = [];
  const contacts = [];
  let maskedOuterCount = 0;
  for (let chainIndex = 0; chainIndex < outerChains.length; chainIndex += 1) {
    const chain = outerChains[chainIndex];
    const polygon = basePolygons[chainIndex] ?? [chain.ring];
    const ring = chain.ring;
    const ranges = [];
    let offset = 0;
    for (const segment of chain.segments) {
      const start = offset;
      const end = offset + segment.coords.length - 1;
      ranges.push({ start, end, maritime: ['yes', 'true'].includes(normalizedText(segment.tags?.maritime)) });
      offset = end;
    }
    const maritimeRanges = ranges.filter((range) => range.maritime);
    if (!maritimeRanges.length) {
      maskedPolygons.push(polygon);
      continue;
    }
    const ringSize = ring.length - 1;
    const first = maritimeRanges[0];
    const last = maritimeRanges.at(-1);
    const contains = (position, start, end) => start <= end
      ? position >= start && position <= end
      : position >= start || position <= end;
    const score = (start, end) => maritimeRanges.reduce((total, range) => total + (contains(range.start, start, end) ? range.end - range.start + 1 : 0), 0);
    const directArc = { start: first.start, end: last.end, score: score(first.start, last.end) };
    const wrappedArc = { start: last.start, end: first.end, score: score(last.start, first.end) };
    const seaArc = wrappedArc.score > directArc.score ? wrappedArc : directArc;
    const startContact = findCoastlineContact(ring, (seaArc.start - 1 + ringSize) % ringSize, -1, coastlineIndex, 'the start of a maritime boundary');
    const endContact = findCoastlineContact(ring, (seaArc.end + 1) % ringSize, 1, coastlineIndex, 'the end of a maritime boundary');
    const coast = coastlinePath(coastlineIndex, startContact, endContact);
    coast[0] = [...startContact.parentPoint];
    coast[coast.length - 1] = [...endContact.parentPoint];
    const inland = circularRingPath(ring, endContact.index, startContact.index, 1);
    const landRing = cleanClosedRing([...coast, ...inland.slice(1)]);
    const holes = (polygon.slice(1) ?? []).filter((hole) => pointInRing(hole[0], landRing));
    maskedPolygons.push([landRing, ...holes]);
    maskedOuterCount += 1;
    contacts.push({
      outerIndex: chainIndex,
      start: { parentIndex: startContact.index, point: startContact.parentPoint, coastlineWayId: startContact.wayId, distanceKm: Number(startContact.distanceKm.toFixed(6)) },
      end: { parentIndex: endContact.index, point: endContact.parentPoint, coastlineWayId: endContact.wayId, distanceKm: Number(endContact.distanceKm.toFixed(6)) },
      coastlineVertexCount: coast.length,
      landVertexCount: landRing.length,
    });
  }
  const landPolygons = maskedPolygons.slice();
  const parentPolygons = basePolygons;
  const acceptedIslandKeys = new Set(landPolygons.map((polygon) => polygon[0].map((point) => `${point[0].toFixed(7)},${point[1].toFixed(7)}`).join(';')));
  let islandComponentCount = 0;
  for (const way of coastlineIndex.ways.filter((candidate) => candidate.closed)) {
    const islandRing = cleanClosedRing(way.coords);
    if (!parentPolygons.some((polygon) => pointInPolygonRings(islandRing[0], polygon))) continue;
    if (landPolygons.some((polygon) => pointInRing(islandRing[0], polygon[0]))) continue;
    const islandKey = islandRing.map((point) => `${point[0].toFixed(7)},${point[1].toFixed(7)}`).join(';');
    if (acceptedIslandKeys.has(islandKey)) continue;
    acceptedIslandKeys.add(islandKey);
    landPolygons.push([islandRing]);
    islandComponentCount += 1;
  }
  return {
    polygons: landPolygons,
    audit: {
      applied: true,
      sourceMode: 'coastline-land-mask',
      coastlineWayCount: coastlineIndex.ways.length,
      coastlineOpenWayCount: coastlineIndex.ways.filter((way) => !way.closed).length,
      coastlineClosedWayCount: coastlineIndex.ways.filter((way) => way.closed).length,
      maskedOuterCount,
      islandComponentCount,
      contacts,
    },
  };
}

function relationGeometry(full, relationId, { coastlineResponse = null } = {}) {
  const elements = Array.isArray(full.elements) ? full.elements : [];
  const relations = new Map(elements.filter((item) => item.type === 'relation').map((item) => [String(item.id), item]));
  const relation = relations.get(String(relationId));
  if (!relation) fail(`Relation ${relationId} is missing from the OSM response`);
  const nodes = new Map(elements.filter((item) => item.type === 'node').map((item) => [String(item.id), [Number(item.lon), Number(item.lat)]]));
  const ways = new Map(elements.filter((item) => item.type === 'way').map((item) => [String(item.id), item]));

  const buildPolygons = (sourceRelation) => {
    const groups = { outer: [], inner: [] };
    for (const [memberIndex, member] of (sourceRelation.members ?? []).entries()) {
      if (member.type !== 'way' || !groups[member.role]) continue;
      const way = ways.get(String(member.ref));
      if (!way) fail(`Missing way ${member.ref} referenced by relation ${sourceRelation.id}`);
      if (!Array.isArray(way.nodes)) fail(`Way ${member.ref} has no node list`);
      const coords = way.nodes.map((nodeId) => nodes.get(String(nodeId)));
      groups[member.role].push({
        id: `${sourceRelation.id}:${member.role}:${memberIndex}:${member.ref}`,
        role: member.role,
        nodes: way.nodes.map(String),
        coords,
        tags: way.tags ?? {},
      });
    }
    if (!groups.outer.length) return [];
    const outers = joinRings(groups.outer).map((ring) => normalizeOrientation(ring, true));
    const inners = groups.inner.length ? joinRings(groups.inner).map((ring) => normalizeOrientation(ring, false)) : [];
    const polygons = outers.map((outer) => [outer]);
    for (const inner of inners) {
      const owner = polygons.find((polygon) => pointInRing(inner[0], polygon[0]));
      if (!owner) fail(`An inner ring in relation ${sourceRelation.id} is outside every outer ring`);
      owner.push(inner);
    }
    return polygons;
  };

  const pointInPolygon = (point, polygon) => pointInRing(point, polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(point, hole));
  const ringKey = (ring) => ring.map((point) => `${point[0].toFixed(7)},${point[1].toFixed(7)}`).join(';');
  const directSubareaMembers = (relation.members ?? []).filter((member) => member.type === 'relation' && member.role === 'subarea');
  const basePolygons = buildPolygons(relation);
  const outerChains = joinSegmentChains((relation.members ?? [])
    .map((member, memberIndex) => ({ member, memberIndex }))
    .filter(({ member }) => member.type === 'way' && member.role === 'outer')
    .map(({ member, memberIndex }) => {
      const way = ways.get(String(member.ref));
      if (!way) fail(`Missing way ${member.ref} referenced by relation ${relation.id}`);
      const coords = way.nodes.map((nodeId) => nodes.get(String(nodeId)));
      return {
        id: `${relation.id}:outer:${memberIndex}:${member.ref}`,
        role: 'outer',
        nodes: way.nodes.map(String),
        coords,
        tags: way.tags ?? {},
      };
    }));
  if (!basePolygons.length && !directSubareaMembers.length) fail(`Relation ${relationId} has no outer ways`);
  const subareaAudit = {
    directRelationCount: directSubareaMembers.length,
    resolvedRelationCount: 0,
    geometryRelationCount: 0,
    directGeometryRelationCount: 0,
    directComponentCount: 0,
    candidateComponentCount: 0,
    addedComponentCount: 0,
    addedComponents: [],
    directComponents: [],
    sourceMode: directSubareaMembers.length ? 'direct-subarea-land' : 'parent-boundary',
    missingRelationIds: [],
    cycleCount: 0,
    unsupportedRelationRoles: (relation.members ?? [])
      .filter((member) => member.type === 'relation' && member.role !== 'subarea')
      .map((member) => member.role || null),
  };
  const candidates = [];
  const directSubareaComponents = [];
  const visited = new Set([String(relationId)]);
  const visitSubarea = (childId, prebuiltPolygons = null) => {
    const key = String(childId);
    if (visited.has(key)) { subareaAudit.cycleCount += 1; return; }
    visited.add(key);
    const child = relations.get(key);
    if (!child) { subareaAudit.missingRelationIds.push(key); return; }
    subareaAudit.resolvedRelationCount += 1;
    const polygons = prebuiltPolygons ?? buildPolygons(child);
    if (polygons.length) {
      subareaAudit.geometryRelationCount += 1;
      for (const polygon of polygons) candidates.push({ relationId: key, name: child.tags?.name ?? null, polygon });
    }
    for (const member of child.members ?? []) {
      if (member.type === 'relation' && member.role === 'subarea') visitSubarea(member.ref);
    }
  };
  for (const member of directSubareaMembers) {
    const child = relations.get(String(member.ref));
    const directPolygons = child ? buildPolygons(child) : [];
    if (directPolygons.length) {
      subareaAudit.directGeometryRelationCount += 1;
      for (const polygon of directPolygons) directSubareaComponents.push({ relationId: String(member.ref), name: child.tags?.name ?? null, polygon });
    }
    visitSubarea(member.ref, directPolygons);
  }
  if (subareaAudit.missingRelationIds.length) {
    fail(`Missing subarea relations: ${subareaAudit.missingRelationIds.join(', ')}`);
  }
  if (directSubareaMembers.length && subareaAudit.directGeometryRelationCount !== directSubareaMembers.length) {
    fail(`Direct subarea geometry is incomplete: ${subareaAudit.directGeometryRelationCount}/${directSubareaMembers.length}`);
  }

  candidates.sort((a, b) => Math.abs(signedArea(b.polygon[0])) - Math.abs(signedArea(a.polygon[0])));
  let polygons;
  let landMaskAudit = { applied: false, sourceMode: 'not-needed' };
  if (directSubareaMembers.length) {
    const acceptedKeys = new Set();
    polygons = [];
    for (const component of directSubareaComponents) {
      const key = ringKey(component.polygon[0]);
      if (acceptedKeys.has(key)) continue;
      acceptedKeys.add(key);
      polygons.push(component.polygon);
      const feature = { relationId: Number(component.relationId), name: component.name, bbox: bboxOf({ type: 'Polygon', coordinates: component.polygon }), areaKm2: Number(sphericalAreaKm2({ type: 'Polygon', coordinates: component.polygon }).toFixed(8)) };
      subareaAudit.directComponents.push(feature);
    }
    subareaAudit.directComponentCount = polygons.length;
  } else {
    polygons = basePolygons.slice();
    const acceptedKeys = new Set(polygons.map((polygon) => ringKey(polygon[0])));
    for (const candidate of candidates) {
      const outer = candidate.polygon[0];
      const key = ringKey(outer);
      if (acceptedKeys.has(key)) continue;
      const insideExisting = polygons.some((polygon) => pointInPolygon(outer[0], polygon));
      if (insideExisting) continue;
      polygons.push(candidate.polygon);
      acceptedKeys.add(key);
      subareaAudit.addedComponentCount += 1;
      subareaAudit.addedComponents.push({
        relationId: Number(candidate.relationId),
        name: candidate.name,
        bbox: bboxOf({ type: 'Polygon', coordinates: candidate.polygon }),
        areaKm2: Number(sphericalAreaKm2({ type: 'Polygon', coordinates: candidate.polygon }).toFixed(8)),
      });
    }
    if (coastlineResponse) {
      const masked = applyAdministrativeLandMask({ basePolygons: polygons, outerChains, coastlineResponse });
      polygons = masked.polygons;
      landMaskAudit = masked.audit;
    }
  }
  subareaAudit.candidateComponentCount = candidates.length;
  const geometry = polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
  if (landMaskAudit.applied) {
    subareaAudit.sourceMode = landMaskAudit.sourceMode;
    subareaAudit.landMask = landMaskAudit;
  }
  return { relation, geometry, subareaAudit, landMaskAudit };
}

function wayGeometry(full, wayId) {
  const elements = Array.isArray(full.elements) ? full.elements : [];
  const way = elements.find((item) => item.type === 'way' && String(item.id) === String(wayId));
  if (!way) fail(`Way ${wayId} is missing from the OSM response`);
  const nodes = new Map(elements.filter((item) => item.type === 'node').map((item) => [String(item.id), [Number(item.lon), Number(item.lat)]]));
  if (!Array.isArray(way.nodes)) fail(`Way ${wayId} has no node list`);
  const points = way.nodes.map((nodeId) => nodes.get(String(nodeId)));
  const closed = way.nodes.length >= 2 && String(way.nodes[0]) === String(way.nodes[way.nodes.length - 1]);
  if (!closed) return { relation: null, tags: way.tags ?? {}, geometry: { type: 'LineString', coordinates: cleanOpenLine(points) } };
  if (way.nodes.length < 4) fail(`Way ${wayId} is closed but has fewer than four node references`);
  const ring = cleanClosedRing(points);
  return { relation: null, tags: way.tags ?? {}, geometry: { type: 'Polygon', coordinates: [normalizeOrientation(ring, true)] } };
}

function isAreaGeometry(geometry) { return geometry.type === 'Polygon' || geometry.type === 'MultiPolygon'; }

function allRings(geometry) {
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  fail(`Unsupported geometry type: ${geometry.type}`);
}

function bboxOf(geometry) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let count = 0;
  for (const ring of allRings(geometry)) {
    for (const point of ring) {
      count += 1;
      minLon = Math.min(minLon, point[0]);
      minLat = Math.min(minLat, point[1]);
      maxLon = Math.max(maxLon, point[0]);
      maxLat = Math.max(maxLat, point[1]);
    }
  }
  if (!count) fail('Geometry has no coordinates');
  return [minLon, minLat, maxLon, maxLat];
}

function sphericalAreaKm2(geometry) {
  if (!isAreaGeometry(geometry)) return null;
  let area = 0;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) {
    const rings = [polygon[0], ...polygon.slice(1)];
    for (const ring of rings) {
      let sum = 0;
      for (let i = 0; i < ring.length - 1; i += 1) {
        const lon1 = ring[i][0] * Math.PI / 180;
        const lon2 = ring[i + 1][0] * Math.PI / 180;
        const lat1 = ring[i][1] * Math.PI / 180;
        const lat2 = ring[i + 1][1] * Math.PI / 180;
        let delta = lon2 - lon1;
        if (delta > Math.PI) delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        sum += delta * (Math.sin(lat1) + Math.sin(lat2));
      }
      const ringArea = Math.abs(sum * EARTH_RADIUS_M ** 2 / 2);
      area += ring === polygon[0] ? ringArea : -ringArea;
    }
  }
  return Math.abs(area) / 1e6;
}

function haversineKm(a, b) {
  const lat1 = a[1] * Math.PI / 180;
  const lat2 = b[1] * Math.PI / 180;
  const dLat = lat2 - lat1;
  let dLon = (b[0] - a[0]) * Math.PI / 180;
  if (dLon > Math.PI) dLon -= 2 * Math.PI;
  if (dLon < -Math.PI) dLon += 2 * Math.PI;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))) / 1000;
}

function lineLengthKm(geometry) {
  if (geometry.type !== 'LineString') return null;
  let length = 0;
  for (let i = 0; i < geometry.coordinates.length - 1; i += 1) length += haversineKm(geometry.coordinates[i], geometry.coordinates[i + 1]);
  return length;
}

function coordinatesAreValid(geometry) {
  return allRings(geometry).flat().every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90);
}

const WATER_TYPES = new Set(['bay', 'channel', 'coastline', 'estuary', 'fjord', 'gulf', 'inlet', 'lagoon', 'lake', 'ocean', 'pond', 'reservoir', 'river', 'riverbank', 'sea', 'sound', 'strait', 'water', 'wetland']);

function normalizedText(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
}

function canonicalKind(value) {
  const kind = normalizedText(value).replace(/[_\s]+/g, '-');
  if (['administrative', 'administrative-area', 'admin', 'boundary'].includes(kind)) return 'administrative-area';
  if (['island', 'islet', 'archipelago', 'landmass'].includes(kind)) return 'island';
  if (['water', 'water-body', 'waterbody', 'lake', 'pond', 'reservoir', 'river', 'sea', 'bay'].includes(kind) || WATER_TYPES.has(kind)) return 'water';
  if (['park', 'protected-area'].includes(kind)) return 'park';
  if (['facility', 'site', 'footprint'].includes(kind)) return 'facility';
  return kind;
}

function candidateKind(item) {
  const category = normalizedText(item.category ?? item.class);
  const type = normalizedText(item.type);
  const tags = Object.fromEntries(Object.entries(item.extratags ?? {}).map(([key, value]) => [normalizedText(key), normalizedText(value)]));
  if (category === 'boundary' || type === 'administrative' || tags.boundary === 'administrative') return 'administrative-area';
  if (type === 'island' || type === 'islet' || type === 'archipelago' || tags.place === 'island') return 'island';
  if (category === 'water' || WATER_TYPES.has(type) || tags.natural === 'water' || Boolean(tags.water)) return 'water';
  if (type === 'park' || tags.leisure === 'park') return 'park';
  if (category === 'amenity' || category === 'building' || category === 'leisure') return 'facility';
  return null;
}

function kindFromTags(tags = {}) {
  return candidateKind({
    category: tags.boundary === 'administrative' ? 'boundary' : null,
    type: tags.natural ?? tags.place ?? tags.water ?? tags.leisure ?? null,
    extratags: tags,
  });
}

function candidateNames(item) {
  return [item.name, item.display_name?.split(',')[0], ...Object.values(item.namedetails ?? {})].filter(Boolean).map(normalizedText);
}

function candidateNameScore(item, targetName) {
  const target = normalizedText(targetName);
  if (normalizedText(item.name) === target) return 4;
  if (normalizedText(item.display_name?.split(',')[0]) === target) return 3;
  if (candidateNames(item).includes(target)) return 2;
  return 0;
}

function candidateContextScore(item, context) {
  const tokens = String(context ?? '').split(/[\s,、，/]+/).map(normalizedText).filter((token) => token.length >= 2);
  if (!tokens.length) return 0;
  const haystack = normalizedText([item.display_name, ...Object.values(item.address ?? {})].join(' '));
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function candidateMatchesKind(item, requestedKind) {
  const actual = candidateKind(item);
  return actual != null && (!requestedKind || actual === canonicalKind(requestedKind));
}

function selectCandidate(items, name, context, requestedKind) {
  const ranked = items
    .filter((item) => (item.osm_type === 'relation' || item.osm_type === 'way') && candidateNameScore(item, name) > 0 && candidateMatchesKind(item, requestedKind))
    .map((item) => ({ item, score: candidateNameScore(item, name) * 100 + candidateContextScore(item, context) * 10 + (requestedKind ? 5 : 0) }))
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  const topScore = ranked[0].score;
  const top = ranked.filter((entry) => entry.score === topScore);
  const uniqueTop = new Map(top.map((entry) => [`${entry.item.osm_type}:${entry.item.osm_id}`, entry.item]));
  if (uniqueTop.size > 1) {
    const ids = [...uniqueTop.keys()].join(', ');
    fail(`Ambiguous OSM candidates for ${name}${context ? `, ${context}` : ''}: ${ids}; provide --context or --osm-type/--osm-id`);
  }
  return top[0].item;
}

function candidateContext(item) {
  return [...new Set(Object.entries(item.address ?? {})
    .filter(([key]) => !key.toLowerCase().startsWith('iso3166') && key !== 'country_code' && key !== 'island' && key !== 'lake')
    .map(([, value]) => value)
    .filter(Boolean))].join(' ');
}

async function findReusableTarget(outputDir, name, requestedKind, context) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const matches = new Map();
  const normalizedName = normalizedText(name);
  const normalizedContext = normalizedText(context);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.metadata.json')) continue;
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(outputDir, entry.name), 'utf8'));
      const source = metadata.source ?? {};
      const osmType = source.osmType ?? metadata.osmType;
      const osmId = source.osmId ?? metadata.osmId;
      if (!osmType || !osmId || normalizedText(metadata.name) !== normalizedName) continue;
      if (requestedKind && canonicalKind(metadata.kind) !== canonicalKind(requestedKind)) continue;
      if (normalizedContext && metadata.context && !normalizedText(metadata.context).includes(normalizedContext)) continue;
      const key = `${osmType}:${osmId}`;
      if (!matches.has(key)) matches.set(key, { metadata, osmType, osmId: String(osmId) });
    } catch {
      // Ignore unrelated or incomplete metadata files while looking for a reusable target.
    }
  }
  if (matches.size > 1) fail(`Ambiguous reusable targets for ${name}; provide --osm-type/--osm-id`);
  return matches.values().next().value ?? null;
}

const SVG_COORDINATE_PRECISION = 6;

function svgQuantizationErrorPx(viewWidth, viewHeight, width, height) {
  const halfStep = 0.5 * (10 ** -SVG_COORDINATE_PRECISION);
  return Number(Math.max(halfStep * width / viewWidth, halfStep * height / viewHeight).toFixed(6));
}

function svgViewport(bbox, paddingRatio) {
  const lonScale = Math.cos(((bbox[1] + bbox[3]) / 2) * Math.PI / 180);
  const contentWidth = (bbox[2] - bbox[0]) * lonScale;
  const contentHeight = bbox[3] - bbox[1];
  const paddingX = contentWidth * paddingRatio;
  const paddingY = contentHeight * paddingRatio;
  return { lonScale, contentWidth, contentHeight, paddingX, paddingY, viewWidth: contentWidth + paddingX * 2, viewHeight: contentHeight + paddingY * 2 };
}

function rasterDimensions(aspectRatio) {
  const safeRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  return safeRatio >= 1
    ? { width: 2048, height: Math.max(1, Math.round(2048 / safeRatio)) }
    : { width: Math.max(1, Math.round(2048 * safeRatio)), height: 2048 };
}

function svgText(geometry, bbox, width, height, paddingRatio) {
  const { lonScale, paddingX, paddingY, viewWidth, viewHeight } = svgViewport(bbox, paddingRatio);
  const mapPoint = ([lon, lat]) => [paddingX + (lon - bbox[0]) * lonScale, paddingY + (bbox[3] - lat)];
  const ringPath = (ring) => ring.map((point, index) => { const [x, y] = mapPoint(point); return `${index ? 'L' : 'M'}${x.toFixed(SVG_COORDINATE_PRECISION)},${y.toFixed(SVG_COORDINATE_PRECISION)}`; }).join(' ') + (isAreaGeometry(geometry) ? ' Z' : '');
  const d = allRings(geometry).map(ringPath).join(' ');
  const pathStyle = isAreaGeometry(geometry)
    ? 'fill="#6c9f84" fill-rule="evenodd"'
    : 'fill="none" stroke="#2b6cb0" stroke-width="0.15" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${viewWidth.toFixed(6)} ${viewHeight.toFixed(6)}" preserveAspectRatio="xMidYMid meet"><path d="${d}" ${pathStyle}/></svg>\n`;
}

async function loadCoastline(full, relationId, outputDir, stem, { reuseCache = false, keepRaw = false } = {}) {
  const relationBbox = relationMemberBbox(full, relationId);
  const queryBbox = coastlineQueryBbox(relationBbox);
  const bboxText = queryBbox.map((value) => value.toFixed(6));
  const query = `[out:json][timeout:25];way["natural"="coastline"](${bboxText[0]},${bboxText[1]},${bboxText[2]},${bboxText[3]});out geom;`;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
  const cacheFile = `.${stem}.coastline-${sha256(query).slice(0, 16)}.json`;
  const cachePath = path.join(outputDir, cacheFile);
  let fetched;
  let fromCache = false;
  if (reuseCache) {
    try {
      const text = await fs.readFile(cachePath, 'utf8');
      fetched = { text, json: JSON.parse(text) };
      fromCache = true;
    } catch (error) {
      if (error.code !== 'ENOENT') fetched = null;
    }
  }
  if (!fetched) fetched = await fetchJson(url);
  if (keepRaw || reuseCache) await fs.writeFile(cachePath, fetched.text, 'utf8');
  return { ...fetched, url, query, relationBbox, queryBbox, cacheFile, fromCache };
}

function usage() { console.error('Usage: node convert_osm_boundary.mjs --name NAME --context CONTEXT [--kind KIND] [--osm-type relation|way --osm-id ID] --output-dir DIR [--deep] [--no-svg] [--keep-raw] [--reuse-cache]'); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(args['output-dir'] ?? 'outputs');
  const explicitType = args['osm-type'] ? String(args['osm-type']) : null;
  const explicitId = args['osm-id'] ? String(args['osm-id']) : null;
  const name = args.name ? String(args.name) : null;
  const context = args.context ? String(args.context) : '';
  const requestedKind = args.kind ? String(args.kind) : null;
  if (args.help) { usage(); return; }
  if (!explicitId && !name) { usage(); fail('Provide --name or both --osm-type and --osm-id'); }
  if (explicitId && !explicitType) fail('--osm-type is required with --osm-id');
  if (explicitId && (!/^\d+$/.test(explicitId) || Number(explicitId) <= 0)) fail('--osm-id must be a positive integer');
  if (explicitType && explicitType !== 'relation' && explicitType !== 'way') fail('--osm-type must be relation or way');
  await fs.mkdir(outputDir, { recursive: true });

  let discovery = null;
  let osmType = explicitType;
  let osmId = explicitId;
  let inferredKind = null;
  let discoveredContext = '';
  let discoveryCacheFile = null;
  let priorMetadata = null;
  if (!osmId && args['reuse-cache']) {
    const reusable = await findReusableTarget(outputDir, name, requestedKind, context);
    if (reusable) {
      priorMetadata = reusable.metadata;
      osmType = reusable.osmType;
      osmId = reusable.osmId;
      inferredKind = priorMetadata.kind ?? null;
      discoveredContext = priorMetadata.context ?? '';
      discovery = priorMetadata.source?.discovery ?? null;
      discoveryCacheFile = priorMetadata.source?.discoveryCacheFile ?? null;
    }
  }
  if (!osmId) {
    const query = [name, context].filter(Boolean).join(', ');
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', extratags: '1', namedetails: '1', limit: '5', q: query }).toString();
    discoveryCacheFile = path.join(outputDir, `.nominatim-${sha256(query).slice(0, 16)}.json`);
    if (args['reuse-cache']) {
      try {
        const cachedDiscovery = JSON.parse(await fs.readFile(discoveryCacheFile, 'utf8'));
        if (cachedDiscovery.query === query && Array.isArray(cachedDiscovery.candidates)) {
          discovery = cachedDiscovery;
          discovery.fromCache = true;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') discovery = null;
      }
    }
    if (!discovery) {
      const response = await fetchJson(url);
      discovery = { url: url.toString(), query, candidates: response.json, responseSha256: sha256(response.text), fromCache: false };
      await fs.writeFile(discoveryCacheFile, `${JSON.stringify(discovery, null, 2)}\n`, 'utf8');
    }
    const candidate = selectCandidate(discovery.candidates, name, context, requestedKind);
    if (!candidate) fail(`No OSM ${requestedKind ? `${requestedKind} ` : ''}boundary candidate found for ${query}`);
    osmType = candidate.osm_type;
    osmId = String(candidate.osm_id);
    inferredKind = candidateKind(candidate);
    discoveredContext = candidateContext(candidate);
    discovery.selection = { requestedKind, inferredKind, selectedCandidate: { osmType, osmId: Number(osmId), name: candidate.name, displayName: candidate.display_name, category: candidate.category ?? candidate.class ?? null, type: candidate.type } };
  }

  const apiType = osmType === 'relation' ? 'relation' : 'way';
  const overpassQuery = `[out:json][timeout:25];relation(${osmId});(._;>>;);out body;`;
  const objectUrl = apiType === 'relation'
    ? `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`
    : `https://api.openstreetmap.org/api/0.6/${apiType}/${osmId}/full.json`;
  const stem = `${osmType === 'relation' ? 'R' : 'W'}${osmId}`;
  if (args['reuse-cache'] && !priorMetadata) {
    try {
      priorMetadata = JSON.parse(await fs.readFile(path.join(outputDir, `${stem}.metadata.json`), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') priorMetadata = null;
    }
  }
  let kind = requestedKind ?? priorMetadata?.kind ?? inferredKind ?? 'boundary';
  const resolvedContext = context || priorMetadata?.context || discoveredContext;
  const explicitBoundaryDefinition = args['boundary-definition'] ? String(args['boundary-definition']) : null;
  const defaultBoundaryDefinition = '行政区域内の陸地。海域は含めず、本土と属島を独立した陸地ポリゴンとして保持する。';
  let boundaryDefinition = explicitBoundaryDefinition
    ?? (kind === 'administrative-area' ? defaultBoundaryDefinition : (priorMetadata?.boundaryDefinition ?? null));
  const priorReferenceArea = priorMetadata?.referenceComparison?.referenceAreaKm2;
  const referenceAreaKm2 = args['reference-area-km2'] ? Number(args['reference-area-km2']) : (Number.isFinite(priorReferenceArea) ? priorReferenceArea : null);
  const rawCachePath = path.join(outputDir, `${stem}.osm-full.json`);
  let fetched;
  let fromCache = false;
  if (args['reuse-cache']) {
    try {
      const text = await fs.readFile(rawCachePath, 'utf8');
      fetched = { text, json: JSON.parse(text) };
      fromCache = true;
    } catch (error) {
      if (error.code !== 'ENOENT') fetched = null;
    }
  }
  if (!fetched) fetched = await fetchJson(objectUrl);
  if ((args['keep-raw'] || args['reuse-cache']) && !fromCache) await fs.writeFile(rawCachePath, fetched.text, 'utf8');
  if (!requestedKind && !priorMetadata?.kind && kind === 'boundary') {
    const selected = fetched.json?.elements?.find((item) => item.type === apiType && String(item.id) === String(osmId));
    kind = kindFromTags(selected?.tags ?? {}) ?? kind;
  }
  if (!explicitBoundaryDefinition) boundaryDefinition = kind === 'administrative-area' ? defaultBoundaryDefinition : (priorMetadata?.boundaryDefinition ?? null);
  const relation = apiType === 'relation'
    ? fetched.json?.elements?.find((item) => item.type === 'relation' && String(item.id) === String(osmId))
    : null;
  const hasDirectSubarea = Boolean((relation?.members ?? []).some((member) => member.type === 'relation' && member.role === 'subarea'));
  const needsCoastlineLandMask = apiType === 'relation'
    && kind === 'administrative-area'
    && relationHasMaritimeOuter(fetched.json, osmId)
    && !hasDirectSubarea;
  const coastline = needsCoastlineLandMask
    ? await loadCoastline(fetched.json, osmId, outputDir, stem, { reuseCache: Boolean(args['reuse-cache']), keepRaw: Boolean(args['keep-raw']) })
    : null;
  const built = apiType === 'relation'
    ? relationGeometry(fetched.json, osmId, { coastlineResponse: coastline?.json })
    : wayGeometry(fetched.json, osmId);
  const geometry = built.geometry;
  const subareaAudit = built.subareaAudit ?? null;
  const areaGeometry = isAreaGeometry(geometry);
  const lineGeometry = geometry.type === 'LineString';
  const bbox = bboxOf(geometry);
  if (!coordinatesAreValid(geometry)) fail('Geometry contains invalid or out-of-range coordinates');
  if (bbox[2] - bbox[0] > 180) fail('Antimeridian-crossing geometry requires an antimeridian-aware transform; refusing an incorrect ratio');
  if (areaGeometry && bbox[3] <= bbox[1]) fail('Area geometry has no positive latitude span');
  if (!areaGeometry && bbox[2] <= bbox[0] && bbox[3] <= bbox[1]) fail('Line geometry has no extent');
  const areaKm2 = sphericalAreaKm2(geometry);
  const lineLength = lineLengthKm(geometry);
  const longitudeSpan = bbox[2] - bbox[0];
  const latitudeSpan = bbox[3] - bbox[1];
  const centerLat = (bbox[1] + bbox[3]) / 2;
  const coordinateBboxAspectRatio = latitudeSpan > 0 ? longitudeSpan / latitudeSpan : null;
  const projectedAspectRatio = longitudeSpan > 0 && latitudeSpan > 0
    ? (longitudeSpan * Math.cos(centerLat * Math.PI / 180)) / latitudeSpan
    : null;
  const svgPaddingRatio = 0.04;
  const svgBounds = svgViewport(bbox, svgPaddingRatio);
  const svgCanvasAspectRatio = svgBounds.viewHeight > 0 ? svgBounds.viewWidth / svgBounds.viewHeight : 1;
  const svgDimensions = rasterDimensions(svgCanvasAspectRatio);
  const svgQuantizationErrorPxValue = svgQuantizationErrorPx(svgBounds.viewWidth, svgBounds.viewHeight, svgDimensions.width, svgDimensions.height);
  const maskDimensions = rasterDimensions(projectedAspectRatio);
  const rings = allRings(geometry);
  const deepChecks = args.deep ? { selfIntersectionCount: rings.reduce((sum, ring) => sum + selfIntersectionCount(ring, areaGeometry), 0) } : null;
  if (deepChecks && deepChecks.selfIntersectionCount > 0) fail(`Self-intersections found: ${deepChecks.selfIntersectionCount}`);
  const resolvedName = name ?? priorMetadata?.name ?? built.relation?.tags?.name ?? built.tags?.name ?? `${osmType}:${osmId}`;
  const areaRatio = areaKm2 != null && Number.isFinite(referenceAreaKm2) && referenceAreaKm2 > 0 ? areaKm2 / referenceAreaKm2 : null;
  const areaDifferencePercent = areaRatio == null ? null : (areaRatio - 1) * 100;
  const geometryAreaKm2 = areaKm2 == null ? null : Number(areaKm2.toFixed(8));
  const lineLengthKmValue = lineLength == null ? null : Number(lineLength.toFixed(8));
  const projectedAspectRatioValue = projectedAspectRatio == null ? null : Number(projectedAspectRatio.toFixed(8));
  const coordinateBboxAspectRatioValue = coordinateBboxAspectRatio == null ? null : Number(coordinateBboxAspectRatio.toFixed(8));
  const svgCanvasAspectRatioValue = Number(svgCanvasAspectRatio.toFixed(8));
  const geometrySummary = {
    type: geometry.type,
    bbox,
    areaKm2: geometryAreaKm2,
    lineLengthKm: lineLengthKmValue,
    vertexCount: rings.reduce((sum, ring) => sum + ring.length, 0),
    ringCount: areaGeometry ? rings.length : 0,
    componentCount: geometry.type === 'MultiPolygon' ? geometry.coordinates.length : (areaGeometry ? 1 : 0),
    closed: areaGeometry,
    boundaryStatus: areaGeometry ? 'closed-area-boundary' : 'open-linear-feature',
    coordinateBboxAspectRatio: coordinateBboxAspectRatioValue,
    projectedAspectRatio: projectedAspectRatioValue,
    subareaAudit,
  };
  const geojson = { type: 'Feature', properties: { name: resolvedName, kind, context: resolvedContext, boundaryDefinition, geometryType: geometry.type, boundaryStatus: geometrySummary.boundaryStatus, osmType, osmId: Number(osmId), boundarySourceUrl: `https://www.openstreetmap.org/${osmType}/${osmId}`, license: 'OpenStreetMap contributors, ODbL 1.0' }, geometry };
  await fs.writeFile(path.join(outputDir, `${stem}.geojson`), `${JSON.stringify(geojson, null, 2)}\n`, 'utf8');
  if (!args['no-svg']) {
    await fs.writeFile(path.join(outputDir, `${stem}.preview.svg`), svgText(geometry, bbox, svgDimensions.width, svgDimensions.height, svgPaddingRatio), 'utf8');
  }
  if (args['keep-raw'] || args['reuse-cache']) await fs.writeFile(rawCachePath, fetched.text, 'utf8');
  const svgExport = args['no-svg'] ? null : { file: `${stem}.preview.svg`, width: svgDimensions.width, height: svgDimensions.height, aspectRatio: svgCanvasAspectRatioValue, contentAspectRatio: projectedAspectRatioValue, coordinatePrecision: SVG_COORDINATE_PRECISION, quantizationErrorPx: svgQuantizationErrorPxValue, projection: 'local equirectangular, one x/y scale', mode: lineGeometry ? 'line' : 'area' };
  const pngMaskExport = lineGeometry
    ? { supported: false, reason: 'An open LineString has no area to rasterize as a mask' }
    : { supported: true, recommendedWidth: maskDimensions.width, recommendedHeight: maskDimensions.height, aspectRatio: projectedAspectRatioValue, rendered: false };
  const validationChecks = areaGeometry
    ? ['GeoJSON structure', 'closed rings', 'coordinate range', 'outer/inner assignment', 'disconnected land components preserved', 'subarea relation audit', ...(subareaAudit?.landMask?.applied ? ['coastline land mask and island extraction'] : []), 'aspect-preserving dimensions']
    : ['GeoJSON structure', 'coordinate range', 'OSM way node order preserved', 'open linear feature preserved', 'line preview dimensions recorded'];
  const validationStatus = lineGeometry
    ? 'passed-with-note'
    : subareaAudit?.landMask?.applied
      ? 'passed-with-coastline-land-mask'
    : subareaAudit?.directRelationCount
      ? 'passed-with-subarea-audit'
      : 'passed';
  const metadata = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    name: resolvedName,
    kind,
    context: resolvedContext,
    boundaryDefinition,
    source: { osmType, osmId: Number(osmId), objectUrl, responseSha256: sha256(fetched.text), discovery, discoveryCacheFile: discoveryCacheFile ? path.basename(discoveryCacheFile) : null, fromCache, rawResponseFile: (args['keep-raw'] || args['reuse-cache']) ? `${stem}.osm-full.json` : null, coastline: coastline ? { url: coastline.url, query: coastline.query, relationBbox: coastline.relationBbox, queryBbox: coastline.queryBbox, responseSha256: sha256(coastline.text), fromCache: coastline.fromCache, responseFile: (args['keep-raw'] || args['reuse-cache']) ? coastline.cacheFile : null } : null },
    geometry: geometrySummary,
    referenceComparison: { referenceAreaKm2: Number.isFinite(referenceAreaKm2) ? referenceAreaKm2 : null, areaRatio, areaDifferencePercent },
    export: { svg: svgExport, pngMask: pngMaskExport },
    validation: { status: validationStatus, checks: validationChecks, deepChecksRequested: Boolean(args.deep), deepChecks, subareaAudit },
    files: { geojson: `${stem}.geojson`, metadata: `${stem}.metadata.json`, previewSvg: args['no-svg'] ? null : `${stem}.preview.svg`, discoveryCache: discoveryCacheFile ? path.basename(discoveryCacheFile) : null, coastlineResponse: coastline && (args['keep-raw'] || args['reuse-cache']) ? coastline.cacheFile : null },
  };
  await fs.writeFile(path.join(outputDir, `${stem}.metadata.json`), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  const consoleSubareaAudit = subareaAudit ? {
    directRelationCount: subareaAudit.directRelationCount,
    resolvedRelationCount: subareaAudit.resolvedRelationCount,
    directGeometryRelationCount: subareaAudit.directGeometryRelationCount,
    directComponentCount: subareaAudit.directComponentCount,
    candidateComponentCount: subareaAudit.candidateComponentCount,
    addedComponentCount: subareaAudit.addedComponentCount,
    missingRelationIds: subareaAudit.missingRelationIds,
    cycleCount: subareaAudit.cycleCount,
    sourceMode: subareaAudit.sourceMode,
    landMaskApplied: Boolean(subareaAudit.landMask?.applied),
    islandComponentCount: subareaAudit.landMask?.islandComponentCount ?? 0,
    coastlineWayCount: subareaAudit.landMask?.coastlineWayCount ?? 0,
  } : null;
  console.log(JSON.stringify({ osm: `${osmType}:${osmId}`, geometry: geometry.type, componentCount: geometry.type === 'MultiPolygon' ? geometry.coordinates.length : (areaGeometry ? 1 : 0), areaKm2: areaKm2 == null ? null : Number(areaKm2.toFixed(6)), lineLengthKm: lineLength == null ? null : Number(lineLength.toFixed(6)), projectedAspectRatio: projectedAspectRatioValue, canvasAspectRatio: svgCanvasAspectRatioValue, validationStatus, subareaAudit: consoleSubareaAudit, fromCache, outputDir }, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message || String(error)); process.exitCode = 1; });
