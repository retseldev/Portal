alter table public.profiles
  add column if not exists is_school_admin boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'school_admin_is_teacher'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint school_admin_is_teacher
      check (not is_school_admin or role = 'teacher');
  end if;
end;
$$;

alter table public.students
  add column if not exists approval_status text not null default 'approved';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'students_approval_status_check'
      and conrelid = 'public.students'::regclass
  ) then
    alter table public.students
      add constraint students_approval_status_check
      check (approval_status in ('pending', 'approved', 'rejected'));
  end if;
end;
$$;

create or replace function public.cancel_incomplete_student_registration()
returns void
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'student'
  ) then
    raise exception 'An authenticated student account is required';
  end if;

  if exists (
    select 1 from public.students s
    where s.profile_id = auth.uid()
      and s.approval_status <> 'pending'
  ) then
    raise exception 'Only an incomplete pending student registration can be removed';
  end if;

  delete from auth.users
  where id = auth.uid();

  if not found then
    raise exception 'The incomplete student account could not be removed';
  end if;
end;
$$;

revoke all on function public.cancel_incomplete_student_registration() from public;
grant execute on function public.cancel_incomplete_student_registration() to authenticated;

drop policy if exists "student_photos_delete_pending_owner" on storage.objects;
create policy "student_photos_delete_pending_owner" on storage.objects
  for delete to authenticated using (
    bucket_id = 'student-photos'
    and exists (
      select 1 from public.students s
      where s.id::text = (storage.foldername(name))[1]
        and s.profile_id = auth.uid()
        and s.approval_status = 'pending'
    )
  );

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'students'
     ) then
    alter publication supabase_realtime add table public.students;
  end if;
end;
$$;

notify pgrst, 'reload schema';
