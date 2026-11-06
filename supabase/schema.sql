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
  created_at timestamptz not null default now()
);

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
        or s.teacher_id = auth.uid()
        or exists (
          select 1
          from public.parent_student_links l
          where l.student_id = s.id and l.parent_id = auth.uid()
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

create or replace function public.create_parent_link_invite(target_student_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  invite_code text;
begin
  if not exists (
    select 1 from public.students s
    where s.id = target_student_id and s.profile_id = auth.uid()
  ) then
    raise exception 'Only the student account owner can create a parent link code';
  end if;

  invite_code := encode(extensions.gen_random_bytes(18), 'hex');
  insert into public.parent_link_invites (student_id, code_hash, expires_at)
  values (target_student_id, extensions.digest(invite_code, 'sha256'), now() + interval '7 days');
  return invite_code;
end;
$$;

drop function if exists public.link_child_profile(text, text);
create or replace function public.link_child_profile(
  target_student_code text,
  target_student_name text,
  invite_code text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  matched_student_id uuid;
  matched_invite_id uuid;
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'parent'
  ) then
    raise exception 'A parent account is required to link a student';
  end if;

  select s.id, i.id into matched_student_id, matched_invite_id
  from public.students s
  join public.parent_link_invites i on i.student_id = s.id
  where s.student_code = target_student_code
    and lower(trim(s.display_name)) = lower(trim(target_student_name))
    and i.expires_at > now()
    and i.code_hash = extensions.digest(invite_code, 'sha256');

  if matched_student_id is null then
    raise exception 'The student code or parent link code is invalid or expired';
  end if;

  insert into public.parent_student_links (parent_id, student_id)
  values (auth.uid(), matched_student_id)
  on conflict do nothing;

  delete from public.parent_link_invites where id = matched_invite_id;
  return matched_student_id;
end;
$$;

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
grant select on public.profiles, public.students, public.parent_student_links,
  public.attendance, public.advising_requests to authenticated;
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

drop policy if exists "students_create_self" on public.students;
create policy "students_create_self" on public.students
  for insert to authenticated with check (
    profile_id = auth.uid()
    and teacher_id is null
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
  for update to authenticated using (teacher_id = auth.uid() and public.is_teacher())
  with check (teacher_id = auth.uid() and public.is_teacher());
revoke update on public.students from public, anon, authenticated;
grant update (academic_standing, teacher_feedback) on public.students to authenticated;

drop policy if exists "parent_links_read_own" on public.parent_student_links;
create policy "parent_links_read_own" on public.parent_student_links
  for select to authenticated using (parent_id = auth.uid());

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
create policy "advising_request_as_parent" on public.advising_requests
  for insert to authenticated with check (
    requester_id = auth.uid()
    and status = 'Pending'
    and reviewed_by is null
    and exists (
      select 1 from public.students s
      where s.id = advising_requests.student_id
        and (
          s.profile_id = auth.uid()
          or exists (
            select 1 from public.parent_student_links l
            where l.parent_id = auth.uid() and l.student_id = s.id
          )
        )
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

revoke all on function public.create_parent_link_invite(uuid) from public;
revoke all on function public.link_child_profile(text, text, text) from public;
revoke all on function public.record_portal_login() from public;
revoke all on function public.can_access_student(uuid) from public;
revoke all on function public.is_school_admin() from public;
revoke all on function public.is_teacher() from public;
grant execute on function public.can_access_student(uuid) to authenticated;
grant execute on function public.is_school_admin() to authenticated;
grant execute on function public.is_teacher() to authenticated;
grant execute on function public.create_parent_link_invite(uuid) to authenticated;
grant execute on function public.link_child_profile(text, text, text) to authenticated;
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
        and public.can_access_student(s.id)
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
