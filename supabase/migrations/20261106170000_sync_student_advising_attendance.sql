drop policy if exists "advising_request_as_parent" on public.advising_requests;
drop policy if exists "advising_request_as_student" on public.advising_requests;
create policy "advising_request_as_student" on public.advising_requests
  for insert to authenticated with check (
    requester_id = auth.uid()
    and status = 'Pending'
    and reviewed_by is null
    and exists (
      select 1 from public.students s
      where s.id = advising_requests.student_id
        and s.profile_id = auth.uid()
        and s.approval_status = 'approved'
        and s.teacher_id is not null
    )
  );

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'attendance'
     ) then
    alter publication supabase_realtime add table public.attendance;
  end if;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'advising_requests'
     ) then
    alter publication supabase_realtime add table public.advising_requests;
  end if;
end;
$$;

notify pgrst, 'reload schema';
