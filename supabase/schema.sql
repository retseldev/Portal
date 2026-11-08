create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  create type public.portal_role as enum ('teacher', 'parent', 'student');
exception
  when duplicate_object then null;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role public.portal_role not null,
  display_name text not null,
  is_school_admin boolean not null default false,
  created_at timestamptz not null default now(),
  constraint school_admin_is_teacher check (not is_school_admin or role = 'teacher')
);

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

create table if not exists public.login_events (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.portal_role not null,
  signed_in_at timestamptz not null default now()
);

create table if not exists public.students (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_id uuid not null unique references public.profiles (id) on delete cascade,
  teacher_id uuid references public.profiles (id) on delete set null,
  student_code text not null unique,
  display_name text not null,
  photo_path text not null,
  academic_standing text,
  teacher_feedback text,
  created_at timestamptz not null default now(),
  approval_status text not null default 'pending',
  constraint students_approval_status_check check (approval_status in ('pending', 'approved', 'rejected'))
);

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

create table if not exists public.parent_student_links (
  parent_id uuid not null references public.profiles (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (parent_id, student_id)
);

create table if not exists public.parent_link_invites (
  id uuid primary key default extensions.gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  code_hash bytea not null,
  expires_at timestamptz not null,
  unique (student_id, code_hash)
);

create table if not exists public.attendance (
  id uuid primary key default extensions.gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  marked_by uuid not null references public.profiles (id),
  attendance_date date not null,
  semester smallint not null check (semester between 1 and 4),
  status text not null check (status in ('present', 'late', 'absent')),
  created_at timestamptz not null default now(),
  unique (student_id, attendance_date)
);

create table if not exists public.advising_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  requester_id uuid not null references public.profiles (id),
  requested_at timestamptz not null,
  message text not null,
  status text not null default 'Pending' check (status in ('Pending', 'Accepted', 'Declined')),
  reviewed_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create table if not exists public.school_posts (
  id uuid primary key default extensions.gen_random_uuid(),
  author_id uuid not null references public.profiles (id),
  post_type text not null check (post_type in ('event', 'announcement')),
  title text not null,
  details text not null,
  event_date date,
  created_at timestamptz not null default now()
);

create table if not exists public.feedback (
  id uuid primary key default extensions.gen_random_uuid(),
  name text check (name is null or length(trim(name)) <= 100),
  role text not null check (role in ('Teacher', 'Parent', 'Student')),
  message text not null check (length(trim(message)) between 5 and 5000),
  created_at timestamptz not null default now()
);

create index if not exists students_teacher_id_idx on public.students (teacher_id);
create index if not exists login_events_user_signed_in_at_idx on public.login_events (user_id, signed_in_at desc);
create index if not exists parent_student_links_student_id_idx on public.parent_student_links (student_id);
create index if not exists attendance_student_semester_date_idx on public.attendance (student_id, semester, attendance_date desc);
create index if not exists advising_requests_student_status_idx on public.advising_requests (student_id, status);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_role public.portal_role;
begin
  requested_role := coalesce(
    (new.raw_user_meta_data ->> 'role')::public.portal_role,
    'student'::public.portal_role
  );
  insert into public.profiles (id, role, display_name)
  values (
    new.id,
    requested_role,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), 'School user')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

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
          and (
            s.teacher_id = auth.uid()
          )
        )
      )
  );
$$;

create or replace function public.is_school_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'teacher' and p.is_school_admin
  );
$$;

create or replace function public.is_teacher()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'teacher'
  );
$$;

create or replace function public.list_school_teachers()
returns table (id uuid, display_name text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_school_admin() then
    raise exception 'Only a school administrator can list teachers for assignment';
  end if;

  return query
  select p.id, p.display_name
  from public.profiles p
  where p.role = 'teacher'
  order by p.display_name;
end;
$$;

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

create or replace function public.record_portal_login()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.login_events (user_id, role)
  select p.id, p.role
  from public.profiles p
  where p.id = auth.uid();

  if not found then
    raise exception 'An authenticated portal profile is required';
  end if;
end;
$$;

drop function if exists public.create_parent_link_invite(uuid);
drop function if exists public.link_child_profile(text, text, text);
drop function if exists public.link_child_profile(text, text);

alter table public.profiles enable row level security;
alter table public.login_events enable row level security;
alter table public.students enable row level security;
alter table public.parent_student_links enable row level security;
alter table public.parent_link_invites enable row level security;
alter table public.attendance enable row level security;
alter table public.advising_requests enable row level security;
alter table public.school_posts enable row level security;
alter table public.feedback enable row level security;

grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.students,
  public.attendance, public.advising_requests to authenticated;
revoke all on public.parent_student_links, public.parent_link_invites from public, anon, authenticated;
grant select on public.login_events to authenticated;
grant insert on public.students, public.attendance, public.advising_requests to authenticated;
grant delete on public.students to authenticated;
grant update on public.attendance to authenticated;
grant delete on public.attendance to authenticated;
grant select on public.school_posts to anon, authenticated;
grant insert, update, delete on public.school_posts to authenticated;
grant insert on public.feedback to anon, authenticated;

drop policy if exists "profiles_read_self" on public.profiles;
create policy "profiles_read_self" on public.profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.profiles from public, anon, authenticated;
grant update (display_name) on public.profiles to authenticated;

drop policy if exists "login_events_read_own_or_admin" on public.login_events;
create policy "login_events_read_own_or_admin" on public.login_events
  for select to authenticated using (user_id = auth.uid() or public.is_school_admin());

drop policy if exists "students_read_linked" on public.students;
create policy "students_read_linked" on public.students
  for select to authenticated using (public.can_access_student(id));

drop policy if exists "students_read_admin" on public.students;
create policy "students_read_admin" on public.students
  for select to authenticated using (public.is_school_admin());

drop policy if exists "students_read_pending_teacher" on public.students;
create policy "students_read_pending_teacher" on public.students
  for select to authenticated using (
    public.is_teacher()
    and (
      approval_status = 'pending'
      or (approval_status = 'approved' and teacher_id is null)
    )
  );

drop policy if exists "students_create_self" on public.students;
create policy "students_create_self" on public.students
  for insert to authenticated with check (
    profile_id = auth.uid()
    and teacher_id is null
    and approval_status = 'pending'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'student')
  );

drop policy if exists "students_delete_self" on public.students;
create policy "students_delete_self" on public.students
  for delete to authenticated using (
    profile_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'student')
  );

drop policy if exists "students_update_assigned_teacher" on public.students;
create policy "students_update_assigned_teacher" on public.students
  for update to authenticated using (
    approval_status = 'approved' and teacher_id = auth.uid() and public.is_teacher()
  )
  with check (
    approval_status = 'approved' and teacher_id = auth.uid() and public.is_teacher()
  );
revoke update on public.students from public, anon, authenticated;
grant update (academic_standing, teacher_feedback) on public.students to authenticated;

drop policy if exists "parent_links_read_own" on public.parent_student_links;

drop policy if exists "attendance_read_linked" on public.attendance;
create policy "attendance_read_linked" on public.attendance
  for select to authenticated using (public.can_access_student(student_id));

drop policy if exists "attendance_write_assigned_teacher" on public.attendance;
create policy "attendance_write_assigned_teacher" on public.attendance
  for all to authenticated
  using (public.is_teacher() and exists (select 1 from public.students s where s.id = student_id and s.teacher_id = auth.uid()))
  with check (
    marked_by = auth.uid()
    and public.is_teacher()
    and exists (select 1 from public.students s where s.id = student_id and s.teacher_id = auth.uid())
  );

drop policy if exists "advising_read_linked" on public.advising_requests;
create policy "advising_read_linked" on public.advising_requests
  for select to authenticated using (public.can_access_student(student_id));

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

drop policy if exists "advising_review_assigned_teacher" on public.advising_requests;
create policy "advising_review_assigned_teacher" on public.advising_requests
  for update to authenticated
  using (
    public.is_teacher()
    and exists (select 1 from public.students s where s.id = student_id and s.teacher_id = auth.uid())
  )
  with check (
    reviewed_by = auth.uid()
    and public.is_teacher()
    and exists (select 1 from public.students s where s.id = student_id and s.teacher_id = auth.uid())
  );
revoke update on public.advising_requests from public, anon, authenticated;
grant update (status, reviewed_by) on public.advising_requests to authenticated;

drop policy if exists "school_posts_read_public" on public.school_posts;
create policy "school_posts_read_public" on public.school_posts
  for select to anon, authenticated using (true);

drop policy if exists "school_posts_manage_admin" on public.school_posts;
create policy "school_posts_manage_admin" on public.school_posts
  for all to authenticated
  using (author_id = auth.uid() and public.is_school_admin())
  with check (author_id = auth.uid() and public.is_school_admin());

drop policy if exists "feedback_submit_public" on public.feedback;
create policy "feedback_submit_public" on public.feedback
  for insert to anon, authenticated
  with check (
    role in ('Teacher', 'Parent', 'Student')
    and length(trim(message)) between 5 and 5000
    and (name is null or length(trim(name)) <= 100)
  );

revoke all on function public.list_school_teachers() from public;
revoke all on function public.approve_student_registration(uuid) from public;
revoke all on function public.reject_student_registration(uuid) from public;
revoke all on function public.cancel_incomplete_student_registration() from public;
revoke all on function public.record_portal_login() from public;
revoke all on function public.can_access_student(uuid) from public;
revoke all on function public.is_school_admin() from public;
revoke all on function public.is_teacher() from public;
grant execute on function public.can_access_student(uuid) to authenticated;
grant execute on function public.is_school_admin() to authenticated;
grant execute on function public.is_teacher() to authenticated;
grant execute on function public.list_school_teachers() to authenticated;
grant execute on function public.approve_student_registration(uuid) to authenticated;
grant execute on function public.reject_student_registration(uuid) to authenticated;
grant execute on function public.cancel_incomplete_student_registration() to authenticated;
grant execute on function public.record_portal_login() to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('student-photos', 'student-photos', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

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

drop policy if exists "student_photos_upload_owner" on storage.objects;
create policy "student_photos_upload_owner" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'student-photos'
    and exists (
      select 1 from public.students s
      where s.id::text = (storage.foldername(name))[1]
        and s.profile_id = auth.uid()
    )
  );

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
