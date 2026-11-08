drop function if exists public.approve_student_registration(uuid, uuid);

create or replace function public.approve_student_registration(target_student_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_teacher() then
    raise exception 'Only a teacher can approve student registrations';
  end if;

  update public.students
  set approval_status = 'approved',
      teacher_id = auth.uid()
  where id = target_student_id
    and (
      approval_status = 'pending'
      or (approval_status = 'approved' and teacher_id is null)
    );

  if not found then
    raise exception 'This student is no longer available to assign; refresh the list and try again';
  end if;
end;
$$;

revoke all on function public.approve_student_registration(uuid) from public, anon;
grant execute on function public.approve_student_registration(uuid) to authenticated;

drop policy if exists "students_read_pending_teacher" on public.students;
create policy "students_read_pending_teacher" on public.students
  for select to authenticated using (
    public.is_teacher()
    and (
      approval_status = 'pending'
      or (approval_status = 'approved' and teacher_id is null)
    )
  );

drop policy if exists "student_photos_read_linked" on storage.objects;
create policy "student_photos_read_linked" on storage.objects
  for select to authenticated using (
    bucket_id = 'student-photos'
    and exists (
      select 1 from public.students s
      where s.id::text = (storage.foldername(name))[1]
        and (
          public.can_access_student(s.id)
          or public.is_school_admin()
          or (
            public.is_teacher()
            and (
              s.approval_status = 'pending'
              or (s.approval_status = 'approved' and s.teacher_id is null)
            )
          )
        )
    )
  );

notify pgrst, 'reload schema';
