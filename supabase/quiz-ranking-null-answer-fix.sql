-- Apply once to the existing database before deploying the updated quiz UI.
-- Preserve the installed function's signature, grants and unrelated logic.
begin;
do $migration$
declare
  definition text;
  revised text;
begin
  select pg_get_functiondef('public.answer_quiz_question(uuid,uuid,integer,text)'::regprocedure)
    into definition;
  revised := replace(definition,
    'was_correct := server_elapsed < 12000 and p_answer = expected_outcome;',
    'was_correct := server_elapsed < 12000 and coalesce(p_answer = expected_outcome, false);');
  if revised = definition then
    if position('coalesce(p_answer = expected_outcome, false)' in definition) = 0 then
      raise exception 'Unexpected answer_quiz_question implementation; no changes applied';
    end if;
  else
    execute revised;
  end if;
end;
$migration$;
commit;
