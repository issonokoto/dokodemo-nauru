begin;

do $hotfix$
declare
  old_source text;
  new_source text;
begin
  select prosrc
  into old_source
  from pg_proc
  where oid = 'public.answer_quiz_question(uuid,uuid,integer,text)'::regprocedure;

  new_source := regexp_replace(
    old_source,
    '[[:space:]]*if[[:space:]]+server_elapsed[[:space:]]*<[[:space:]]*200[[:space:]]+then[[:space:]]+raise exception ''回答が早すぎます'';[[:space:]]+end if;',
    E'\n'
  );

  if new_source = old_source then
    if position('回答が早すぎます' in old_source) > 0 then
      raise exception '高速回答の下限判定を安全に除去できませんでした';
    end if;
    return;
  end if;

  execute format(
    $function$
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
as %L
$function$,
    new_source
  );
end;
$hotfix$;

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

commit;
