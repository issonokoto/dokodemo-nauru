const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'data', 'natural-features.geojson');
const geometryDir = path.join(root, 'data', 'natural-features');
const naturalEarthUrl = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson';
const boundarySourceLabel = 'Natural Earth 1:10m Cultural Vectors';
const boundarySourceUrl = 'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-0-countries/';

const replacements = [
  ['グリーンランド', 'GRL', null, 'R2184073.geojson'],
  ['マダガスカル島', 'MDG', 'MDG', 'R447325.geojson'],
  ['スリランカ島', 'LKA', 'LKA', 'R536807.geojson'],
  ['アイスランド島', 'ISL', 'ISL', 'R299133.geojson'],
];

async function main() {
  const response = await fetch(naturalEarthUrl);
  if (!response.ok) throw new Error(`Natural Earth ${response.status}`);
  const naturalEarth = await response.json();
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

  for (const [name, code, localCountryCode, obsoleteFile] of replacements) {
    const catalogFeature = catalog.features.find(feature => feature.properties && feature.properties.name === name);
    if (!catalogFeature) throw new Error(`Catalog feature not found: ${name}`);
    let source;
    if (localCountryCode) {
      source = JSON.parse(fs.readFileSync(path.join(root, 'data', 'countries', `${localCountryCode}.geojson`), 'utf8'));
    } else {
      source = naturalEarth.features.find(feature => feature.properties && feature.properties.ADM0_A3 === code);
    }
    if (!source || !source.geometry) throw new Error(`Boundary not found: ${code}`);

    const properties = catalogFeature.properties;
    delete properties.osmType;
    delete properties.osmId;
    properties.boundarySourceLabel = boundarySourceLabel;
    properties.boundarySourceUrl = boundarySourceUrl;
    properties.naturalEarthCode = code;
    properties.geometryFile = `natural-features/NE-${code}.geojson`;
    const output = { type: 'Feature', id: catalogFeature.id, properties, geometry: source.geometry };
    fs.writeFileSync(path.join(geometryDir, `NE-${code}.geojson`), `${JSON.stringify(output)}\n`);
    const obsoletePath = path.join(geometryDir, obsoleteFile);
    if (fs.existsSync(obsoletePath)) fs.rmSync(obsoletePath);
    console.log(`replace island: ${name} <- Natural Earth ${code}`);
  }

  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
