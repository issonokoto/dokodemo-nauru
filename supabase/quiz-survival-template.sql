-- Apply after quiz-ranking.sql. This transaction activates survival-v2 and
-- resets the old scores/sessions exactly once, even if the script is rerun.
begin;

create table if not exists public.quiz_rulesets (
  version text primary key,
  activated_at timestamptz not null default clock_timestamp()
);
alter table public.quiz_rulesets enable row level security;
alter table public.quiz_rulesets force row level security;
revoke all on public.quiz_rulesets from public, anon, authenticated;

create table if not exists public.quiz_survival_catalog (
  id text primary key,
  category text not null check (category in ('municipality', 'island', 'water')),
  outcome text not null check (outcome in ('larger', 'same', 'smaller')),
  difficulty smallint not null check (difficulty between 0 and 2)
);
truncate table public.quiz_survival_catalog;
insert into public.quiz_survival_catalog (id, category, outcome, difficulty) values
-- QUESTION_CATALOG_ROWS
;

create table if not exists public.quiz_survival_sessions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  used_question_ids text[] not null default '{}',
  current_question_id text,
  current_index integer not null default 0 check (current_index >= 0),
  score bigint not null default 0,
  correct_count integer not null default 0 check (correct_count >= 0),
  mistakes smallint not null default 0 check (mistakes between 0 and 3),
  total_elapsed_ms bigint not null default 0 check (total_elapsed_ms >= 0),
  question_started_at timestamptz,
  completed_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '30 minutes'),
  check (current_index = correct_count + mistakes),
  check (score between correct_count::bigint * 1000 and correct_count::bigint * 1200),
  check ((completed_at is not null) = (mistakes = 3))
);
create index if not exists quiz_survival_sessions_client_created_idx
  on public.quiz_survival_sessions (client_id, created_at desc);

create table if not exists public.quiz_survival_answers (
  session_id uuid not null references public.quiz_survival_sessions(id) on delete cascade,
  question_index integer not null check (question_index >= 0),
  question_id text not null,
  answer text check (answer in ('larger', 'same', 'smaller')),
  is_correct boolean not null,
  elapsed_ms integer not null check (elapsed_ms between 0 and 12000),
  earned integer not null check (earned between 0 and 1200),
  answered_at timestamptz not null default clock_timestamp(),
  primary key (session_id, question_index)
);
create table if not exists public.quiz_survival_scores (
  id bigint generated always as identity primary key,
  session_id uuid not null unique references public.quiz_survival_sessions(id),
  player_name text not null check (char_length(player_name) between 1 and 10),
  score bigint not null,
  correct_count integer not null check (correct_count >= 0),
  average_ms integer not null check (average_ms between 0 and 12000),
  client_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  check (score between correct_count::bigint * 1000 and correct_count::bigint * 1200)
);
create index if not exists quiz_survival_scores_client_period_idx
  on public.quiz_survival_scores (client_id, created_at desc);
create index if not exists quiz_survival_scores_period_rank_idx
  on public.quiz_survival_scores (created_at desc, score desc, correct_count desc);

alter table public.quiz_survival_catalog enable row level security;
alter table public.quiz_survival_catalog force row level security;
alter table public.quiz_survival_sessions enable row level security;
alter table public.quiz_survival_sessions force row level security;
alter table public.quiz_survival_answers enable row level security;
alter table public.quiz_survival_answers force row level security;
alter table public.quiz_survival_scores enable row level security;
alter table public.quiz_survival_scores force row level security;
revoke all on public.quiz_survival_catalog, public.quiz_survival_sessions,
  public.quiz_survival_answers, public.quiz_survival_scores from public, anon, authenticated;
revoke all on sequence public.quiz_survival_scores_id_seq from public, anon, authenticated;

create or replace function public.pick_quiz_survival_question(p_used_ids text[], p_correct_count integer)
returns text language plpgsql security definer set search_path = '' as $$
declare
  used_ids text[] := coalesce(p_used_ids, '{}');
  outcome_roll double precision := random();
  difficulty_roll double precision := random();
  target_outcome text;
  target_difficulty smallint;
  selected_category text;
  selected_id text;
begin
  if not exists (select 1 from public.quiz_survival_catalog c where not (c.id = any(used_ids))) then
    used_ids := '{}';
  end if;
  target_outcome := case when outcome_roll < 0.45 then 'larger' when outcome_roll < 0.9 then 'smaller' else 'same' end;
  if not exists (select 1 from public.quiz_survival_catalog c where not (c.id = any(used_ids)) and c.outcome = target_outcome) then
    target_outcome := null;
  end if;
  target_difficulty := case
    when p_correct_count < 10 then case when difficulty_roll < 0.8 then 0 when difficulty_roll < 0.95 then 1 else 2 end
    when p_correct_count < 20 then case when difficulty_roll < 0.3 then 0 when difficulty_roll < 0.8 then 1 else 2 end
    else case when difficulty_roll < 0.1 then 0 when difficulty_roll < 0.4 then 1 else 2 end
  end;
  if not exists (select 1 from public.quiz_survival_catalog c
    where not (c.id = any(used_ids)) and (target_outcome is null or c.outcome = target_outcome)
      and c.difficulty = target_difficulty) then
    target_difficulty := null;
  end if;
  select pool.category into selected_category from (
    select distinct c.category from public.quiz_survival_catalog c
    where not (c.id = any(used_ids)) and (target_outcome is null or c.outcome = target_outcome)
      and (target_difficulty is null or c.difficulty = target_difficulty)
  ) pool order by random() limit 1;
  select c.id into selected_id from public.quiz_survival_catalog c
  where not (c.id = any(used_ids)) and c.category = selected_category
    and (target_outcome is null or c.outcome = target_outcome)
    and (target_difficulty is null or c.difficulty = target_difficulty)
  order by random() limit 1;
  if selected_id is null then raise exception '出題候補が不足しています'; end if;
  return selected_id;
end;
$$;

create or replace function public.start_quiz_survival_game(p_client_id uuid)
returns table (session_id uuid, rules_version text)
language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if p_client_id is null then raise exception '端末情報を確認できませんでした'; end if;
  if (select count(*) from public.quiz_survival_sessions where client_id = p_client_id
      and created_at > clock_timestamp() - interval '1 minute') >= 5 then
    raise exception '少し待ってから開始してください';
  end if;
  insert into public.quiz_survival_sessions (client_id) values (p_client_id) returning id into new_id;
  return query select new_id, 'survival-v2'::text;
end;
$$;

create or replace function public.open_quiz_survival_question(p_session_id uuid, p_client_id uuid, p_question_index integer)
returns table (opened boolean, question_id text)
language plpgsql security definer set search_path = '' as $$
declare game public.quiz_survival_sessions%rowtype; next_id text;
begin
  select * into game from public.quiz_survival_sessions where id = p_session_id for update;
  if not found or p_client_id is null or game.client_id <> p_client_id
    or p_question_index is null or game.current_index <> p_question_index
    or game.completed_at is not null or game.expires_at <= clock_timestamp() then
    raise exception 'ゲームセッションを確認できませんでした';
  end if;
  if game.current_question_id is null then
    if cardinality(game.used_question_ids) >= (select count(*) from public.quiz_survival_catalog) then
      game.used_question_ids := '{}';
    end if;
    next_id := public.pick_quiz_survival_question(game.used_question_ids, game.correct_count);
    update public.quiz_survival_sessions
      set current_question_id = next_id,
          used_question_ids = array_append(game.used_question_ids, next_id),
          question_started_at = clock_timestamp(),
          expires_at = clock_timestamp() + interval '30 minutes'
      where id = game.id;
  else next_id := game.current_question_id;
  end if;
  return query select true, next_id;
end;
$$;

create or replace function public.answer_quiz_survival_question(p_session_id uuid, p_client_id uuid, p_question_index integer, p_answer text)
returns table (correct_outcome text, is_correct boolean, elapsed_ms integer, earned integer,
  total_score bigint, correct_total integer, mistakes integer, completed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  game public.quiz_survival_sessions%rowtype;
  expected text; elapsed integer; correct boolean; points integer;
  next_correct integer; next_mistakes integer; next_score bigint;
  answer_time timestamptz;
begin
  if p_answer is not null and p_answer not in ('larger', 'same', 'smaller') then raise exception '回答を確認できませんでした'; end if;
  select * into game from public.quiz_survival_sessions where id = p_session_id for update;
  answer_time := clock_timestamp();
  if not found or p_client_id is null or game.client_id <> p_client_id
    or p_question_index is null or game.current_index <> p_question_index
    or game.question_started_at is null or game.current_question_id is null
    or game.completed_at is not null or game.expires_at <= answer_time then
    raise exception 'ゲームセッションを確認できませんでした';
  end if;
  elapsed := least(12000, greatest(0, round(extract(epoch from (answer_time - game.question_started_at)) * 1000))::integer);
  select c.outcome into expected from public.quiz_survival_catalog c where c.id = game.current_question_id;
  if expected is null then raise exception '出題データを確認できませんでした'; end if;
  correct := elapsed < 12000 and coalesce(p_answer = expected, false);
  points := case when correct then 1000 + floor(200.0 * (12000 - elapsed) / 12000)::integer else 0 end;
  next_correct := game.correct_count + case when correct then 1 else 0 end;
  next_mistakes := game.mistakes + case when correct then 0 else 1 end;
  next_score := game.score + points;
  insert into public.quiz_survival_answers (session_id, question_index, question_id, answer, is_correct, elapsed_ms, earned, answered_at)
    values (game.id, p_question_index, game.current_question_id, case when elapsed < 12000 then p_answer else null end,
      correct, elapsed, points, answer_time);
  update public.quiz_survival_sessions
    set current_index = game.current_index + 1, correct_count = next_correct, mistakes = next_mistakes,
        score = next_score, total_elapsed_ms = game.total_elapsed_ms + elapsed,
        current_question_id = null, question_started_at = null,
        completed_at = case when next_mistakes = 3 then answer_time else null end,
        expires_at = answer_time + interval '30 minutes'
    where id = game.id;
  return query select expected, correct, elapsed, points, next_score, next_correct, next_mistakes, next_mistakes = 3;
end;
$$;

create or replace function public.register_quiz_survival_score(p_session_id uuid, p_client_id uuid, p_player_name text)
returns table (accepted boolean, message text)
language plpgsql security definer set search_path = '' as $$
declare game public.quiz_survival_sessions%rowtype;
  cleaned_name text := btrim(normalize(coalesce(p_player_name, ''), NFKC));
begin
  if not public.quiz_name_is_allowed(cleaned_name) then return query select false, '名前を確認してください'; return; end if;
  select * into game from public.quiz_survival_sessions where id = p_session_id for update;
  if not found or p_client_id is null or game.client_id <> p_client_id or game.completed_at is null
    or game.mistakes <> 3 or game.claimed_at is not null or game.expires_at <= clock_timestamp() then
    return query select false, '終了したゲーム記録を確認できませんでした'; return;
  end if;
  insert into public.quiz_survival_scores (session_id, player_name, score, correct_count, average_ms, client_id)
    values (game.id, cleaned_name, game.score, game.correct_count,
      round(game.total_elapsed_ms::numeric / game.current_index)::integer, game.client_id);
  update public.quiz_survival_sessions set claimed_at = clock_timestamp() where id = game.id;
  return query select true, 'ランキングに登録しました';
end;
$$;

create or replace function public.get_quiz_survival_leaderboard(p_period text default 'all')
returns table (rank bigint, player_name text, score bigint, correct_count integer, played_at timestamptz)
language sql security definer set search_path = '' as $$
  with bounds as (
    select case p_period
      when 'daily' then date_trunc('day', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo'
      when 'weekly' then date_trunc('week', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo'
      else '-infinity'::timestamptz end as starts_at
  ), personal_bests as (
    select distinct on (s.client_id) s.player_name, s.score, s.correct_count, s.created_at, s.id
    from public.quiz_survival_scores s cross join bounds
    where s.created_at >= bounds.starts_at
    order by s.client_id, s.score desc, s.correct_count desc, s.created_at asc, s.id asc
  ), top_scores as (
    select * from personal_bests order by score desc, correct_count desc, created_at asc, id asc limit 10
  )
  select row_number() over (order by score desc, correct_count desc, created_at asc, id asc),
    player_name, score, correct_count, created_at from top_scores order by 1;
$$;

revoke all on function public.pick_quiz_survival_question(text[], integer) from public, anon, authenticated;
revoke all on function public.start_quiz_survival_game(uuid) from public;
revoke all on function public.open_quiz_survival_question(uuid, uuid, integer) from public;
revoke all on function public.answer_quiz_survival_question(uuid, uuid, integer, text) from public;
revoke all on function public.register_quiz_survival_score(uuid, uuid, text) from public;
revoke all on function public.get_quiz_survival_leaderboard(text) from public;
grant execute on function public.start_quiz_survival_game(uuid) to anon, authenticated;
grant execute on function public.open_quiz_survival_question(uuid, uuid, integer) to anon, authenticated;
grant execute on function public.answer_quiz_survival_question(uuid, uuid, integer, text) to anon, authenticated;
grant execute on function public.register_quiz_survival_score(uuid, uuid, text) to anon, authenticated;
grant execute on function public.get_quiz_survival_leaderboard(text) to anon, authenticated;

-- The version marker makes the reset safe to retry after a deployment failure.
do $$
begin
  if not exists (select 1 from public.quiz_rulesets where version = 'survival-v2') then
    delete from public.quiz_scores;
    if to_regclass('public.quiz_game_sessions') is not null then
      delete from public.quiz_game_sessions;
    end if;
    insert into public.quiz_rulesets (version) values ('survival-v2');
  end if;
end;
$$;
-- Retire the old public write endpoints so cached v1 clients cannot refill it.
revoke execute on function public.submit_quiz_score(text, integer, integer, integer, uuid) from public, anon, authenticated;
do $$
begin
  if to_regprocedure('public.start_quiz_game(uuid)') is not null then
    execute 'revoke execute on function public.start_quiz_game(uuid) from public, anon, authenticated';
    execute 'revoke execute on function public.open_quiz_question(uuid, uuid, integer) from public, anon, authenticated';
    execute 'revoke execute on function public.answer_quiz_question(uuid, uuid, integer, text) from public, anon, authenticated';
    execute 'revoke execute on function public.register_quiz_session_score(uuid, uuid, text) from public, anon, authenticated';
  end if;
end;
$$;
notify pgrst, 'reload schema';
commit;
