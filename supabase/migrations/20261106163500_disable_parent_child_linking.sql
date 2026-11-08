drop function if exists public.create_parent_link_invite(uuid);
drop function if exists public.link_child_profile(text, text, text);
drop function if exists public.link_child_profile(text, text);

create or replace function public.can_access_student(target_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.students s
    where s.id = target_student_id
      and (
        s.profile_id = auth.uid()
        or (
          s.approval_status = 'approved'
          and s.teacher_id = auth.uid()
        )
      )
  );
$$;

revoke all on public.parent_student_links, public.parent_link_invites from public, anon, authenticated;
drop policy if exists "parent_links_read_own" on public.parent_student_links;

drop policy if exists "advising_request_as_parent" on public.advising_requests;
create policy "advising_request_as_parent" on public.advising_requests
  for insert to authenticated with check (
    requester_id = auth.uid()
    and status = 'Pending'
    and reviewed_by is null
    and exists (
      select 1 from public.students s
      where s.id = advising_requests.student_id
        and s.profile_id = auth.uid()
    )
  );

notify pgrst, 'reload schema';
