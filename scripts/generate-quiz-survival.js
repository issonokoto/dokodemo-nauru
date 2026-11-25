const fs = require('node:fs');
const path = require('node:path');
const rules = require('../game/rules.js');
const root = path.resolve(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/game-places.json'), 'utf8'));
const literal = value => `'${String(value).replace(/'/g, "''")}'`;
const ids = new Set();
const rows = data.places.map(place => {
  if (!place.id || ids.has(place.id) || !['municipality', 'island', 'water'].includes(place.category)
    || !rules.OUTCOMES.includes(place.outcome)) throw new Error(`Invalid question: ${place.id}`);
  ids.add(place.id);
  return `  (${literal(place.id)}, ${literal(place.category)}, ${literal(place.outcome)}, ${rules.difficulty(place)})`;
});
const template = fs.readFileSync(path.join(root, 'supabase/quiz-survival-template.sql'), 'utf8');
fs.writeFileSync(path.join(root, 'supabase/quiz-survival-v2.sql'), template.replace('-- QUESTION_CATALOG_ROWS', rows.join(',\n')));
console.log(`Generated survival-v2 migration with ${rows.length} questions`);
