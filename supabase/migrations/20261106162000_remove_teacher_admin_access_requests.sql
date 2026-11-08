drop function if exists public.review_school_admin_access_request(uuid, boolean);
drop function if exists public.list_school_admin_access_requests();
drop function if exists public.get_school_admin_access_request();
drop function if exists public.request_school_admin_access();
drop table if exists public.teacher_admin_access_requests;

notify pgrst, 'reload schema';
