-- Update only the picker; existing scores, sessions and answers are preserved.
-- Keep p_correct_count for compatibility with the existing question-opening RPC.
begin;

create or replace function public.pick_quiz_survival_question(p_used_ids text[], p_correct_count integer)
returns text language plpgsql security definer set search_path = '' as $$
declare
  used_ids text[] := coalesce(p_used_ids, '{}');
  outcome_roll double precision := random();
  target_outcome text;
  selected_id text;
begin
  if not exists (select 1 from public.quiz_survival_catalog c where not (c.id = any(used_ids))) then
    used_ids := '{}';
  end if;
  target_outcome := case when outcome_roll < 0.45 then 'larger' when outcome_roll < 0.9 then 'smaller' else 'same' end;
  if not exists (select 1 from public.quiz_survival_catalog c where not (c.id = any(used_ids)) and c.outcome = target_outcome) then
    target_outcome := null;
  end if;
  select c.id into selected_id from public.quiz_survival_catalog c
  where not (c.id = any(used_ids))
    and (target_outcome is null or c.outcome = target_outcome)
  order by random() limit 1;
  if selected_id is null then raise exception '出題候補が不足しています'; end if;
  return selected_id;
end;
$$;

revoke all on function public.pick_quiz_survival_question(text[], integer) from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
