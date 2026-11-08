create or replace function public.reject_student_registration(target_student_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_profile_id uuid;
begin
  if not public.is_school_admin() then
    raise exception 'Only a school administrator can reject student registrations';
  end if;

  select profile_id
  into target_profile_id
  from public.students
  where id = target_student_id
    and approval_status = 'pending'
  for update;

  if target_profile_id is null then
    raise exception 'This student registration is no longer pending review';
  end if;

  delete from public.advising_requests
  where requester_id = target_profile_id;

  delete from auth.users
  where id = target_profile_id;

  if not found then
    raise exception 'The student account could not be deleted';
  end if;
end;
$$;

drop policy if exists "student_photos_delete_pending_admin" on storage.objects;
create policy "student_photos_delete_pending_admin" on storage.objects
  for delete to authenticated using (
    bucket_id = 'student-photos'
    and public.is_school_admin()
    and exists (
      select 1 from public.students s
      where s.id::text = (storage.foldername(name))[1]
        and s.approval_status = 'pending'
    )
  );
