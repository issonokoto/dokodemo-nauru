const fs = require('fs');

const sourcePath = 'data/game-places.json';
const outputPath = 'supabase/quiz-ranking-security.sql';
const data = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const allowedCategories = new Set(['municipality', 'island', 'water']);
const allowedOutcomes = new Set(['larger', 'same', 'smaller']);
const sqlLiteral = value => `'${String(value).replace(/'/g, "''")}'`;

if (!Array.isArray(data.places) || data.places.length < 10) {
  throw new Error('game-places.json does not contain enough places');
}

const rows = data.places.map(place => {
  const id = String(place.id || '');
  const category = String(place.category || '');
  const outcome = String(place.outcome || '');
  if (!id || id.length > 200 || /[\u0000-\u001f]/.test(id)
    || !allowedCategories.has(category) || !allowedOutcomes.has(outcome)) {
    throw new Error(`Invalid quiz place: ${JSON.stringify({ id, category, outcome })}`);
  }
  return `  (${sqlLiteral(id)}, ${sqlLiteral(category)}, ${sqlLiteral(outcome)})`;
});

const sql = `begin;

create table if not exists public.quiz_question_catalog (
  id text primary key,
  category text not null check (category in ('municipality', 'island', 'water')),
  outcome text not null check (outcome in ('larger', 'same', 'smaller'))
);

truncate table public.quiz_question_catalog;

insert into public.quiz_question_catalog (id, category, outcome)
values
${rows.join(',\n')};

create table if not exists public.quiz_game_sessions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  question_ids text[] not null,
  current_index smallint not null default 0,
  score integer not null default 0,
  correct_count smallint not null default 0,
  total_elapsed_ms integer not null default 0,
  question_started_at timestamptz,
  completed_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '30 minutes'),
  constraint quiz_game_sessions_question_count check (cardinality(question_ids) = 10),
  constraint quiz_game_sessions_index_range check (current_index between 0 and 10),
  constraint quiz_game_sessions_score_range check (score between 0 and 15000),
  constraint quiz_game_sessions_correct_range check (correct_count between 0 and 10),
  constraint quiz_game_sessions_elapsed_range check (total_elapsed_ms between 0 and 120000)
);

create table if not exists public.quiz_game_answers (
  session_id uuid not null references public.quiz_game_sessions(id) on delete cascade,
  question_index smallint not null check (question_index between 0 and 9),
  question_id text not null,
  answer text check (answer in ('larger', 'same', 'smaller')),
  is_correct boolean not null,
  elapsed_ms integer not null check (elapsed_ms between 0 and 12000),
  earned integer not null check (earned between 0 and 1500),
  answered_at timestamptz not null default clock_timestamp(),
  primary key (session_id, question_index)
);

create index if not exists quiz_game_sessions_client_created_idx
  on public.quiz_game_sessions (client_id, created_at desc);

create index if not exists quiz_game_sessions_expiry_idx
  on public.quiz_game_sessions (expires_at)
  where completed_at is null;

alter table public.quiz_game_answers
  drop constraint if exists quiz_game_answers_earned_check;

alter table public.quiz_game_answers
  add constraint quiz_game_answers_earned_check
  check (earned between 0 and 1500);

alter table public.quiz_scores
  drop constraint if exists quiz_scores_score_envelope;

alter table public.quiz_scores
  add constraint quiz_scores_score_envelope check (
    (correct_count = 0 and score = 0)
    or (
      correct_count > 0
      and score >= correct_count * 1000
      and score <= correct_count * 1500
    )
  );

alter table public.quiz_question_catalog enable row level security;
alter table public.quiz_question_catalog force row level security;
alter table public.quiz_game_sessions enable row level security;
alter table public.quiz_game_sessions force row level security;
alter table public.quiz_game_answers enable row level security;
alter table public.quiz_game_answers force row level security;

revoke all on public.quiz_question_catalog from anon, authenticated;
revoke all on public.quiz_game_sessions from anon, authenticated;
revoke all on public.quiz_game_answers from anon, authenticated;

create or replace function public.start_quiz_game(p_client_id uuid)
returns table (session_id uuid, question_ids text[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_ids text[];
  new_session_id uuid;
begin
  if p_client_id is null then
    raise exception '端末情報を確認できませんでした';
  end if;

  if (
    select count(*)
    from public.quiz_game_sessions
    where client_id = p_client_id
      and created_at > clock_timestamp() - interval '1 minute'
  ) >= 5 then
    raise exception '少し待ってから開始してください';
  end if;

  with blueprint(category, outcome, needed) as (
    values
      ('municipality', 'larger', 2),
      ('municipality', 'smaller', 1),
      ('municipality', 'same', 1),
      ('island', 'larger', 1),
      ('island', 'smaller', 1),
      ('island', 'same', 1),
      ('water', 'larger', 1),
      ('water', 'smaller', 2)
  ),
  picked as (
    select question.id
    from blueprint
    cross join lateral (
      select catalog.id
      from public.quiz_question_catalog as catalog
      where catalog.category = blueprint.category
        and catalog.outcome = blueprint.outcome
      order by random()
      limit blueprint.needed
    ) as question
  )
  select array_agg(id order by random())
  into selected_ids
  from picked;

  if cardinality(selected_ids) <> 10 then
    raise exception '出題データが不足しています';
  end if;

  insert into public.quiz_game_sessions (client_id, question_ids)
  values (p_client_id, selected_ids)
  returning id into new_session_id;

  return query select new_session_id, selected_ids;
end;
$$;

create or replace function public.open_quiz_question(
  p_session_id uuid,
  p_client_id uuid,
  p_question_index integer
)
returns table (opened boolean, question_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  game public.quiz_game_sessions%rowtype;
begin
  select *
  into game
  from public.quiz_game_sessions
  where id = p_session_id
  for update;

  if not found
    or game.client_id <> p_client_id
    or game.completed_at is not null
    or game.expires_at <= clock_timestamp()
    or game.current_index <> p_question_index
    or p_question_index < 0
    or p_question_index >= 10 then
    raise exception 'ゲームセッションを確認できませんでした';
  end if;

  if game.question_started_at is null then
    update public.quiz_game_sessions
    set question_started_at = clock_timestamp()
    where id = p_session_id;
  end if;

  return query select true, game.question_ids[p_question_index + 1];
end;
$$;

create or replace function public.answer_quiz_question(
  p_session_id uuid,
  p_client_id uuid,
  p_question_index integer,
  p_answer text
)
returns table (
  correct_outcome text,
  is_correct boolean,
  elapsed_ms integer,
  earned integer,
  total_score integer,
  correct_total integer,
  completed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  game public.quiz_game_sessions%rowtype;
  expected_outcome text;
  server_elapsed integer;
  scored_elapsed integer;
  was_correct boolean;
  earned_points integer;
  next_index integer;
  next_correct integer;
  next_score integer;
  answered_at_value timestamptz := clock_timestamp();
begin
  if p_answer is not null and p_answer not in ('larger', 'same', 'smaller') then
    raise exception '回答を確認できませんでした';
  end if;

  select *
  into game
  from public.quiz_game_sessions
  where id = p_session_id
  for update;

  if not found
    or game.client_id <> p_client_id
    or game.completed_at is not null
    or game.expires_at <= answered_at_value
    or game.current_index <> p_question_index
    or game.question_started_at is null
    or p_question_index < 0
    or p_question_index >= 10 then
    raise exception 'ゲームセッションを確認できませんでした';
  end if;

  server_elapsed := round(extract(epoch from (answered_at_value - game.question_started_at)) * 1000);
  scored_elapsed := least(12000, greatest(0, server_elapsed));

  select catalog.outcome
  into expected_outcome
  from public.quiz_question_catalog as catalog
  where catalog.id = game.question_ids[p_question_index + 1];

  if expected_outcome is null then
    raise exception '出題データを確認できませんでした';
  end if;

  was_correct := server_elapsed < 12000 and p_answer = expected_outcome;
  earned_points := case
    when was_correct then
      1000 + floor(500.0 * (12000 - scored_elapsed) / 12000)::integer
    else 0
  end;
  next_index := game.current_index + 1;
  next_correct := game.correct_count + case when was_correct then 1 else 0 end;
  next_score := game.score + earned_points;

  insert into public.quiz_game_answers (
    session_id,
    question_index,
    question_id,
    answer,
    is_correct,
    elapsed_ms,
    earned,
    answered_at
  )
  values (
    game.id,
    p_question_index,
    game.question_ids[p_question_index + 1],
    case when server_elapsed < 12000 then p_answer else null end,
    was_correct,
    scored_elapsed,
    earned_points,
    answered_at_value
  );

  update public.quiz_game_sessions
  set current_index = next_index,
      score = next_score,
      correct_count = next_correct,
      total_elapsed_ms = total_elapsed_ms + scored_elapsed,
      question_started_at = null,
      completed_at = case when next_index = 10 then answered_at_value else null end
  where id = game.id;

  return query
  select
    expected_outcome,
    was_correct,
    scored_elapsed,
    earned_points,
    next_score,
    next_correct,
    next_index = 10;
end;
$$;

create or replace function public.register_quiz_session_score(
  p_session_id uuid,
  p_client_id uuid,
  p_player_name text
)
returns table (accepted boolean, message text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  game public.quiz_game_sessions%rowtype;
  cleaned_name text := btrim(normalize(coalesce(p_player_name, ''), NFKC));
  average_value integer;
begin
  if not public.quiz_name_is_allowed(cleaned_name) then
    return query select false, '名前を確認してください';
    return;
  end if;

  select *
  into game
  from public.quiz_game_sessions
  where id = p_session_id
  for update;

  if not found
    or game.client_id <> p_client_id
    or game.completed_at is null
    or game.current_index <> 10
    or game.claimed_at is not null
    or game.expires_at <= clock_timestamp() then
    return query select false, '完走したゲーム記録を確認できませんでした';
    return;
  end if;

  average_value := round(game.total_elapsed_ms / 10.0);

  insert into public.quiz_scores (player_name, score, correct_count, average_ms, client_id)
  values (cleaned_name, game.score, game.correct_count, average_value, game.client_id);

  update public.quiz_game_sessions
  set claimed_at = clock_timestamp()
  where id = game.id;

  return query select true, 'ランキングに登録しました';
end;
$$;

revoke execute on function public.submit_quiz_score(text, integer, integer, integer, uuid)
  from anon, authenticated;

revoke all on function public.start_quiz_game(uuid) from public;
revoke all on function public.open_quiz_question(uuid, uuid, integer) from public;
revoke all on function public.answer_quiz_question(uuid, uuid, integer, text) from public;
revoke all on function public.register_quiz_session_score(uuid, uuid, text) from public;

grant execute on function public.start_quiz_game(uuid) to anon, authenticated;
grant execute on function public.open_quiz_question(uuid, uuid, integer) to anon, authenticated;
grant execute on function public.answer_quiz_question(uuid, uuid, integer, text) to anon, authenticated;
grant execute on function public.register_quiz_session_score(uuid, uuid, text) to anon, authenticated;

commit;
`;

fs.writeFileSync(outputPath, sql);
console.log(`Wrote ${outputPath} with ${rows.length} questions`);
