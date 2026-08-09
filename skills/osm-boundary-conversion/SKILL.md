---
name: osm-boundary-conversion
description: Resolve and verify OSM-derived boundaries for islands, lakes, linear water features, parks, administrative areas, and site footprints, then save canonical GeoJSON, reproducibility metadata, and aspect-correct SVG/export specifications. Use when selecting an OSM/Nominatim object, rebuilding a relation, excluding sea from an administrative boundary, preserving islands and holes, converting a boundary to image-ready data, or auditing a prior OSM conversion.
---

# OSM Boundary Conversion

## Goal

Create a reproducible vector boundary first, then derive SVG, masks, tiles, KML, or other outputs from it. Never treat a search preview, bounding box, or screenshot as canonical geometry.

The default meaning of an administrative-area output is land inside the administrative relation, excluding surrounding sea while preserving islands, holes, enclaves, and disconnected land components. A natural island is its landmass. An open water feature remains a line unless a separate closed water-area object is verified.

## Required outputs

For each accepted target, keep:

- `R<ID>.geojson` or `W<ID>.geojson`: unsimplified WGS84 canonical geometry;
- `.metadata.json`: source identity, query and response hashes, boundary definition, geometry checks, area/length, export transform, and file hashes;
- `.preview.svg` unless `--no-svg` was requested;
- raw OSM/coastline responses and their source receipts when `--keep-raw` or `--reuse-cache` is used.

Never join an island to the mainland, close an open line into an invented area, or retain a maritime sea polygon because coastline reconstruction failed.

## Standard workflow

### 1. Define and identify the target

Record the intended kind and inclusion rules before fetching geometry:

- `administrative-area`, `island`, `water`, `park`, `facility`, or another explicit kind;
- surrounding sea included or excluded;
- islands, holes, enclaves, territorial water, and artificial land included or excluded;
- country, prefecture/state, municipality, nearby landmark, and expected scale.

For a name lookup, use Nominatim only for candidate discovery. Request `jsonv2`, address details, extra tags, and name details, but not `polygon_geojson=1` by default. A candidate must match the name, kind, and every supplied context token. Stop on ambiguity; do not select the first same-name result.

Prefer a verified `osmType` plus `osmId`. It skips discovery and pins regeneration to the intended object.

### 2. Use the bundled converter

Use `scripts/convert_osm_boundary.mjs`; do not write a second reconstruction script. Keep one shared cache directory so separate outputs can reuse the same verified responses.

```text
node scripts/convert_osm_boundary.mjs --name "豊中市" --kind administrative-area --context "大阪府 日本" --output-dir outputs --cache-dir .osm-boundary-cache --reuse-cache --deep
node scripts/convert_osm_boundary.mjs --osm-type relation --osm-id 900329 --name "神戸市" --kind administrative-area --context "兵庫県 日本" --output-dir outputs --cache-dir .osm-boundary-cache --reuse-cache --deep
node scripts/convert_osm_boundary.mjs --name "淡路島" --kind island --context "兵庫県 日本" --output-dir outputs --cache-dir .osm-boundary-cache --reuse-cache --deep
node scripts/convert_osm_boundary.mjs --osm-type way --osm-id 1442885134 --name "明石海峡" --kind water --output-dir outputs --cache-dir .osm-boundary-cache --reuse-cache --deep
```

Use `--keep-raw` for a fresh reproducible fetch. Use `--reuse-cache` for normal regeneration; it also retains newly fetched raw responses. Omit cache reuse only when a fresh OSM revision is required.

If the sandbox refuses to execute a Node main script from the installed skill directory, materialize `convert_osm_boundary.mjs` and its test file once under the approved workspace, verify their SHA-256 hashes match the skill copies, and execute that single workspace copy. Do not use `eval`, create several ad-hoc converter copies, or repeat the same EPERM command.

### 3. Keep acquisition bounded

The converter:

1. fetches only the parent relation and member ways with inline geometry;
2. expands to direct `subarea` relations only when the parent has no resolvable outer geometry;
3. requests coastline data only for a maritime administrative boundary;
4. starts alternate public Overpass endpoints with a short stagger, accepts the first success, and cancels the rest;
5. writes retrieval attempts and cache source receipts.

This is intentionally not an unbounded retry loop. If all endpoints fail, report the exact stage and keep any completed cache. A later run with `--reuse-cache` must not refetch completed stages.

Respect OSM public-service limits and attribution. Do not add generic web searches, browser scraping, official-area research, Natural Earth, or WDPA to every normal conversion. Those are targeted comparisons, not mandatory network work.

## Geometry invariants

### Relations and ways

- Rebuild relation rings from complete member ways and preserve `outer`/`inner` roles.
- Join ways by node identity; fail on an open area ring or missing member.
- Normalize outer rings counterclockwise and holes clockwise.
- Assign each hole to the smallest containing outer polygon.
- Preserve a closed way as a polygon and an open way as a `LineString` in OSM node order.
- Reject out-of-range coordinates, zero-area rings, duplicate rings, holes outside outers, and self-intersections.

### Parent and subarea relations

Use a complete parent boundary as canonical. Direct subareas are an audit or a fallback, not an automatic replacement for the parent.

If the parent has no outer geometry, assemble direct subarea components. Permit shared borders, but reject positive-area overlap or partial conflicts. Do not call a subarea-derived result canonical while overlap remains unresolved.

### Maritime administrative boundaries

OSM administrative outer ways may use `maritime=yes` to close a relation through sea. For these:

- detect maritime ways on the parent and, when direct subareas are the required fallback, on those direct subareas;
- find exact administrative-boundary/coastline intersections, including intersections inside segments;
- follow `natural=coastline` in OSM direction, where land lies on the left;
- support coastlines split across many open ways and coastlines stored as one closed way;
- replace one contiguous maritime arc with the real coastline;
- add closed or multi-way coastline rings contained by the administrative polygon as independent islands;
- deduplicate islands without changing their coordinates;
- fail on missing contacts, a disconnected coastline graph, multiple ambiguous maritime arcs, or a land mask with no polygons.

Do not append an island to a mainland ring. The result must be a proper `MultiPolygon` when disconnected land exists.

## Validation

Before reporting success, verify:

- candidate name, kind, context, OSM type, and OSM ID;
- valid GeoJSON structure and `[longitude, latitude]` order;
- closed non-zero area rings, correct winding, valid holes, and no duplicate rings;
- zero polygon self-intersections; the converter runs this check for area geometry even without `--deep`;
- disconnected land and islands are retained as separate polygon components;
- spherical area or line length is plausible for the selected definition;
- optional official/reference area uses `geometryArea / referenceArea`, with the source identified;
- geometry and final GeoJSON SHA-256 hashes are recorded;
- SVG quantization and canvas-ratio bounds pass.

For complex coastlines, parent-from-subarea fallbacks, tiny facilities, or any disputed output, use `--deep` and inspect the SVG visually. Check missing islands, filled sea, holes, cropping, flipped latitude, stair steps, and stretched proportions. Numerical success does not replace visual inspection when the shape is in question.

## SVG and raster rules

The converter maps WGS84 geometry to a pixel-space SVG viewBox using one local equirectangular x/y scale and y-axis inversion. It does not round geographic coordinates into a low-precision viewBox.

Keep these meanings separate:

- `coordinateBboxAspectRatio`: longitude span divided by latitude span;
- `projectedAspectRatio`: longitude span corrected by `cos(centerLatitude)`, divided by latitude span;
- SVG `aspectRatio`: actual canvas width divided by height;
- `areaRatio`: geometry area divided by a reference area.

The actual canvas ratio must stay within the recorded maximum error from the projected content ratio. A square request must use padding/letterboxing with one scale, never independent x/y stretching.

SVG is a derivative of canonical GeoJSON. Preserve pixel-space `viewBox`, width, height, padding, coordinate precision, quantization error, projection, and y-axis direction in metadata. An open line receives a stroked SVG and `pngMask.supported=false`.

## Multiple targets

Resolve each city, island, lake, strait, park, or facility independently. Keep one target record per intended feature and create a manifest only when the request contains several targets. Do not silently merge nearby features or substitute a rejected same-name object.

## Publication and handoff

Return a compact receipt with:

- accepted OSM object and boundary definition;
- retrieval URL(s), cache use, response hashes, and timestamp;
- geometry type, components, islands, area/length, integrity checks, and reference comparison;
- GeoJSON/SVG paths and hashes;
- fallback, unresolved audit, or manual decision, if any.

When publishing, stage only reviewed skill/output files and preserve unrelated worktree changes. Verify the remote branch/file after pushing; local generation alone is not publication.

## Failure rules

- Wrong same-name object: strengthen context or pin an OSM ID; never accept by name alone.
- Administrative area contains sea: require the coastline land mask; never label the sea-filled relation as land.
- Island missing: inspect closed and multi-way coastline rings and containment; never draw or attach an island manually.
- Direct subareas overlap: stop and report the conflicting relation/component.
- Coastline direction or graph is broken: stop instead of reversing an arbitrary shortest path.
- SVG looks coarse: inspect pixel-space serialization and quantization before simplifying or changing OSM geometry.
- SVG looks stretched: compare projected content ratio with actual canvas ratio; never use area ratio as an image ratio.
- Public endpoint timeout: keep completed caches, allow the bounded staggered alternatives, then stop. Do not start an open-ended retry chain.
- Skill-folder EPERM: materialize one hash-identical workspace copy and continue there.

## Final checklist

- [ ] Boundary meaning and inclusion rules are explicit.
- [ ] Candidate is pinned and context-validated.
- [ ] Canonical GeoJSON is unsimplified and checksummed.
- [ ] Sea is excluded from land outputs; islands and holes remain separate and intact.
- [ ] Rings, overlaps, self-intersections, area/length, and coordinate range pass.
- [ ] SVG uses one projected scale and passes quantization/canvas-ratio bounds.
- [ ] Visual inspection is complete when shape quality is disputed or complex.
- [ ] Metadata contains provenance, cache receipts, license, validation, and export settings.
- [ ] Only reviewed files are published.
