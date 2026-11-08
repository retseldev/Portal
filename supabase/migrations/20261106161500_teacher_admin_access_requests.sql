create table if not exists public.teacher_admin_access_requests (
  teacher_id uuid primary key references public.profiles (id) on delete cascade,
  requested_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz
);
revoke all on table public.teacher_admin_access_requests from public, anon, authenticated;

alter table public.teacher_admin_access_requests enable row level security;

create or replace function public.request_school_admin_access()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_status text;
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'teacher'
  ) then
    raise exception 'Only a teacher account can request School Admin access';
  end if;

  if public.is_school_admin() then
    raise exception 'This teacher already has School Admin access';
  end if;

  insert into public.teacher_admin_access_requests (teacher_id, status, requested_at, reviewed_by, reviewed_at)
  values (auth.uid(), 'pending', now(), null, null)
  on conflict (teacher_id) do update
    set status = 'pending',
        requested_at = now(),
        reviewed_by = null,
        reviewed_at = null
  returning status into current_status;

  return current_status;
end;
$$;

create or replace function public.get_school_admin_access_request()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'teacher'
  ) then
    raise exception 'Only a teacher account can check School Admin access';
  end if;

  if public.is_school_admin() then
    return 'approved';
  end if;

  return coalesce(
    (select r.status from public.teacher_admin_access_requests r where r.teacher_id = auth.uid()),
    'none'
  );
end;
$$;

create or replace function public.list_school_admin_access_requests()
returns table (teacher_id uuid, display_name text, requested_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_school_admin() then
    raise exception 'Only a School Admin can review teacher access requests';
  end if;

  return query
  select r.teacher_id, p.display_name, r.requested_at
  from public.teacher_admin_access_requests r
  join public.profiles p on p.id = r.teacher_id
  where r.status = 'pending' and p.role = 'teacher'
  order by r.requested_at;
end;
$$;

create or replace function public.review_school_admin_access_request(
  target_teacher_id uuid,
  approve_request boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_school_admin() then
    raise exception 'Only a School Admin can review teacher access requests';
  end if;

  if target_teacher_id = auth.uid() then
    raise exception 'A School Admin cannot review their own access request';
  end if;

  perform 1
  from public.teacher_admin_access_requests r
  join public.profiles p on p.id = r.teacher_id
  where r.teacher_id = target_teacher_id
    and r.status = 'pending'
    and p.role = 'teacher'
  for update of r;

  if not found then
    raise exception 'This teacher access request is no longer pending';
  end if;

  if approve_request then
    update public.profiles
    set is_school_admin = true
    where id = target_teacher_id and role = 'teacher';
  end if;

  update public.teacher_admin_access_requests
  set status = case when approve_request then 'approved' else 'rejected' end,
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where teacher_id = target_teacher_id
    and status = 'pending';
end;
$$;

revoke all on function public.request_school_admin_access() from public;
revoke all on function public.get_school_admin_access_request() from public;
revoke all on function public.list_school_admin_access_requests() from public;
revoke all on function public.review_school_admin_access_request(uuid, boolean) from public;

grant execute on function public.request_school_admin_access() to authenticated;
grant execute on function public.get_school_admin_access_request() to authenticated;
grant execute on function public.list_school_admin_access_requests() to authenticated;
grant execute on function public.review_school_admin_access_request(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
