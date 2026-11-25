const PREFECTURE_URL = 'https://raw.githubusercontent.com/geolonia/prefecture-tiles/master/prefectures.geojson';
const MUNICIPALITY_BASE = 'https://geolonia.github.io/japanese-admins';
let catalogPromise, prefecturePromise;
const images = new Map();
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('図形を取得できませんでした。通信を確認して再度お試しください。');
  return response.json();
}
export function loadShapeCatalog() {
  return catalogPromise ||= json(new URL('./assets/shape-catalog.json', import.meta.url)).catch(error => { catalogPromise = null; throw error; });
}
export function normalizeShapeSearch(value) {
  return String(value).normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g, character => String.fromCharCode(character.charCodeAt(0) - 0x60));
}
async function geometry(target) {
  if (target.kind === 'nauru') return json(new URL('./assets/nauru-boundary.json', import.meta.url));
  if (target.kind === 'prefecture') {
    const collection = await (prefecturePromise ||= json(PREFECTURE_URL).catch(error => { prefecturePromise = null; throw error; }));
    return collection.features.find(feature => String(feature.properties.code).padStart(2, '0') === target.prefCode);
  }
  try { return await json(`${MUNICIPALITY_BASE}/${target.prefCode}/${target.adminCode}.json`); }
  catch (error) {
    if (!target.shortName.endsWith('市')) throw error;
    const catalog = await loadShapeCatalog();
    const wards = catalog.municipalities.filter(ward => ward.prefCode === target.prefCode && ward.id !== target.id && ward.shortName.startsWith(target.shortName) && ward.shortName.endsWith('区'));
    if (!wards.length) throw error;
    const sources = await Promise.all(wards.map(ward => json(`${MUNICIPALITY_BASE}/${ward.prefCode}/${ward.adminCode}.json`)));
    return { type: 'FeatureCollection', features: sources.flatMap(source => source.type === 'FeatureCollection' ? source.features : [source]) };
  }
}
export function geometrySvg(source) {
  const polygons = [];
  function visit(item) {
    if (!item) return;
    if (item.type === 'FeatureCollection') item.features.forEach(visit);
    else if (item.type === 'Feature') visit(item.geometry);
    else if (item.type === 'GeometryCollection') item.geometries.forEach(visit);
    else if (item.type === 'Polygon') polygons.push(item.coordinates);
    else if (item.type === 'MultiPolygon') polygons.push(...item.coordinates);
  }
  visit(source);
  const points = polygons.flat(2).filter(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (!points.length) throw new Error('この図形の境界が見つかりませんでした。');
  // Use the same local metric projection as the map's comparison preview.
  let lon0 = 0, lat0 = 0;
  for (const [lon, lat] of points) { lon0 += lon; lat0 += lat; }
  lon0 /= points.length; lat0 /= points.length;
  const cosLat = Math.cos(lat0 * Math.PI / 180);
  const project = ([lon, lat]) => [(lon - lon0) * 111320 * cosLat, -(lat - lat0) * 110540];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) { const [x, y] = project(point); minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const scale = 1000 / Math.max(maxX - minX, maxY - minY);
  if (!Number.isFinite(scale)) throw new Error('この図形を描画できませんでした。');
  const width = Math.ceil((maxX - minX) * scale) + 16, height = Math.ceil((maxY - minY) * scale) + 16;
  const paths = polygons.map(polygon => polygon.map(ring => {
    let last;
    const coordinates = [];
    for (const point of ring) {
      if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
      const [px, py] = project(point), x = (px - minX) * scale + 8, y = (py - minY) * scale + 8;
      if (!last || Math.hypot(x - last[0], y - last[1]) >= .25) { coordinates.push(`${x.toFixed(2)},${y.toFixed(2)}`); last = [x, y]; }
    }
    return coordinates.length >= 3 ? `M${coordinates.join('L')}Z` : '';
  }).join(' ')).filter(Boolean);
  if (!paths.length) throw new Error('この図形を描画できませんでした。');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths.map(path => `<path d="${path}" fill="#8ec31f" stroke="#365c16" stroke-width="3" stroke-linejoin="round" fill-rule="evenodd"/>`).join('')}</svg>`;
}
export async function createShapeImage(target) {
  let promise = images.get(target.id);
  if (!promise) {
    promise = geometry(target).then(geometrySvg).catch(error => { images.delete(target.id); throw error; });
    images.set(target.id, promise);
  }
  const url = URL.createObjectURL(new Blob([await promise], { type: 'image/svg+xml' }));
  const image = new Image(); image.src = url;
  try { await image.decode(); return { image, url }; }
  catch (error) { URL.revokeObjectURL(url); throw error; }
}
