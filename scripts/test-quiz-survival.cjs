const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const rules = require('../game/rules.js');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const places = JSON.parse(read('data/game-places.json')).places;
let seed = 49285;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

function testRules() {
  assert.equal(rules.earnedPoints(true, 0), 1200);
  assert.equal(rules.earnedPoints(true, 6000), 1100);
  assert.equal(rules.earnedPoints(true, 11999), 1000);
  assert.equal(rules.earnedPoints(true, 12000), 0);
  assert.equal(rules.earnedPoints(false, 0), 0);
  const used = new Set();
  for (let i = 0; i < places.length; i++) {
    const oldSize = used.size;
    rules.pickNext(places, used, random);
    assert.equal(used.size, oldSize + 1, `Repeated question before exhausting catalog at ${i}`);
  }
  rules.pickNext(places, used, random);
  assert.equal(used.size, 1, 'Continues after exhausting all questions');
  const sample = () => {
    const outcomes = { larger: 0, smaller: 0, same: 0 };
    for (let i = 0; i < 6000; i++) {
      const q = rules.pickNext(places, new Set(), random);
      outcomes[q.outcome]++;
    }
    assert(outcomes.larger > 2400 && outcomes.larger < 3000);
    assert(outcomes.smaller > 2400 && outcomes.smaller < 3000);
    assert(outcomes.same > 450 && outcomes.same < 750);
  };
  sample();
  // Within an answer group, rare categories and difficult places keep the same
  // per-place chance as common, easy candidates.
  const mixed = Array.from({ length: 100 }, (_, index) => ({
    id: `mixed-${index}`, outcome: 'larger',
    category: index < 90 ? 'municipality' : 'island', areaKm2: index < 90 ? 100 : 22.2
  }));
  let rare = 0;
  for (let i = 0; i < 6000; i++) {
    rare += rules.pickNext(mixed, new Set(), random).category === 'island';
  }
  assert(rare > 480 && rare < 720, 'Candidate probability depends on difficulty or category');
  console.log('PASS: scoring/timeouts, answer balance, uniform candidates, 2340 unique questions and endless recycling');
}

async function testDatabase() {
  const packagePath = process.argv[2] || '@electric-sql/pglite';
  const { PGlite } = require(packagePath);
  const db = await PGlite.create();
  const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
  try {
    await db.exec('create role anon; create role authenticated;');
    // gen_random_uuid is built into PostgreSQL; the local emulator does not ship pgcrypto.
    await db.exec(read('supabase/quiz-ranking.sql').replace('create extension if not exists pgcrypto;', ''));
    await db.exec(read('supabase/quiz-ranking-security.sql'));
    const client = randomUUID();
    await one('select * from public.start_quiz_game($1)', [client]);
    await db.query("insert into public.quiz_scores (player_name,score,correct_count,average_ms,client_id) values ('旧記録',1000,1,12000,$1)", [client]);
    const migration = read('supabase/quiz-survival-v2.sql');
    const randomMigration = read('supabase/migrations/20261009164056_quiz_survival_random_questions.sql');
    await db.exec(migration);
    assert.equal((await one('select count(*)::integer n from public.quiz_scores')).n, 0);
    assert.equal((await one('select count(*)::integer n from public.quiz_game_sessions')).n, 0);
    assert.equal((await one('select count(*)::integer n from public.quiz_survival_catalog')).n, places.length);
    assert.equal((await one("select has_function_privilege('anon','public.start_quiz_game(uuid)','EXECUTE') allowed")).allowed, false);
    const drawAt = async correctCount => {
      await db.query('select setseed(0.25)');
      return (await db.query("select public.pick_quiz_survival_question('{}',$1) id from generate_series(1,200)", [correctCount])).rows.map(row => row.id);
    };
    const initialDraw = await drawAt(0);
    assert.deepEqual(await drawAt(10), initialDraw, 'Server selection changes at 10 correct answers');
    assert.deepEqual(await drawAt(20), initialDraw, 'Server selection changes at 20 correct answers');
    const session = await one('select * from public.start_quiz_survival_game($1)', [client]);
    assert.equal(session.rules_version, rules.VERSION);
    const sessionId = session.session_id;
    const calls = [sessionId, client];
    const open = index => one('select * from public.open_quiz_survival_question($1,$2,$3)', [...calls, index]);
    const answer = (index, choice) => one('select * from public.answer_quiz_survival_question($1,$2,$3,$4)', [...calls, index, choice]);
    const seen = new Set();
    let total = 0;
    for (let index = 0; index < 27; index++) {
      const question = await open(index);
      assert(!seen.has(question.question_id));
      seen.add(question.question_id);
      const repeat = await open(index);
      assert.equal(repeat.question_id, question.question_id);
      await assert.rejects(() => one('select * from public.open_quiz_survival_question($1,$2,$3)', [sessionId, null, index]));
      const expected = places.find(p => p.id === question.question_id).outcome;
      // Include a mistake early: surviving the tenth question must not end the game.
      const choice = index === 2 ? (expected === 'larger' ? 'smaller' : 'larger') : expected;
      const result = await answer(index, choice);
      assert.equal(result.completed, false);
      assert.equal(result.earned, rules.earnedPoints(index !== 2, result.elapsed_ms));
      total += result.earned;
      assert.equal(Number(result.total_score), total);
      await assert.rejects(() => answer(index, choice), /ゲームセッション/);
    }
    const early = await one('select * from public.register_quiz_survival_score($1,$2,$3)', [...calls, 'テスト']);
    assert.equal(early.accepted, false);
    await open(27);
    // A deadline timeout, including a null answer, costs exactly one chance.
    await db.query("update public.quiz_survival_sessions set question_started_at=clock_timestamp()-interval '12 seconds' where id=$1", [sessionId]);
    const timeout = await answer(27, null);
    assert.equal(timeout.mistakes, 2);
    assert.equal(timeout.is_correct, false);
    assert.equal(timeout.earned, 0);
    assert.equal(timeout.completed, false);
    await open(28);
    const final = await answer(28, null);
    assert.equal(final.mistakes, 3);
    assert.equal(final.correct_total, 26);
    assert.equal(final.completed, true);
    await assert.rejects(() => open(29), /ゲームセッション/);
    const accepted = await one('select * from public.register_quiz_survival_score($1,$2,$3)', [...calls, 'テスト']);
    assert.equal(accepted.accepted, true);
    const duplicate = await one('select * from public.register_quiz_survival_score($1,$2,$3)', [...calls, 'テスト']);
    assert.equal(duplicate.accepted, false);
    const existingRecords = await one('select (select count(*) from public.quiz_survival_sessions) sessions, (select count(*) from public.quiz_survival_answers) answers, (select count(*) from public.quiz_survival_scores) scores');
    await db.exec(randomMigration);
    await db.exec(randomMigration);
    assert.deepEqual(await one('select (select count(*) from public.quiz_survival_sessions) sessions, (select count(*) from public.quiz_survival_answers) answers, (select count(*) from public.quiz_survival_scores) scores'), existingRecords, 'Random picker update changed existing records');
    assert.deepEqual(await drawAt(20), initialDraw, 'Incremental picker differs from the initial installation');
    await db.exec(migration);
    assert.equal((await one('select count(*)::integer n from public.quiz_survival_scores')).n, 1, 'Migration retry preserves v2 records');
    // Equal scores are ordered by correct answers, and each client has one best.
    for (const [name, score, correct] of [['同点30', 36000, 30], ['同点31', 36000, 31]]) {
      const id = randomUUID(), otherClient = randomUUID();
      await db.query('insert into public.quiz_survival_sessions (id,client_id,current_index,score,correct_count,mistakes,completed_at) values ($1,$2,$3,$4,$5,3,now())', [id, otherClient, correct + 3, score, correct]);
      await db.query('insert into public.quiz_survival_scores (session_id,player_name,score,correct_count,average_ms,client_id) values ($1,$2,$3,$4,1000,$5)', [id, name, score, correct, otherClient]);
    }
    const leaders = (await db.query("select * from public.get_quiz_survival_leaderboard('all')")).rows;
    assert.equal(leaders[0].player_name, '同点31');
    assert.equal(leaders[1].player_name, '同点30');
    for (const period of ['daily', 'weekly', 'all']) {
      assert.equal((await db.query('select * from public.get_quiz_survival_leaderboard($1)', [period])).rows.length, 3);
    }
    await db.exec('set role anon');
    await assert.rejects(() => db.query('select * from public.quiz_survival_scores'), /permission denied/);
    await assert.rejects(() => db.query("select public.pick_quiz_survival_question('{}',0)"), /permission denied/);
    assert.equal((await db.query("select * from public.get_quiz_survival_leaderboard('all')")).rows.length, 3);
    await db.exec('reset role');
    console.log('PASS: real PostgreSQL random selection independent of progress, record-preserving update, >10-question sessions, 3 mistakes, timeouts, ranking and access boundaries');
  } finally { await db.close(); }
}
testRules();
testDatabase().catch(error => { console.error(error.message); process.exitCode = 1; });
