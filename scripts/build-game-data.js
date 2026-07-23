const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AREA_PATH = path.join(ROOT, 'data', 'gsi-area-r8-04.json');
const NATURAL_PATH = path.join(ROOT, 'data', 'natural-features.geojson');
const ADMINISTRATIVE_AREAS_PATH = path.join(ROOT, 'data', 'place-administrative-areas.json');
const OUTPUT_PATH = path.join(ROOT, 'data', 'game-places.json');
const MUNICIPALITY_URL = 'https://madefor.github.io/jisx0402/api/v1/all.json';
const NAURU_AREA_KM2 = 21;
const SAME_RATIO = 0.05;

function outcomeFor(areaKm2) {
  const lower = NAURU_AREA_KM2 * (1 - SAME_RATIO);
  const upper = NAURU_AREA_KM2 * (1 + SAME_RATIO);
  if (areaKm2 < lower) return 'smaller';
  if (areaKm2 > upper) return 'larger';
  return 'same';
}

function cleanText(value) {
  return String(value || '').trim();
}

async function loadMunicipalityCatalog() {
  const response = await fetch(MUNICIPALITY_URL);
  if (!response.ok) {
    throw new Error(`自治体一覧の取得に失敗しました: HTTP ${response.status}`);
  }
  return response.json();
}

async function main() {
  const officialAreas = JSON.parse(fs.readFileSync(AREA_PATH, 'utf8'));
  const naturalFeatures = JSON.parse(fs.readFileSync(NATURAL_PATH, 'utf8'));
  const administrativeAreas = JSON.parse(fs.readFileSync(ADMINISTRATIVE_AREAS_PATH, 'utf8')).places || {};
  const municipalityCatalog = await loadMunicipalityCatalog();

  const municipalities = Object.entries(municipalityCatalog)
    .filter(([code, item]) => /^\d{6}$/.test(code) && item && item.prefecture && item.city)
    .map(([code, item]) => {
      const adminCode = code.slice(0, -1);
      const areaKm2 = Number(officialAreas.municipalities[adminCode]);
      if (!Number.isFinite(areaKm2) || areaKm2 <= 0) return null;
      return {
        id: `municipality-${adminCode}`,
        category: 'municipality',
        name: `${cleanText(item.prefecture)}${cleanText(item.city)}`,
        shortName: cleanText(item.city),
        location: cleanText(item.prefecture),
        areaKm2,
        outcome: outcomeFor(areaKm2)
      };
    })
    .filter(Boolean);

  const natural = (naturalFeatures.features || [])
    .map(feature => {
      const properties = feature && feature.properties || {};
      const category = properties.kind === 'water' ? 'water' : properties.kind === 'island' ? 'island' : null;
      const areaKm2 = Number(properties.officialAreaKm2);
      if (!category || !cleanText(properties.name) || !Number.isFinite(areaKm2) || areaKm2 <= 0) return null;
      const administrative = administrativeAreas[properties.id || feature.id] || {};
      const prefectures = Array.isArray(administrative.prefectures) ? administrative.prefectures : [];
      const municipalities = Array.isArray(administrative.municipalities) ? administrative.municipalities : [];
      return {
        id: `${category}-${cleanText(properties.id || feature.id || properties.name)}`,
        category,
        name: cleanText(properties.name),
        shortName: cleanText(properties.shortName || properties.name),
        location: cleanText(prefectures.join('・') || municipalities.join('・') || properties.context),
        areaKm2,
        outcome: outcomeFor(areaKm2)
      };
    })
    .filter(Boolean);

  const places = municipalities.concat(natural);
  const counts = places.reduce((result, place) => {
    result[place.category] ||= { total: 0, larger: 0, same: 0, smaller: 0 };
    result[place.category].total += 1;
    result[place.category][place.outcome] += 1;
    return result;
  }, {});

  const payload = {
    version: 2,
    generatedAt: new Date().toISOString(),
    nauruAreaKm2: NAURU_AREA_KM2,
    sameRatio: SAME_RATIO,
    municipalitySource: officialAreas.source || '',
    counts,
    places
  };

  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`ゲーム出題データを書き出しました: ${path.relative(ROOT, OUTPUT_PATH)}`);
  console.log(JSON.stringify(counts, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
