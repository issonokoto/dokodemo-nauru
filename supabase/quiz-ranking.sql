create extension if not exists pgcrypto;

create table if not exists public.quiz_scores (
  id bigint generated always as identity primary key,
  player_name text not null,
  score integer not null,
  correct_count smallint not null,
  average_ms integer not null,
  client_id uuid not null,
  created_at timestamptz not null default now(),
  constraint quiz_scores_player_name_length check (char_length(player_name) between 1 and 10),
  constraint quiz_scores_score_range check (score between 0 and 15000),
  constraint quiz_scores_correct_count_range check (correct_count between 0 and 10),
  constraint quiz_scores_average_ms_range check (average_ms between 0 and 12000),
  constraint quiz_scores_score_envelope check (
    (correct_count = 0 and score = 0)
    or (
      correct_count > 0
      and score >= correct_count * 1000
      and score < correct_count * 1500
    )
  )
);

create index if not exists quiz_scores_period_rank_idx
  on public.quiz_scores (created_at desc, score desc, correct_count desc, average_ms asc);

create index if not exists quiz_scores_client_period_idx
  on public.quiz_scores (client_id, created_at desc);

alter table public.quiz_scores enable row level security;
alter table public.quiz_scores force row level security;

revoke all on public.quiz_scores from anon, authenticated;
revoke all on sequence public.quiz_scores_id_seq from anon, authenticated;

create or replace function public.normalize_quiz_player_name(input_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(lower(
    regexp_replace(
      normalize(coalesce(input_name, ''), NFKC),
      '[[:space:]ー・_.\-]+',
      '',
      'g'
    )
  ), '013457', 'oieast');
$$;

create or replace function public.quiz_name_is_allowed(input_name text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  cleaned text := btrim(normalize(coalesce(input_name, ''), NFKC));
  compact text := public.normalize_quiz_player_name(input_name);
  blocked_terms constant text[] := array[
    'しね', '死ね', 'ころす', '殺す', 'くたばれ', 'きえろ',
    'ちんこ', 'ちんぽ', 'まんこ', 'せっくす', 'おまんこ',
    'f u c k', 'fuck', 'shit', 'cunt', 'nigger', 'nigga',
    'retard', 'kike', 'chink', 'spic'
  ];
  term text;
begin
  if char_length(cleaned) < 1 or char_length(cleaned) > 10 then
    return false;
  end if;
  if cleaned ~ '[[:cntrl:]<>]' or cleaned ~* '(https?://|www\.|@)' then
    return false;
  end if;
  if cleaned !~ '^[[:alnum:]ぁ-んァ-ヶ一-龠々〆ヵヶー・ _.\-]+$' then
    return false;
  end if;
  foreach term in array blocked_terms loop
    if compact like '%' || public.normalize_quiz_player_name(term) || '%' then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create or replace function public.submit_quiz_score(
  p_player_name text,
  p_score integer,
  p_correct_count integer,
  p_average_ms integer,
  p_client_id uuid
)
returns table (accepted boolean, message text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleaned_name text := btrim(normalize(coalesce(p_player_name, ''), NFKC));
begin
  if not public.quiz_name_is_allowed(cleaned_name) then
    return query select false, '名前を確認してください';
    return;
  end if;
  if p_score < 0 or p_score > 15000
    or p_correct_count < 0 or p_correct_count > 10
    or p_average_ms < 0 or p_average_ms > 12000
    or not (
      (p_correct_count = 0 and p_score = 0)
      or (
        p_correct_count > 0
        and p_score >= p_correct_count * 1000
        and p_score < p_correct_count * 1500
      )
    ) then
    return query select false, 'スコアを確認できませんでした';
    return;
  end if;
  if exists (
    select 1
    from public.quiz_scores
    where client_id = p_client_id
      and created_at > now() - interval '15 seconds'
  ) then
    return query select false, '少し待ってから登録してください';
    return;
  end if;
  if (
    select count(*)
    from public.quiz_scores
    where client_id = p_client_id
      and created_at >= date_trunc('day', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo'
  ) >= 50 then
    return query select false, '本日の登録上限に達しました';
    return;
  end if;

  insert into public.quiz_scores (player_name, score, correct_count, average_ms, client_id)
  values (cleaned_name, p_score, p_correct_count, p_average_ms, p_client_id);

  return query select true, 'ランキングに登録しました';
end;
$$;

create or replace function public.get_quiz_leaderboard(p_period text default 'all')
returns table (
  rank bigint,
  player_name text,
  score integer,
  correct_count smallint,
  average_ms integer,
  played_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select case p_period
      when 'daily' then
        date_trunc('day', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo'
      when 'weekly' then
        date_trunc('week', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo'
      else '-infinity'::timestamptz
    end as starts_at
  ),
  personal_bests as (
    select distinct on (scores.client_id)
      scores.player_name,
      scores.score,
      scores.correct_count,
      scores.average_ms,
      scores.created_at
    from public.quiz_scores as scores
    cross join bounds
    where scores.created_at >= bounds.starts_at
    order by
      scores.client_id,
      scores.score desc,
      scores.correct_count desc,
      scores.average_ms asc,
      scores.created_at asc
  ),
  top_scores as (
    select *
    from personal_bests
    order by score desc, correct_count desc, average_ms asc, created_at asc
    limit 10
  )
  select
    row_number() over (order by score desc, correct_count desc, average_ms asc, created_at asc) as rank,
    player_name,
    score,
    correct_count,
    average_ms,
    created_at as played_at
  from top_scores
  order by rank;
$$;

revoke all on function public.normalize_quiz_player_name(text) from public, anon, authenticated;
revoke all on function public.quiz_name_is_allowed(text) from public, anon, authenticated;
revoke all on function public.submit_quiz_score(text, integer, integer, integer, uuid) from public;
revoke all on function public.get_quiz_leaderboard(text) from public;

grant execute on function public.submit_quiz_score(text, integer, integer, integer, uuid) to anon, authenticated;
grant execute on function public.get_quiz_leaderboard(text) to anon, authenticated;
