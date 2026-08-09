#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const USER_AGENT = 'Codex osm-boundary-conversion/3.0';
const REQUEST_TIMEOUT_MS = 15_000;
const OVERPASS_REQUEST_TIMEOUT_MS = 25_000;
const OVERPASS_QUERY_TIMEOUT_SECONDS = 35;
const OVERPASS_ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const RELATION_PARENT_ENDPOINTS = [OVERPASS_ENDPOINTS[1], OVERPASS_ENDPOINTS[0], OVERPASS_ENDPOINTS[2]];
const RELATION_EXPANDED_ENDPOINTS = [OVERPASS_ENDPOINTS[2], OVERPASS_ENDPOINTS[1], OVERPASS_ENDPOINTS[0]];
const EARTH_RADIUS_M = 6_371_008.8;

function fail(message) { throw new Error(message); }

const BOOLEAN_ARGS = new Set(['help', 'deep', 'no-svg', 'keep-raw', 'reuse-cache']);
const VALUE_ARGS = new Set(['name', 'context', 'kind', 'osm-type', 'osm-id', 'output-dir', 'cache-dir', 'boundary-definition', 'reference-area-km2']);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) fail(`Unexpected positional argument: ${token}`);
    const key = token.slice(2);
    if (BOOLEAN_ARGS.has(key)) {
      args[key] = true;
      continue;
    }
    if (!VALUE_ARGS.has(key)) fail(`Unknown option: --${key}`);
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) fail(`Option --${key} requires a value`);
    args[key] = value;
    i += 1;
  }
  return args;
}

async function fetchJson(url, { method = 'GET', body = null, timeoutMs = REQUEST_TIMEOUT_MS, headers = {}, signal = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort();
  if (signal) signal.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const response = await fetch(url, {
      method,
      body,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 240)}`);
      error.status = response.status;
      throw error;
    }
    try {
      return { json: JSON.parse(text), text };
    } catch (error) {
      fail(`Invalid JSON from ${url}: ${error.message}`);
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (signal?.aborted) {
        const cancelledError = new Error(`Request cancelled: ${url}`);
        cancelledError.code = 'ECANCELLED';
        throw cancelledError;
      }
      const timeoutError = new Error(`Request timed out after ${timeoutMs} ms: ${url}`);
      timeoutError.code = 'ETIMEDOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abortFromCaller);
  }
}

function transientRequestError(error) {
  return error?.code === 'ETIMEDOUT'
    || error?.cause?.code != null
    || error?.status === 408
    || error?.status === 429
    || (Number.isFinite(error?.status) && error.status >= 500);
}

function abortableDelay(milliseconds, signal) {
  if (milliseconds <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function fetchOverpassJson(query, { endpoints = OVERPASS_ENDPOINTS, hedgeDelayMs = 1_500, fetcher = fetchJson } = {}) {
  const body = new URLSearchParams({ data: query }).toString();
  const attempts = Array(endpoints.length);
  const controllers = endpoints.map(() => new AbortController());
  let winnerIndex = null;
  let fatalError = null;
  const tasks = endpoints.map(async (url, index) => {
    const startedAt = Date.now();
    try {
      await abortableDelay(index * hedgeDelayMs, controllers[index].signal);
      if (winnerIndex != null || fatalError || controllers[index].signal.aborted) {
        const cancelled = new Error(`Request cancelled before start: ${url}`);
        cancelled.code = 'ECANCELLED';
        throw cancelled;
      }
      const fetched = await fetcher(url, {
        method: 'POST',
        body,
        timeoutMs: OVERPASS_REQUEST_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        signal: controllers[index].signal,
      });
      winnerIndex = index;
      attempts[index] = { url, status: 'succeeded', durationMs: Date.now() - startedAt };
      return { ...fetched, url, index };
    } catch (error) {
      const cancelled = error?.code === 'ECANCELLED';
      attempts[index] = { url, status: cancelled ? 'cancelled' : 'failed', httpStatus: error?.status ?? null, code: error?.code ?? null, durationMs: Date.now() - startedAt, message: String(error?.message ?? error).slice(0, 240) };
      if (!cancelled && !transientRequestError(error)) {
        fatalError = error;
        controllers.forEach((controller, controllerIndex) => { if (controllerIndex !== index) controller.abort(); });
      }
      throw error;
    }
  });
  try {
    const winner = await Promise.any(tasks);
    controllers.forEach((controller, index) => { if (index !== winner.index) controller.abort(); });
    await Promise.allSettled(tasks);
    return { json: winner.json, text: winner.text, url: winner.url, attempts: attempts.filter(Boolean) };
  } catch (error) {
    controllers.forEach((controller) => controller.abort());
    await Promise.allSettled(tasks);
    const summary = attempts.filter(Boolean).map((attempt) => `${attempt.url}: ${attempt.status === 'succeeded' ? 'ok' : attempt.httpStatus ?? attempt.code ?? 'error'}`).join('; ');
    fail(`Overpass request failed (${summary || fatalError?.message || error?.message || 'no endpoint succeeded'})`);
  }
}

function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function samePoint(a, b, tolerance = 1e-10) {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;
}

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

function canonicalRingKey(ring) {
  const points = ring.slice(0, -1).map((point) => `${point[0].toFixed(7)},${point[1].toFixed(7)}`);
  const edges = points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    return point < next ? `${point}>${next}` : `${next}>${point}`;
  }).sort();
  return sha256(edges.join(';'));
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
  return abC * abD < 0 && cdA * cdB < 0;
}

function segmentIntersectionKind(a, b, c, d) {
  if (!segmentsIntersect(a, b, c, d)) return null;
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return 'proper-crossing';
  if (samePoint(a, c) || samePoint(a, d) || samePoint(b, c) || samePoint(b, d)) return 'shared-endpoint';
  return 'touch-or-overlap';
}

function selfIntersectionDetails(ring, closed = true, limit = Infinity) {
  const details = [];
  const segmentCount = ring.length - 1;
  if (segmentCount < 2) return details;
  const [minLon, minLat, maxLon, maxLat] = ringBbox(ring);
  const gridAxisCount = Math.max(4, Math.ceil(Math.sqrt(segmentCount)));
  const cellWidth = Math.max((maxLon - minLon) / gridAxisCount, 1e-12);
  const cellHeight = Math.max((maxLat - minLat) / gridAxisCount, 1e-12);
  const grid = new Map();
  const broad = new Set();
  const priorSegments = [];
  const cellKey = (x, y) => `${x}:${y}`;
  for (let i = 0; i < segmentCount; i += 1) {
    const start = ring[i];
    const end = ring[i + 1];
    const minX = Math.floor((Math.min(start[0], end[0]) - minLon - 1e-12) / cellWidth);
    const maxX = Math.floor((Math.max(start[0], end[0]) - minLon + 1e-12) / cellWidth);
    const minY = Math.floor((Math.min(start[1], end[1]) - minLat - 1e-12) / cellHeight);
    const maxY = Math.floor((Math.max(start[1], end[1]) - minLat + 1e-12) / cellHeight);
    const cellCount = (maxX - minX + 1) * (maxY - minY + 1);
    const candidates = new Set(broad);
    if (cellCount > 512) {
      for (const prior of priorSegments) candidates.add(prior);
    } else {
      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          for (const prior of grid.get(cellKey(x, y)) ?? []) candidates.add(prior);
        }
      }
    }
    for (const j of candidates) {
      if (i === j + 1 || (closed && j === 0 && i === segmentCount - 1)) continue;
      const kind = segmentIntersectionKind(ring[j], ring[j + 1], start, end);
      if (!kind) continue;
      details.push({ segmentA: j, segmentB: i, kind, a: ring[j], b: ring[j + 1], c: start, d: end });
      if (details.length >= limit) return details;
    }
    priorSegments.push(i);
    if (cellCount > 512) {
      broad.add(i);
    } else {
      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          const key = cellKey(x, y);
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(i);
        }
      }
    }
  }
  return details;
}

function selfIntersectionCount(ring, closed = true) {
  return selfIntersectionDetails(ring, closed).length;
}

function reverseSegment(segment) {
  return { ...segment, nodes: segment.nodes.slice().reverse(), coords: segment.coords.slice().reverse() };
}

function normalizeOuterChain(chain) {
  if (signedArea(chain.ring) > 0) return chain;
  return {
    segments: chain.segments.slice().reverse().map(reverseSegment),
    ring: reverseRing(chain.ring),
  };
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

const COASTLINE_CELL_DEG = 0.002;
const COASTLINE_CONTACT_MAX_KM = 0.05;

function subareaRelationTree(full, relationId) {
  const elements = Array.isArray(full.elements) ? full.elements : [];
  const relations = new Map(elements.filter((item) => item.type === 'relation').map((item) => [String(item.id), item]));
  const root = relations.get(String(relationId));
  if (!root) fail(`Relation ${relationId} is missing from the OSM response`);
  const result = [];
  const visited = new Set();
  const visit = (relation) => {
    const key = String(relation.id);
    if (visited.has(key)) return;
    visited.add(key);
    result.push(relation);
    for (const member of relation.members ?? []) {
      if (member.type !== 'relation' || member.role !== 'subarea') continue;
      const child = relations.get(String(member.ref));
      if (child) visit(child);
    }
  };
  visit(root);
  return result;
}

function relationHasMaritimeOuter(full, relationId) {
  const elements = Array.isArray(full.elements) ? full.elements : [];
  const ways = new Map(elements.filter((item) => item.type === 'way').map((item) => [String(item.id), item]));
  return subareaRelationTree(full, relationId).some((relation) => (relation.members ?? []).some((member) => {
    if (member.type !== 'way' || member.role !== 'outer') return false;
    const maritime = normalizedText(ways.get(String(member.ref))?.tags?.maritime);
    return maritime === 'yes' || maritime === 'true';
  }));
}

function relationHasResolvableOuter(full, relationId) {
  const elements = Array.isArray(full.elements) ? full.elements : [];
  const relation = elements.find((item) => item.type === 'relation' && String(item.id) === String(relationId));
  if (!relation) return false;
  const ways = new Map(elements.filter((item) => item.type === 'way').map((item) => [String(item.id), item]));
  const nodes = new Set(elements.filter((item) => item.type === 'node').map((item) => String(item.id)));
  const outerMembers = (relation.members ?? []).filter((member) => member.type === 'way' && member.role === 'outer');
  return outerMembers.length > 0 && outerMembers.every((member) => {
    const way = ways.get(String(member.ref));
    if (!Array.isArray(way?.nodes) || way.nodes.length < 2) return false;
    return (Array.isArray(way.geometry) && way.geometry.length === way.nodes.length)
      || way.nodes.every((nodeId) => nodes.has(String(nodeId)));
  });
}

function relationMemberBbox(full, relationId) {
  const elements = Array.isArray(full.elements) ? full.elements : [];
  const nodes = new Map(elements.filter((item) => item.type === 'node').map((item) => [String(item.id), [Number(item.lon), Number(item.lat)]]));
  const ways = new Map(elements.filter((item) => item.type === 'way').map((item) => [String(item.id), item]));
  const points = [];
  for (const relation of subareaRelationTree(full, relationId)) {
    for (const member of relation.members ?? []) {
      if (member.type !== 'way') continue;
      const way = ways.get(String(member.ref));
      if (Array.isArray(way?.geometry)) {
        for (const point of way.geometry) points.push([Number(point.lon), Number(point.lat)]);
        continue;
      }
      for (const nodeId of way?.nodes ?? []) {
        const point = nodes.get(String(nodeId));
        if (point) points.push(point);
      }
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
      bbox: ringBbox(coords),
    };
  });
}

function coastlineGridKey(x, y) { return `${x}:${y}`; }

function buildCoastlineIndex(response) {
  const ways = coastlineWaysFromResponse(response);
  if (!ways.length) fail('The coastline query returned no natural=coastline ways');
  const minLon = Math.min(...ways.map((way) => way.bbox[0]));
  const minLat = Math.min(...ways.map((way) => way.bbox[1]));
  const cellSize = Math.max(COASTLINE_CELL_DEG, Math.min(0.25, Math.max(
    Math.max(...ways.map((way) => way.bbox[2])) - minLon,
    Math.max(...ways.map((way) => way.bbox[3])) - minLat,
  ) / 200));
  const segments = [];
  for (const [wayIndex, way] of ways.entries()) {
    for (let segmentIndex = 0; segmentIndex < way.coords.length - 1; segmentIndex += 1) {
      const start = way.coords[segmentIndex];
      const end = way.coords[segmentIndex + 1];
      segments.push({ wayIndex, segmentIndex, start, end, bbox: [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])] });
    }
  }
  const segmentGrid = new Map();
  const segmentBroad = new Set();
  segments.forEach((segment, index) => {
    const minX = Math.floor(segment.bbox[0] / cellSize);
    const maxX = Math.floor(segment.bbox[2] / cellSize);
    const minY = Math.floor(segment.bbox[1] / cellSize);
    const maxY = Math.floor(segment.bbox[3] / cellSize);
    if ((maxX - minX + 1) * (maxY - minY + 1) > 10_000) {
      segmentBroad.add(index);
      return;
    }
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const key = coastlineGridKey(x, y);
        if (!segmentGrid.has(key)) segmentGrid.set(key, new Set());
        segmentGrid.get(key).add(index);
      }
    }
  });
  return { ways, segments, segmentGrid, segmentBroad, cellSize };
}

function coastlineEndpointKey(point) {
  return coastlineGridKey(point[0].toFixed(7), point[1].toFixed(7));
}

function assembledCoastlineRings(coastlineIndex) {
  const rings = [];
  const accepted = new Set();
  let closedWayRingCount = 0;
  let joinedRingCount = 0;
  let joinedWayCount = 0;
  let skippedOpenComponentCount = 0;
  const addRing = (ring, source, wayIds) => {
    const normalized = normalizeOrientation(cleanClosedRing(ring), true);
    const key = canonicalRingKey(normalized);
    if (accepted.has(key)) return;
    accepted.add(key);
    rings.push({ ring: normalized, source, wayIds });
  };
  for (const way of coastlineIndex.ways.filter((candidate) => candidate.closed)) {
    addRing(way.coords, 'closed-way', [way.id]);
    closedWayRingCount += 1;
  }

  const edges = coastlineIndex.ways.filter((way) => !way.closed).map((way) => ({
    id: way.id,
    coords: cleanOpenLine(way.coords),
    startKey: coastlineEndpointKey(way.coords[0]),
    endKey: coastlineEndpointKey(way.coords.at(-1)),
  }));
  const graph = new Map();
  const addEdge = (key, edgeIndex) => {
    if (!graph.has(key)) graph.set(key, []);
    graph.get(key).push(edgeIndex);
  };
  edges.forEach((edge, edgeIndex) => {
    addEdge(edge.startKey, edgeIndex);
    addEdge(edge.endKey, edgeIndex);
  });
  const globallySeen = new Set();
  for (let seed = 0; seed < edges.length; seed += 1) {
    if (globallySeen.has(seed)) continue;
    const component = new Set();
    const queue = [seed];
    const nodeKeys = new Set();
    while (queue.length) {
      const edgeIndex = queue.pop();
      if (component.has(edgeIndex)) continue;
      component.add(edgeIndex);
      globallySeen.add(edgeIndex);
      const edge = edges[edgeIndex];
      nodeKeys.add(edge.startKey);
      nodeKeys.add(edge.endKey);
      for (const key of [edge.startKey, edge.endKey]) {
        for (const neighbor of graph.get(key) ?? []) if (!component.has(neighbor)) queue.push(neighbor);
      }
    }
    if ([...nodeKeys].some((key) => (graph.get(key) ?? []).filter((edgeIndex) => component.has(edgeIndex)).length !== 2)) {
      skippedOpenComponentCount += 1;
      continue;
    }
    const firstIndex = Math.min(...component);
    const first = edges[firstIndex];
    const used = new Set([firstIndex]);
    const coords = first.coords.map((point) => [...point]);
    const startKey = first.startKey;
    let currentKey = first.endKey;
    let valid = true;
    while (currentKey !== startKey) {
      const candidates = (graph.get(currentKey) ?? []).filter((edgeIndex) => component.has(edgeIndex) && !used.has(edgeIndex));
      if (candidates.length !== 1) { valid = false; break; }
      const edgeIndex = candidates[0];
      const edge = edges[edgeIndex];
      const forward = edge.startKey === currentKey;
      const oriented = forward ? edge.coords : edge.coords.slice().reverse();
      coords.push(...oriented.slice(1).map((point) => [...point]));
      currentKey = forward ? edge.endKey : edge.startKey;
      used.add(edgeIndex);
      if (used.size > component.size) { valid = false; break; }
    }
    if (!valid || used.size !== component.size || !samePoint(coords[0], coords.at(-1))) {
      skippedOpenComponentCount += 1;
      continue;
    }
    addRing(coords, 'joined-ways', [...used].map((edgeIndex) => edges[edgeIndex].id));
    joinedRingCount += 1;
    joinedWayCount += used.size;
  }
  return { rings, closedWayRingCount, joinedRingCount, joinedWayCount, skippedOpenComponentCount };
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

function segmentFraction(point, start, end) {
  const cosLat = Math.cos(((start[1] + end[1]) / 2) * Math.PI / 180);
  const dx = (end[0] - start[0]) * cosLat;
  const dy = end[1] - start[1];
  const px = (point[0] - start[0]) * cosLat;
  const py = point[1] - start[1];
  const denominator = dx * dx + dy * dy;
  return denominator > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / denominator)) : 0;
}

function exactSegmentIntersection(startA, endA, startB, endB) {
  const ax = endA[0] - startA[0];
  const ay = endA[1] - startA[1];
  const bx = endB[0] - startB[0];
  const by = endB[1] - startB[1];
  const denominator = ax * by - ay * bx;
  if (Math.abs(denominator) < 1e-16) {
    for (const point of [startA, endA]) {
      if (orientation(startB, endB, point) === 0 && onSegment(startB, endB, point)) {
        return { point: [...point], tA: segmentFraction(point, startA, endA), tB: segmentFraction(point, startB, endB) };
      }
    }
    return null;
  }
  const cx = startB[0] - startA[0];
  const cy = startB[1] - startA[1];
  const tA = (cx * by - cy * bx) / denominator;
  const tB = (cx * ay - cy * ax) / denominator;
  if (tA < -1e-10 || tA > 1 + 1e-10 || tB < -1e-10 || tB > 1 + 1e-10) return null;
  const boundedA = Math.max(0, Math.min(1, tA));
  return { point: [startA[0] + ax * boundedA, startA[1] + ay * boundedA], tA: boundedA, tB: Math.max(0, Math.min(1, tB)) };
}

function closestSegmentContact(parentStart, parentEnd, coastStart, coastEnd) {
  const exact = exactSegmentIntersection(parentStart, parentEnd, coastStart, coastEnd);
  if (exact) return { parentPoint: exact.point, coastPoint: exact.point, parentT: exact.tA, coastT: exact.tB, distanceKm: 0, exact: true };
  const candidates = [];
  for (const [parentPoint, parentT] of [[parentStart, 0], [parentEnd, 1]]) {
    const coastPoint = projectedPointOnSegment(parentPoint, coastStart, coastEnd);
    candidates.push({ parentPoint, coastPoint, parentT, coastT: segmentFraction(coastPoint, coastStart, coastEnd) });
  }
  for (const [coastPoint, coastT] of [[coastStart, 0], [coastEnd, 1]]) {
    const parentPoint = projectedPointOnSegment(coastPoint, parentStart, parentEnd);
    candidates.push({ parentPoint, coastPoint, parentT: segmentFraction(parentPoint, parentStart, parentEnd), coastT });
  }
  return candidates.map((candidate) => ({ ...candidate, distanceKm: haversineKm(candidate.parentPoint, candidate.coastPoint), exact: false }))
    .sort((left, right) => left.distanceKm - right.distanceKm)[0];
}

function coastlineCandidateSegments(index, point, maxDistanceKm) {
  const centerX = Math.floor(point[0] / index.cellSize);
  const centerY = Math.floor(point[1] / index.cellSize);
  const radius = Math.max(2, Math.ceil((maxDistanceKm / 110) / index.cellSize) + 1);
  const candidates = new Set(index.segmentBroad);
  for (let x = centerX - radius; x <= centerX + radius; x += 1) {
    for (let y = centerY - radius; y <= centerY + radius; y += 1) {
      for (const segmentIndex of index.segmentGrid.get(coastlineGridKey(x, y)) ?? []) candidates.add(segmentIndex);
    }
  }
  return candidates;
}

function findCoastlineContact(ring, startIndex, direction, coastlineIndex, label) {
  const ringSize = ring.length - 1;
  let bestExact = null;
  let bestNear = null;
  let nearRunMisses = 0;
  for (let offset = 0; offset < ringSize; offset += 1) {
    const segmentIndex = direction > 0
      ? (startIndex + offset) % ringSize
      : ((startIndex - 1 - offset) % ringSize + ringSize) % ringSize;
    const parentStart = ring[segmentIndex];
    const parentEnd = ring[(segmentIndex + 1) % ringSize];
    const midpoint = [(parentStart[0] + parentEnd[0]) / 2, (parentStart[1] + parentEnd[1]) / 2];
    const searchRadiusKm = COASTLINE_CONTACT_MAX_KM + (haversineKm(parentStart, parentEnd) / 2);
    const contacts = [];
    for (const coastlineSegmentIndex of coastlineCandidateSegments(coastlineIndex, midpoint, searchRadiusKm)) {
      const coastlineSegment = coastlineIndex.segments[coastlineSegmentIndex];
      const way = coastlineIndex.ways[coastlineSegment.wayIndex];
      const contact = closestSegmentContact(parentStart, parentEnd, coastlineSegment.start, coastlineSegment.end);
      if (contact.distanceKm > COASTLINE_CONTACT_MAX_KM) continue;
      const traversalT = direction > 0 ? contact.parentT : 1 - contact.parentT;
      contacts.push({
        index: contact.parentT <= 0.5 ? segmentIndex : (segmentIndex + 1) % ringSize,
        parentPosition: (segmentIndex + contact.parentT) % ringSize,
        parentSegmentIndex: segmentIndex,
        parentSegmentT: contact.parentT,
        parentPoint: contact.parentPoint,
        wayId: way.id,
        wayIndex: coastlineSegment.wayIndex,
        segmentIndex: coastlineSegment.segmentIndex,
        t: contact.coastT,
        point: contact.coastPoint,
        distanceKm: contact.distanceKm,
        exact: contact.exact,
        traversalT,
      });
    }
    const exactContacts = contacts.filter((contact) => contact.exact).sort((left, right) => left.traversalT - right.traversalT);
    const nearContacts = contacts.filter((contact) => !contact.exact).sort((left, right) => left.distanceKm - right.distanceKm);
    if (exactContacts.length || nearContacts.length) {
      if (exactContacts.length) bestExact = exactContacts.at(-1);
      else if (!bestExact && (!bestNear || nearContacts[0].distanceKm < bestNear.distanceKm)) bestNear = nearContacts[0];
      nearRunMisses = 0;
      continue;
    }
    if (bestExact || bestNear) {
      nearRunMisses += 1;
      if (nearRunMisses >= 2) return bestExact ?? bestNear;
    }
  }
  if (bestExact || bestNear) return bestExact ?? bestNear;
  fail(`Could not find a mainland coastline contact while resolving ${label}`);
}

function circularRingPath(ring, fromPosition, toPosition, direction = 1) {
  if (direction !== 1) fail('Only forward circular ring paths are supported');
  const ringSize = ring.length - 1;
  const normalizePosition = (position) => ((position % ringSize) + ringSize) % ringSize;
  const pointAt = (position) => {
    const normalized = normalizePosition(position);
    const index = Math.floor(normalized);
    const fraction = normalized - index;
    const start = ring[index];
    const end = ring[(index + 1) % ringSize];
    return [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction];
  };
  const from = normalizePosition(fromPosition);
  let to = normalizePosition(toPosition);
  if (to <= from + 1e-12) to += ringSize;
  const points = [pointAt(from)];
  for (let integerPosition = Math.floor(from) + 1; integerPosition < to - 1e-12; integerPosition += 1) {
    points.push(ring[integerPosition % ringSize]);
  }
  points.push(pointAt(to));
  return cleanOpenLine(points);
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
  edges.forEach((edge, index) => addEdge(coastlineEndpointKey(edge.start), index));
  const pointKey = coastlineEndpointKey;
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
      const nextKey = pointKey(edge.end);
      const nextDistance = current.distance + (edge.lengthKm ?? 0);
      if (nextDistance >= (distances.get(nextKey) ?? Infinity)) continue;
      distances.set(nextKey, nextDistance);
      previous.set(nextKey, { key: current.key, edgeIndex });
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
    points.push(...edge.coords.slice(1));
    currentKey = pointKey(edge.coords.at(-1));
  }
  if (currentKey !== endKey) fail('OSM coastline path ended at an unexpected node');
  points[points.length - 1] = [...endSnap.point];
  return cleanOpenLine(points);
}

function pointInPolygonRings(point, polygon) {
  return pointInRing(point, polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(point, hole));
}

function ringBbox(ring) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [minLon, minLat, maxLon, maxLat];
}

function bboxContains(outer, inner) {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

function ringSamplePoints(ring, limit = 16) {
  const openLength = Math.max(0, ring.length - 1);
  if (openLength <= limit) return ring.slice(0, openLength);
  return Array.from({ length: limit }, (_, index) => ring[Math.floor(index * openLength / limit)]);
}

function pointOnRingBoundary(point, ring) {
  return ring.slice(0, -1).some((start, index) => onSegment(start, ring[index + 1], point) && orientation(start, ring[index + 1], point) === 0);
}

function pointCoveredByPolygon(point, polygon) {
  if (!pointInRing(point, polygon[0]) && !pointOnRingBoundary(point, polygon[0])) return false;
  return !polygon.slice(1).some((hole) => pointInRing(point, hole) && !pointOnRingBoundary(point, hole));
}

function ringContainedByPolygon(ring, polygon, ringBounds = null, polygonBounds = null) {
  if (!bboxContains(polygonBounds ?? ringBbox(polygon[0]), ringBounds ?? ringBbox(ring))) return false;
  return ring.slice(0, -1).every((point) => pointCoveredByPolygon(point, polygon));
}

function pointOnPolygonBoundary(point, polygon) {
  return polygon.some((ring) => pointOnRingBoundary(point, ring));
}

function pointStrictlyInPolygon(point, polygon) {
  return pointInPolygonRings(point, polygon) && !pointOnPolygonBoundary(point, polygon);
}

function polygonSamplePoints(polygon) {
  const outer = polygon[0];
  const samples = [];
  for (let index = 0; index < outer.length - 1; index += 1) {
    const start = outer[index];
    const end = outer[index + 1];
    samples.push(start, [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]);
  }
  return samples;
}

function polygonsAreaOverlap(left, right) {
  const leftBbox = ringBbox(left[0]);
  const rightBbox = ringBbox(right[0]);
  if (Math.min(leftBbox[2], rightBbox[2]) - Math.max(leftBbox[0], rightBbox[0]) <= 1e-12
    || Math.min(leftBbox[3], rightBbox[3]) - Math.max(leftBbox[1], rightBbox[1]) <= 1e-12) return false;
  for (const leftRing of left) {
    for (const rightRing of right) {
      for (let leftIndex = 0; leftIndex < leftRing.length - 1; leftIndex += 1) {
        for (let rightIndex = 0; rightIndex < rightRing.length - 1; rightIndex += 1) {
          const abC = orientation(leftRing[leftIndex], leftRing[leftIndex + 1], rightRing[rightIndex]);
          const abD = orientation(leftRing[leftIndex], leftRing[leftIndex + 1], rightRing[rightIndex + 1]);
          const cdA = orientation(rightRing[rightIndex], rightRing[rightIndex + 1], leftRing[leftIndex]);
          const cdB = orientation(rightRing[rightIndex], rightRing[rightIndex + 1], leftRing[leftIndex + 1]);
          if (abC * abD < 0 && cdA * cdB < 0) return true;
        }
      }
    }
  }
  return polygonSamplePoints(left).some((point) => pointStrictlyInPolygon(point, right))
    || polygonSamplePoints(right).some((point) => pointStrictlyInPolygon(point, left));
}

function applyAdministrativeLandMask({ basePolygons, outerChains, coastlineResponse }) {
  const coastlineIndex = buildCoastlineIndex(coastlineResponse);
  const coastlineRings = assembledCoastlineRings(coastlineIndex);
  const maskedPolygons = [];
  const contacts = [];
  let maskedOuterCount = 0;
  let seaOnlyOuterCount = 0;
  for (let chainIndex = 0; chainIndex < basePolygons.length; chainIndex += 1) {
    const polygon = basePolygons[chainIndex];
    const chain = outerChains[chainIndex];
    if (!chain) {
      maskedPolygons.push(polygon);
      continue;
    }
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
    if (maritimeRanges.length === ranges.length) {
      seaOnlyOuterCount += 1;
      continue;
    }
    const maritimeFlags = ranges.map((range) => range.maritime);
    const runStarts = maritimeFlags.map((isMaritime, index) => (
      isMaritime && !maritimeFlags[(index - 1 + maritimeFlags.length) % maritimeFlags.length] ? index : -1
    )).filter((index) => index >= 0);
    if (runStarts.length !== 1) {
      fail(`Outer ring ${chainIndex} contains ${runStarts.length} disjoint maritime arcs; refusing an ambiguous land mask`);
    }
    const runStart = runStarts[0];
    let runEnd = runStart;
    while (maritimeFlags[(runEnd + 1) % maritimeFlags.length]) runEnd = (runEnd + 1) % maritimeFlags.length;
    const ringSize = ring.length - 1;
    const seaArc = { start: ranges[runStart].start % ringSize, end: ranges[runEnd].end % ringSize };
    const startContact = findCoastlineContact(ring, seaArc.start, -1, coastlineIndex, 'the start of a maritime boundary');
    const endContact = findCoastlineContact(ring, seaArc.end, 1, coastlineIndex, 'the end of a maritime boundary');
    const coast = coastlinePath(coastlineIndex, startContact, endContact);
    const coastWithConnectors = cleanOpenLine([startContact.parentPoint, ...coast, endContact.parentPoint]);
    const inland = circularRingPath(ring, endContact.parentPosition, startContact.parentPosition, 1);
    const landRing = normalizeOrientation(cleanClosedRing([...coastWithConnectors, ...inland.slice(1)]), true);
    const holes = (polygon.slice(1) ?? [])
      .filter((hole) => pointInRing(hole[0], landRing))
      .map((hole) => normalizeOrientation(hole, false));
    maskedPolygons.push([landRing, ...holes]);
    maskedOuterCount += 1;
    contacts.push({
      outerIndex: chainIndex,
      start: { parentIndex: startContact.index, parentPosition: Number(startContact.parentPosition.toFixed(9)), point: startContact.parentPoint, coastlineWayId: startContact.wayId, distanceKm: Number(startContact.distanceKm.toFixed(6)), exactIntersection: startContact.exact },
      end: { parentIndex: endContact.index, parentPosition: Number(endContact.parentPosition.toFixed(9)), point: endContact.parentPoint, coastlineWayId: endContact.wayId, distanceKm: Number(endContact.distanceKm.toFixed(6)), exactIntersection: endContact.exact },
      coastlineVertexCount: coast.length,
      connectorVertexCount: coastWithConnectors.length - coast.length,
      landVertexCount: landRing.length,
    });
  }
  const landPolygons = maskedPolygons.slice();
  const parentPolygons = basePolygons;
  const parentRecords = parentPolygons.map((polygon) => ({ polygon, bbox: ringBbox(polygon[0]) }));
  const landRecords = landPolygons.map((polygon) => ({ polygon, bbox: ringBbox(polygon[0]) }));
  const acceptedIslandKeys = new Set(landPolygons.map((polygon) => canonicalRingKey(polygon[0])));
  let islandComponentCount = 0;
  let joinedIslandComponentCount = 0;
  for (const candidate of coastlineRings.rings) {
    const islandRing = candidate.ring;
    const islandKey = canonicalRingKey(islandRing);
    if (acceptedIslandKeys.has(islandKey)) continue;
    const islandBbox = ringBbox(islandRing);
    if (!parentRecords.some((record) => ringContainedByPolygon(islandRing, record.polygon, islandBbox, record.bbox))) continue;
    if (landRecords.some((record) => ringContainedByPolygon(islandRing, record.polygon, islandBbox, record.bbox))) continue;
    acceptedIslandKeys.add(islandKey);
    landPolygons.push([islandRing]);
    landRecords.push({ polygon: [islandRing], bbox: islandBbox });
    islandComponentCount += 1;
    if (candidate.source === 'joined-ways') joinedIslandComponentCount += 1;
  }
  if (!landPolygons.length) fail('Coastline land mask produced no land polygons');
  return {
    polygons: landPolygons,
    audit: {
      applied: true,
      sourceMode: 'coastline-land-mask',
      sourcePolygonCount: basePolygons.length,
      coastlineWayCount: coastlineIndex.ways.length,
      coastlineOpenWayCount: coastlineIndex.ways.filter((way) => !way.closed).length,
      coastlineClosedWayCount: coastlineIndex.ways.filter((way) => way.closed).length,
      coastlineClosedRingCount: coastlineRings.rings.length,
      coastlineJoinedRingCount: coastlineRings.joinedRingCount,
      coastlineJoinedWayCount: coastlineRings.joinedWayCount,
      coastlineSkippedOpenComponentCount: coastlineRings.skippedOpenComponentCount,
      maskedOuterCount,
      seaOnlyOuterCount,
      islandComponentCount,
      joinedIslandComponentCount,
      resultComponentCount: landPolygons.length,
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

  const buildShape = (sourceRelation) => {
    const groups = { outer: [], inner: [] };
    for (const [memberIndex, member] of (sourceRelation.members ?? []).entries()) {
      if (member.type !== 'way' || !groups[member.role]) continue;
      const way = ways.get(String(member.ref));
      if (!way) fail(`Missing way ${member.ref} referenced by relation ${sourceRelation.id}`);
      if (!Array.isArray(way.nodes)) fail(`Way ${member.ref} has no node list`);
      const coords = Array.isArray(way.geometry) && way.geometry.length === way.nodes.length
        ? way.geometry.map((point) => [Number(point.lon), Number(point.lat)])
        : way.nodes.map((nodeId) => nodes.get(String(nodeId)));
      groups[member.role].push({
        id: `${sourceRelation.id}:${member.role}:${memberIndex}:${member.ref}`,
        role: member.role,
        nodes: way.nodes.map(String),
        coords,
        tags: way.tags ?? {},
      });
    }
    if (!groups.outer.length) return { polygons: [], outerChains: [] };
    const outerChains = joinSegmentChains(groups.outer).map(normalizeOuterChain);
    const outers = outerChains.map((chain) => chain.ring);
    const inners = groups.inner.length ? joinRings(groups.inner).map((ring) => normalizeOrientation(ring, false)) : [];
    const polygons = outers.map((outer) => [outer]);
    for (const inner of inners) {
      const owner = polygons
        .filter((polygon) => ringSamplePoints(inner).some((point) => pointInRing(point, polygon[0])))
        .sort((a, b) => Math.abs(signedArea(a[0])) - Math.abs(signedArea(b[0])))[0];
      if (!owner) fail(`An inner ring in relation ${sourceRelation.id} is outside every outer ring`);
      owner.push(inner);
    }
    return { polygons, outerChains };
  };

  const directSubareaMembers = (relation.members ?? []).filter((member) => member.type === 'relation' && member.role === 'subarea');
  const baseShape = buildShape(relation);
  const basePolygons = baseShape.polygons;
  const outerChains = baseShape.outerChains;
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
    duplicateComponentCount: 0,
    overlapConflictCount: 0,
    overlapConflicts: [],
    sourceMode: basePolygons.length ? 'parent-boundary' : 'direct-subarea-land',
    directAuditComplete: directSubareaMembers.length === 0,
    unresolvedDirectRelationIds: [],
    missingRelationIds: [],
    cycleCount: 0,
    unsupportedRelationRoles: (relation.members ?? [])
      .filter((member) => member.type === 'relation' && member.role !== 'subarea')
      .map((member) => member.role || null),
  };
  const directSubareaComponents = [];
  const visitedDirectRelations = new Set([String(relationId)]);
  for (const member of directSubareaMembers) {
    const key = String(member.ref);
    if (visitedDirectRelations.has(key)) { subareaAudit.cycleCount += 1; continue; }
    visitedDirectRelations.add(key);
    const child = relations.get(key);
    if (!child) {
      subareaAudit.unresolvedDirectRelationIds.push(key);
      if (!basePolygons.length) subareaAudit.missingRelationIds.push(key);
      continue;
    }
    subareaAudit.resolvedRelationCount += 1;
    const directShape = buildShape(child);
    if (directShape.polygons.length) {
      subareaAudit.geometryRelationCount += 1;
      subareaAudit.directGeometryRelationCount += 1;
      for (const [index, polygon] of directShape.polygons.entries()) {
        directSubareaComponents.push({ relationId: key, name: child.tags?.name ?? null, polygon, chain: directShape.outerChains[index] });
      }
    }
  }
  const uniqueDirectRelationCount = visitedDirectRelations.size - 1;
  subareaAudit.directAuditComplete = subareaAudit.resolvedRelationCount === uniqueDirectRelationCount
    && subareaAudit.directGeometryRelationCount === uniqueDirectRelationCount;
  if (basePolygons.length && directSubareaMembers.length && subareaAudit.directAuditComplete) {
    subareaAudit.sourceMode = 'parent-boundary-with-subarea-audit';
  }
  if (subareaAudit.missingRelationIds.length) {
    fail(`Missing subarea relations: ${subareaAudit.missingRelationIds.join(', ')}`);
  }
  if (!basePolygons.length && uniqueDirectRelationCount && subareaAudit.directGeometryRelationCount !== uniqueDirectRelationCount) {
    fail(`Direct subarea geometry is incomplete: ${subareaAudit.directGeometryRelationCount}/${uniqueDirectRelationCount}`);
  }

  directSubareaComponents.sort((a, b) => Math.abs(signedArea(b.polygon[0])) - Math.abs(signedArea(a.polygon[0])));
  const usingDirectSubareasAsBase = !basePolygons.length;
  const polygons = basePolygons.slice();
  const selectedOuterChains = outerChains.slice();
  const acceptedKeys = new Set(polygons.map((polygon) => canonicalRingKey(polygon[0])));
  let landMaskAudit = { applied: false, sourceMode: 'not-needed' };
  for (const component of directSubareaComponents) {
    const key = canonicalRingKey(component.polygon[0]);
    const feature = {
      relationId: Number(component.relationId),
      name: component.name,
      bbox: bboxOf({ type: 'Polygon', coordinates: component.polygon }),
      areaKm2: Number(sphericalAreaKm2({ type: 'Polygon', coordinates: component.polygon }).toFixed(8)),
      disposition: null,
    };
    if (acceptedKeys.has(key)) {
      subareaAudit.duplicateComponentCount += 1;
      feature.disposition = 'duplicate';
      subareaAudit.directComponents.push(feature);
      continue;
    }
    if (!usingDirectSubareasAsBase && polygons.some((polygon) => ringContainedByPolygon(component.polygon[0], polygon))) {
      feature.disposition = 'covered-by-parent';
      subareaAudit.directComponents.push(feature);
      continue;
    }
    const overlappingIndex = polygons.findIndex((polygon) => polygonsAreaOverlap(component.polygon, polygon));
    if (overlappingIndex >= 0) {
      subareaAudit.overlapConflictCount += 1;
      subareaAudit.overlapConflicts.push({ relationId: Number(component.relationId), name: component.name, existingComponentIndex: overlappingIndex });
      fail(`Subarea ${component.relationId} overlaps component ${overlappingIndex}; refusing non-canonical geometry`);
    }
    polygons.push(component.polygon);
    selectedOuterChains.push(component.chain);
    acceptedKeys.add(key);
    feature.disposition = usingDirectSubareasAsBase ? 'used-as-base-component' : 'added-disconnected-component';
    subareaAudit.directComponents.push(feature);
    if (!usingDirectSubareasAsBase) {
      subareaAudit.addedComponentCount += 1;
      subareaAudit.addedComponents.push(feature);
      subareaAudit.sourceMode = 'parent-boundary-with-subarea-additions';
    }
  }
  subareaAudit.directComponentCount = directSubareaComponents.length - subareaAudit.duplicateComponentCount;
  if (!polygons.length) fail(`Relation ${relationId} produced no polygon components`);
  if (coastlineResponse) {
    const masked = applyAdministrativeLandMask({ basePolygons: polygons, outerChains: selectedOuterChains, coastlineResponse });
    polygons.splice(0, polygons.length, ...masked.polygons);
    landMaskAudit = {
      ...masked.audit,
      sourceMode: usingDirectSubareasAsBase ? 'direct-subarea-coastline-land-mask' : 'coastline-land-mask',
    };
  }
  subareaAudit.candidateComponentCount = directSubareaComponents.length;
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

function validateGeometryIntegrity(geometry) {
  if (geometry.type === 'LineString') {
    if (geometry.coordinates.length < 2) fail('LineString has fewer than two coordinates');
    return { duplicateRingCount: 0, outerOrientation: null, innerOrientation: null };
  }
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  if (!polygons.length) fail('Area geometry has no polygons');
  const keys = new Set();
  let ringCount = 0;
  let holeCount = 0;
  for (const [polygonIndex, polygon] of polygons.entries()) {
    if (!polygon.length) fail(`Polygon ${polygonIndex} has no outer ring`);
    for (const [ringIndex, ring] of polygon.entries()) {
      if (ring.length < 4 || !samePoint(ring[0], ring.at(-1))) fail(`Polygon ${polygonIndex} ring ${ringIndex} is not a closed ring`);
      const area = signedArea(ring);
      if (Math.abs(area) < 1e-16) fail(`Polygon ${polygonIndex} ring ${ringIndex} has zero area`);
      if (ringIndex === 0 && area < 0) fail(`Polygon ${polygonIndex} outer ring has clockwise orientation`);
      if (ringIndex > 0 && area > 0) fail(`Polygon ${polygonIndex} inner ring has counterclockwise orientation`);
      if (ringIndex > 0 && !ringSamplePoints(ring).some((point) => pointInRing(point, polygon[0]))) fail(`Polygon ${polygonIndex} inner ring is outside its outer ring`);
      const key = canonicalRingKey(ring);
      if (keys.has(key)) fail(`Duplicate ring found in polygon ${polygonIndex}`);
      keys.add(key);
      ringCount += 1;
      if (ringIndex > 0) holeCount += 1;
    }
  }
  return { ringCount, holeCount, duplicateRingCount: 0, outerOrientation: 'counterclockwise', innerOrientation: 'clockwise' };
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

function defaultBoundaryDefinitionForKind(kind, geometryType = null) {
  const canonical = canonicalKind(kind);
  if (canonical === 'administrative-area') return '行政区域内の陸地。海域は含めず、本土と属島を独立した陸地ポリゴンとして保持する。';
  if (canonical === 'island') return 'OSMに記録された島の陸地境界。周囲の海域は含めない。';
  if (canonical === 'water') return geometryType === 'LineString'
    ? 'OSMに記録された線形の水域地物。閉じた水面を推定せず、元の線形形状を保持する。'
    : 'OSMに記録された閉じた水域境界。周囲の陸地は含めない。';
  if (canonical === 'park') return 'OSMに記録された公園または保護区域の境界。';
  if (canonical === 'facility') return 'OSMに記録された施設または敷地の外周境界。';
  return geometryType === 'LineString' ? 'OSMに記録された線形地物。' : 'OSMに記録された閉じた境界。';
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

function candidateContextTokens(context) {
  return String(context ?? '').split(/[\s,、，/]+/).map(normalizedText).filter((token) => token.length >= 2);
}

function candidateContextScore(item, context) {
  const tokens = candidateContextTokens(context);
  if (!tokens.length) return 0;
  const haystack = normalizedText([item.display_name, ...Object.values(item.address ?? {})].join(' '));
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function candidateMatchesContext(item, context) {
  const tokens = candidateContextTokens(context);
  return !tokens.length || candidateContextScore(item, context) === tokens.length;
}

function candidateMatchesKind(item, requestedKind) {
  const actual = candidateKind(item);
  return actual != null && (!requestedKind || actual === canonicalKind(requestedKind));
}

function selectCandidate(items, name, context, requestedKind) {
  const ranked = items
    .filter((item) => (item.osm_type === 'relation' || item.osm_type === 'way') && candidateNameScore(item, name) > 0 && candidateMatchesKind(item, requestedKind) && candidateMatchesContext(item, context))
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
      if (normalizedContext && (!metadata.context || !normalizedText(metadata.context).includes(normalizedContext))) continue;
      const key = `${osmType}:${osmId}`;
      if (!matches.has(key)) matches.set(key, { metadata, osmType, osmId: String(osmId) });
    } catch {
      // Ignore unrelated or incomplete metadata files while looking for a reusable target.
    }
  }
  if (matches.size > 1) fail(`Ambiguous reusable targets for ${name}; provide --osm-type/--osm-id`);
  return matches.values().next().value ?? null;
}

const SVG_COORDINATE_PRECISION = 3;
const SVG_MAX_QUANTIZATION_ERROR_PX = 0.25;
const SVG_MAX_ASPECT_RATIO_ERROR_PERCENT = 0.1;

function svgQuantizationErrorPx() {
  return 0.5 * (10 ** -SVG_COORDINATE_PRECISION);
}

function svgViewport(bbox, paddingRatio) {
  const lonScale = Math.cos(((bbox[1] + bbox[3]) / 2) * Math.PI / 180);
  const rawContentWidth = (bbox[2] - bbox[0]) * lonScale;
  const rawContentHeight = bbox[3] - bbox[1];
  const fallbackExtent = Math.max(rawContentWidth, rawContentHeight, 1e-9);
  const contentWidth = Math.max(rawContentWidth, fallbackExtent * 0.02);
  const contentHeight = Math.max(rawContentHeight, fallbackExtent * 0.02);
  const contentOffsetX = (contentWidth - rawContentWidth) / 2;
  const contentOffsetY = (contentHeight - rawContentHeight) / 2;
  const paddingX = contentWidth * paddingRatio;
  const paddingY = contentHeight * paddingRatio;
  return { lonScale, rawContentWidth, rawContentHeight, contentWidth, contentHeight, contentOffsetX, contentOffsetY, paddingX, paddingY, viewWidth: contentWidth + paddingX * 2, viewHeight: contentHeight + paddingY * 2 };
}

function rasterDimensions(aspectRatio) {
  const safeRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  return safeRatio >= 1
    ? { width: 2048, height: Math.max(1, Math.round(2048 / safeRatio)) }
    : { width: Math.max(1, Math.round(2048 * safeRatio)), height: 2048 };
}

function svgTransform(bbox, width, height, paddingRatio) {
  const bounds = svgViewport(bbox, paddingRatio);
  const scale = Math.min(width / bounds.viewWidth, height / bounds.viewHeight);
  if (!Number.isFinite(scale) || scale <= 0) fail('SVG transform has an invalid scale');
  return {
    ...bounds,
    width,
    height,
    scale,
    offsetX: (width - bounds.viewWidth * scale) / 2,
    offsetY: (height - bounds.viewHeight * scale) / 2,
    viewBox: [0, 0, width, height],
  };
}

function svgText(geometry, bbox, transform) {
  const mapPoint = ([lon, lat]) => [
    transform.offsetX + (transform.paddingX + transform.contentOffsetX + (lon - bbox[0]) * transform.lonScale) * transform.scale,
    transform.offsetY + (transform.paddingY + transform.contentOffsetY + (bbox[3] - lat)) * transform.scale,
  ];
  const ringPath = (ring) => ring.map((point, index) => { const [x, y] = mapPoint(point); return `${index ? 'L' : 'M'}${x.toFixed(SVG_COORDINATE_PRECISION)},${y.toFixed(SVG_COORDINATE_PRECISION)}`; }).join(' ') + (isAreaGeometry(geometry) ? ' Z' : '');
  const d = allRings(geometry).map(ringPath).join(' ');
  const pathStyle = isAreaGeometry(geometry)
    ? 'fill="#6c9f84" fill-rule="evenodd"'
    : 'fill="none" stroke="#2b6cb0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${transform.width}" height="${transform.height}" viewBox="${transform.viewBox.join(' ')}" preserveAspectRatio="xMidYMid meet" shape-rendering="geometricPrecision"><path d="${d}" ${pathStyle}/></svg>\n`;
}

function relationBoundaryQuery(relationId, { includeDirectSubareas = false } = {}) {
  if (!includeDirectSubareas) {
    return `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_SECONDS}];relation(${relationId})->.root;way(r.root)->.ways;.root out body;.ways out body geom;`;
  }
  return `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_SECONDS}];relation(${relationId})->.root;relation(r.root:"subarea")->.subareas;(.root;.subareas;)->.relations;way(r.relations)->.ways;.relations out body;.ways out body geom;`;
}

async function loadCoastline(full, relationId, cacheDir, stem, { reuseCache = false, keepRaw = false } = {}) {
  const relationBbox = relationMemberBbox(full, relationId);
  const queryBbox = coastlineQueryBbox(relationBbox);
  const bboxText = queryBbox.map((value) => value.toFixed(6));
  const query = `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_SECONDS}];way["natural"="coastline"](${bboxText[0]},${bboxText[1]},${bboxText[2]},${bboxText[3]});out geom;`;
  const cacheFile = `.${stem}.coastline-${sha256(query).slice(0, 16)}.json`;
  const cacheSourceFile = cacheFile.replace(/\.json$/, '.source.json');
  const cachePath = path.join(cacheDir, cacheFile);
  const cacheSourcePath = path.join(cacheDir, cacheSourceFile);
  let fetched;
  let fromCache = false;
  if (reuseCache) {
    try {
      const text = await fs.readFile(cachePath, 'utf8');
      let provenance = {};
      try { provenance = JSON.parse(await fs.readFile(cacheSourcePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fetched = { text, json: JSON.parse(text), url: provenance.url ?? null, attempts: provenance.attempts ?? [] };
      fromCache = true;
    } catch (error) {
      if (error.code !== 'ENOENT') fetched = null;
    }
  }
  if (!fetched) fetched = await fetchOverpassJson(query);
  if (keepRaw || reuseCache) {
    await fs.writeFile(cachePath, fetched.text, 'utf8');
    if (!fromCache) await fs.writeFile(cacheSourcePath, `${JSON.stringify({ url: fetched.url, attempts: fetched.attempts ?? [], querySha256: sha256(query), fetchedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  }
  return { ...fetched, url: fetched.url ?? null, query, relationBbox, queryBbox, cacheFile, cacheSourceFile, cachePath, cacheSourcePath, fromCache };
}

function outputReference(outputDir, targetPath) {
  return path.relative(outputDir, targetPath).split(path.sep).join('/') || '.';
}

function usage() { console.error('Usage: node convert_osm_boundary.mjs (--name NAME [--context CONTEXT] [--kind KIND] | --osm-type relation|way --osm-id ID [--name NAME] [--kind KIND]) --output-dir DIR [--cache-dir DIR] [--boundary-definition TEXT] [--reference-area-km2 NUMBER] [--deep] [--no-svg] [--keep-raw] [--reuse-cache]'); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(args['output-dir'] ?? 'outputs');
  const cacheDir = path.resolve(args['cache-dir'] ?? outputDir);
  const explicitType = args['osm-type'] ? String(args['osm-type']) : null;
  const explicitId = args['osm-id'] ? String(args['osm-id']) : null;
  const name = args.name ? String(args.name) : null;
  const context = args.context ? String(args.context) : '';
  const requestedKind = args.kind ? String(args.kind) : null;
  if (args.help) { usage(); return; }
  if (!explicitId && !name) { usage(); fail('Provide --name or both --osm-type and --osm-id'); }
  if (explicitId && !explicitType) fail('--osm-type is required with --osm-id');
  if (explicitType && !explicitId) fail('--osm-id is required with --osm-type');
  if (explicitId && (!/^\d+$/.test(explicitId) || Number(explicitId) <= 0)) fail('--osm-id must be a positive integer');
  if (explicitType && explicitType !== 'relation' && explicitType !== 'way') fail('--osm-type must be relation or way');
  if (args['reference-area-km2'] != null && (!Number.isFinite(Number(args['reference-area-km2'])) || Number(args['reference-area-km2']) <= 0)) fail('--reference-area-km2 must be a positive number');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

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
    discoveryCacheFile = path.join(cacheDir, `.nominatim-${sha256(query).slice(0, 16)}.json`);
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
  let overpassQuery = apiType === 'relation' ? relationBoundaryQuery(osmId) : null;
  let retrievalQuery = overpassQuery;
  const objectUrl = `https://www.openstreetmap.org/${apiType}/${osmId}`;
  const apiUrl = `https://api.openstreetmap.org/api/0.6/${apiType}/${osmId}/full.json`;
  const stem = `${osmType === 'relation' ? 'R' : 'W'}${osmId}`;
  if (args['reuse-cache'] && !priorMetadata) {
    try {
      priorMetadata = JSON.parse(await fs.readFile(path.join(outputDir, `${stem}.metadata.json`), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') priorMetadata = null;
    }
  }
  let kind = canonicalKind(requestedKind ?? priorMetadata?.kind ?? inferredKind ?? 'boundary');
  const resolvedContext = context || priorMetadata?.context || discoveredContext;
  const explicitBoundaryDefinition = args['boundary-definition'] ? String(args['boundary-definition']) : null;
  let boundaryDefinition = explicitBoundaryDefinition ?? priorMetadata?.boundaryDefinition ?? defaultBoundaryDefinitionForKind(kind);
  const priorReferenceArea = priorMetadata?.referenceComparison?.referenceAreaKm2;
  const referenceAreaKm2 = args['reference-area-km2'] ? Number(args['reference-area-km2']) : (Number.isFinite(priorReferenceArea) ? priorReferenceArea : null);
  const rawCachePath = path.join(cacheDir, `${stem}.osm-full.json`);
  const rawSourceFile = `${stem}.osm-full.source.json`;
  const rawSourcePath = path.join(cacheDir, rawSourceFile);
  let fetched;
  let fromCache = false;
  if (args['reuse-cache']) {
    try {
      const text = await fs.readFile(rawCachePath, 'utf8');
      let provenance = {};
      try { provenance = JSON.parse(await fs.readFile(rawSourcePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fetched = { text, json: JSON.parse(text), url: provenance.url ?? null, attempts: provenance.attempts ?? [], queries: provenance.queries ?? [], querySha256: provenance.querySha256 ?? null };
      retrievalQuery = provenance.query ?? provenance.queries?.at(-1)?.query ?? null;
      fromCache = true;
    } catch (error) {
      if (error.code !== 'ENOENT') fetched = null;
    }
  }
  if (!fetched) {
    fetched = apiType === 'relation'
      ? { ...(await fetchOverpassJson(overpassQuery, { endpoints: RELATION_PARENT_ENDPOINTS })), queries: [{ scope: 'parent-boundary', query: overpassQuery, querySha256: sha256(overpassQuery) }] }
      : { ...(await fetchJson(apiUrl)), url: apiUrl, attempts: [{ url: apiUrl, status: 'succeeded' }], queries: [] };
    retrievalQuery = overpassQuery;
  }
  if (apiType === 'relation' && !relationHasResolvableOuter(fetched.json, osmId)) {
    const expandedQuery = relationBoundaryQuery(osmId, { includeDirectSubareas: true });
    const expanded = await fetchOverpassJson(expandedQuery, { endpoints: RELATION_EXPANDED_ENDPOINTS });
    fetched = {
      ...expanded,
      attempts: [
        ...(fetched.attempts ?? []).map((attempt) => ({ ...attempt, queryScope: 'parent-boundary' })),
        ...(expanded.attempts ?? []).map((attempt) => ({ ...attempt, queryScope: 'parent-and-direct-subareas' })),
      ],
      queries: [
        ...(fetched.queries ?? []),
        { scope: 'parent-and-direct-subareas', query: expandedQuery, querySha256: sha256(expandedQuery) },
      ],
    };
    overpassQuery = expandedQuery;
    retrievalQuery = expandedQuery;
    fromCache = false;
  }
  if ((args['keep-raw'] || args['reuse-cache']) && !fromCache) {
    await fs.writeFile(rawCachePath, fetched.text, 'utf8');
    await fs.writeFile(rawSourcePath, `${JSON.stringify({ url: fetched.url, attempts: fetched.attempts ?? [], query: retrievalQuery, queries: fetched.queries ?? [], querySha256: retrievalQuery ? sha256(retrievalQuery) : null, fetchedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  }
  if (!requestedKind && !priorMetadata?.kind && kind === 'boundary') {
    const selected = fetched.json?.elements?.find((item) => item.type === apiType && String(item.id) === String(osmId));
    kind = canonicalKind(kindFromTags(selected?.tags ?? {}) ?? kind);
  }
  if (!explicitBoundaryDefinition && !priorMetadata?.boundaryDefinition) boundaryDefinition = defaultBoundaryDefinitionForKind(kind);
  const needsCoastlineLandMask = apiType === 'relation'
    && kind === 'administrative-area'
    && relationHasMaritimeOuter(fetched.json, osmId);
  const coastline = needsCoastlineLandMask
    ? await loadCoastline(fetched.json, osmId, cacheDir, stem, { reuseCache: Boolean(args['reuse-cache']), keepRaw: Boolean(args['keep-raw']) })
    : null;
  const built = apiType === 'relation'
    ? relationGeometry(fetched.json, osmId, { coastlineResponse: coastline?.json })
    : wayGeometry(fetched.json, osmId);
  const geometry = built.geometry;
  if (!explicitBoundaryDefinition && !priorMetadata?.boundaryDefinition) boundaryDefinition = defaultBoundaryDefinitionForKind(kind, geometry.type);
  const subareaAudit = built.subareaAudit ?? null;
  const areaGeometry = isAreaGeometry(geometry);
  const lineGeometry = geometry.type === 'LineString';
  const bbox = bboxOf(geometry);
  if (!coordinatesAreValid(geometry)) fail('Geometry contains invalid or out-of-range coordinates');
  const integrity = validateGeometryIntegrity(geometry);
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
  const svgTargetAspectRatio = svgBounds.viewHeight > 0 ? svgBounds.viewWidth / svgBounds.viewHeight : 1;
  const svgDimensions = rasterDimensions(svgTargetAspectRatio);
  const svgTransformSpec = svgTransform(bbox, svgDimensions.width, svgDimensions.height, svgPaddingRatio);
  const svgCanvasAspectRatio = svgDimensions.width / svgDimensions.height;
  const svgQuantizationErrorPxValue = Number(svgQuantizationErrorPx().toFixed(6));
  if (svgQuantizationErrorPxValue > SVG_MAX_QUANTIZATION_ERROR_PX) fail(`SVG coordinate quantization exceeds ${SVG_MAX_QUANTIZATION_ERROR_PX} px`);
  const maskDimensions = rasterDimensions(projectedAspectRatio);
  const rings = allRings(geometry);
  const shouldScanSelfIntersections = areaGeometry || Boolean(args.deep);
  const selfIntersections = shouldScanSelfIntersections
    ? rings.flatMap((ring, ringIndex) => selfIntersectionDetails(ring, areaGeometry).map((detail) => ({ ringIndex, ...detail })))
    : [];
  const selfIntersectionChecks = { performed: shouldScanSelfIntersections, selfIntersectionCount: selfIntersections.length, selfIntersections: selfIntersections.slice(0, 20) };
  const deepChecks = args.deep ? selfIntersectionChecks : null;
  if (selfIntersectionChecks.performed && selfIntersectionChecks.selfIntersectionCount > 0) fail(`Self-intersections found: ${selfIntersectionChecks.selfIntersectionCount}; details=${JSON.stringify(selfIntersectionChecks.selfIntersections)}`);
  const resolvedName = name ?? priorMetadata?.name ?? built.relation?.tags?.name ?? built.tags?.name ?? `${osmType}:${osmId}`;
  const areaRatio = areaKm2 != null && Number.isFinite(referenceAreaKm2) && referenceAreaKm2 > 0 ? areaKm2 / referenceAreaKm2 : null;
  const areaDifferencePercent = areaRatio == null ? null : (areaRatio - 1) * 100;
  const geometryAreaKm2 = areaKm2 == null ? null : Number(areaKm2.toFixed(8));
  const lineLengthKmValue = lineLength == null ? null : Number(lineLength.toFixed(8));
  const projectedAspectRatioValue = projectedAspectRatio == null ? null : Number(projectedAspectRatio.toFixed(8));
  const coordinateBboxAspectRatioValue = coordinateBboxAspectRatio == null ? null : Number(coordinateBboxAspectRatio.toFixed(8));
  const svgCanvasAspectRatioValue = Number(svgCanvasAspectRatio.toFixed(8));
  const svgAspectRatioDifferencePercentValue = Number((((svgCanvasAspectRatio / svgTargetAspectRatio) - 1) * 100).toFixed(8));
  if (!args['no-svg'] && Math.abs(svgAspectRatioDifferencePercentValue) > SVG_MAX_ASPECT_RATIO_ERROR_PERCENT) {
    fail(`SVG canvas aspect-ratio error ${svgAspectRatioDifferencePercentValue}% exceeds ${SVG_MAX_ASPECT_RATIO_ERROR_PERCENT}%`);
  }
  const geometrySummary = {
    type: geometry.type,
    bbox,
    sha256: sha256(JSON.stringify(geometry)),
    areaKm2: geometryAreaKm2,
    lineLengthKm: lineLengthKmValue,
    vertexCount: rings.reduce((sum, ring) => sum + ring.length, 0),
    ringCount: areaGeometry ? rings.length : 0,
    componentCount: geometry.type === 'MultiPolygon' ? geometry.coordinates.length : (areaGeometry ? 1 : 0),
    closed: areaGeometry,
    boundaryStatus: areaGeometry ? 'closed-area-boundary' : 'open-linear-feature',
    coordinateBboxAspectRatio: coordinateBboxAspectRatioValue,
    projectedAspectRatio: projectedAspectRatioValue,
    integrity,
    subareaAudit,
  };
  const geojson = { type: 'Feature', properties: { name: resolvedName, kind, context: resolvedContext, boundaryDefinition, geometryType: geometry.type, boundaryStatus: geometrySummary.boundaryStatus, osmType, osmId: Number(osmId), boundarySourceUrl: `https://www.openstreetmap.org/${osmType}/${osmId}`, license: 'OpenStreetMap contributors, ODbL 1.0' }, geometry };
  const geojsonText = `${JSON.stringify(geojson, null, 2)}\n`;
  const geojsonSha256 = sha256(geojsonText);
  await fs.writeFile(path.join(outputDir, `${stem}.geojson`), geojsonText, 'utf8');
  if (!args['no-svg']) {
    await fs.writeFile(path.join(outputDir, `${stem}.preview.svg`), svgText(geometry, bbox, svgTransformSpec), 'utf8');
  }
  const svgExport = args['no-svg'] ? null : { file: `${stem}.preview.svg`, width: svgDimensions.width, height: svgDimensions.height, viewBox: svgTransformSpec.viewBox, coordinateUnits: 'pixels', aspectRatio: svgCanvasAspectRatioValue, contentAspectRatio: projectedAspectRatioValue, aspectRatioDifferencePercent: svgAspectRatioDifferencePercentValue, maxAspectRatioDifferencePercent: SVG_MAX_ASPECT_RATIO_ERROR_PERCENT, paddingRatio: svgPaddingRatio, coordinatePrecision: SVG_COORDINATE_PRECISION, quantizationErrorPx: svgQuantizationErrorPxValue, maxQuantizationErrorPx: SVG_MAX_QUANTIZATION_ERROR_PX, simplificationTolerance: 0, projection: 'local equirectangular, one x/y scale', yAxisInverted: true, mode: lineGeometry ? 'line' : 'area' };
  const pngMaskExport = lineGeometry
    ? { supported: false, reason: 'An open LineString has no area to rasterize as a mask' }
    : { supported: true, recommendedWidth: maskDimensions.width, recommendedHeight: maskDimensions.height, aspectRatio: projectedAspectRatioValue, rendered: false };
  const subareaValidationChecks = !subareaAudit?.directRelationCount
    ? []
    : subareaAudit.directAuditComplete
      ? ['direct subarea relation audit']
      : ['parent boundary used independently of unresolved direct subareas'];
  const validationChecks = areaGeometry
    ? ['GeoJSON structure', 'closed rings', 'coordinate range', 'outer/inner assignment', 'no self-intersections', 'disconnected land components preserved', ...subareaValidationChecks, ...(subareaAudit?.landMask?.applied ? ['coastline land mask and island extraction'] : []), 'aspect-preserving dimensions', ...(!args['no-svg'] ? ['pixel-space SVG serialization, quantization bound, and canvas ratio bound'] : [])]
    : ['GeoJSON structure', 'coordinate range', 'OSM way node order preserved', 'open linear feature preserved', ...(!args['no-svg'] ? ['line preview dimensions and quantization bound'] : [])];
  const validationStatus = lineGeometry
    ? 'passed-with-note'
    : subareaAudit?.landMask?.applied
      ? 'passed-with-coastline-land-mask'
    : subareaAudit?.directRelationCount && subareaAudit.directAuditComplete
      ? 'passed-with-subarea-audit'
      : 'passed';
  const retainsRaw = Boolean(args['keep-raw'] || args['reuse-cache']);
  const discoveryCacheReference = discoveryCacheFile ? outputReference(outputDir, discoveryCacheFile) : null;
  const rawResponseReference = retainsRaw ? outputReference(outputDir, rawCachePath) : null;
  const rawSourceReference = retainsRaw ? outputReference(outputDir, rawSourcePath) : null;
  const coastlineResponseReference = coastline && retainsRaw ? outputReference(outputDir, coastline.cachePath) : null;
  const coastlineSourceReference = coastline && retainsRaw ? outputReference(outputDir, coastline.cacheSourcePath) : null;
  const metadata = {
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    name: resolvedName,
    kind,
    context: resolvedContext,
    boundaryDefinition,
    source: {
      osmType,
      osmId: Number(osmId),
      objectUrl,
      responseSha256: sha256(fetched.text),
      discovery,
      discoveryCacheFile: discoveryCacheReference,
      fromCache,
      cacheDirectory: outputReference(outputDir, cacheDir),
      rawResponseFile: rawResponseReference,
      rawResponseSourceFile: rawSourceReference,
      retrieval: {
        service: apiType === 'relation' ? 'Overpass API' : 'OpenStreetMap API',
        url: fetched.url ?? priorMetadata?.source?.retrieval?.url ?? (apiType === 'way' ? apiUrl : null),
        query: retrievalQuery,
        querySha256: retrievalQuery ? sha256(retrievalQuery) : (fetched.querySha256 ?? null),
        queries: fetched.queries ?? [],
        attempts: fetched.attempts ?? [],
        sourceFile: rawSourceReference,
        fromCache,
      },
      coastline: coastline ? {
        url: coastline.url,
        query: coastline.query,
        relationBbox: coastline.relationBbox,
        queryBbox: coastline.queryBbox,
        responseSha256: sha256(coastline.text),
        attempts: coastline.attempts ?? [],
        sourceFile: coastlineSourceReference,
        fromCache: coastline.fromCache,
        responseFile: coastlineResponseReference,
      } : null,
    },
    geometry: geometrySummary,
    referenceComparison: { referenceAreaKm2: Number.isFinite(referenceAreaKm2) ? referenceAreaKm2 : null, areaRatio, areaDifferencePercent },
    export: { svg: svgExport, pngMask: pngMaskExport },
    validation: { status: validationStatus, checks: validationChecks, selfIntersectionChecks, deepChecksRequested: Boolean(args.deep), deepChecks, subareaAudit },
    files: { geojson: `${stem}.geojson`, geojsonSha256, metadata: `${stem}.metadata.json`, previewSvg: args['no-svg'] ? null : `${stem}.preview.svg`, discoveryCache: discoveryCacheReference, rawResponse: rawResponseReference, rawResponseSource: rawSourceReference, coastlineResponse: coastlineResponseReference, coastlineResponseSource: coastlineSourceReference },
  };
  await fs.writeFile(path.join(outputDir, `${stem}.metadata.json`), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  const consoleSubareaAudit = subareaAudit ? {
    directRelationCount: subareaAudit.directRelationCount,
    resolvedRelationCount: subareaAudit.resolvedRelationCount,
    directGeometryRelationCount: subareaAudit.directGeometryRelationCount,
    directAuditComplete: subareaAudit.directAuditComplete,
    unresolvedDirectRelationIds: subareaAudit.unresolvedDirectRelationIds,
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
  console.log(JSON.stringify({ osm: `${osmType}:${osmId}`, geometry: geometry.type, componentCount: geometry.type === 'MultiPolygon' ? geometry.coordinates.length : (areaGeometry ? 1 : 0), areaKm2: areaKm2 == null ? null : Number(areaKm2.toFixed(6)), lineLengthKm: lineLength == null ? null : Number(lineLength.toFixed(6)), projectedAspectRatio: projectedAspectRatioValue, canvasAspectRatio: svgCanvasAspectRatioValue, validationStatus, subareaAudit: consoleSubareaAudit, fromCache, outputDir, cacheDir }, null, 2));
}

export {
  SVG_MAX_ASPECT_RATIO_ERROR_PERCENT,
  SVG_MAX_QUANTIZATION_ERROR_PX,
  applyAdministrativeLandMask,
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
  wayGeometry,
};

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  main().catch((error) => { console.error(error.stack || error.message || String(error)); process.exitCode = 1; });
}
