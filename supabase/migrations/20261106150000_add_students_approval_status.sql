alter table public.students
  add column if not exists approval_status text not null default 'approved';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'students_approval_status_check'
      and conrelid = 'public.students'::regclass
  ) then
    alter table public.students
      add constraint students_approval_status_check
      check (approval_status in ('pending', 'approved', 'rejected'));
  end if;
end;
$$;

notify pgrst, 'reload schema';
