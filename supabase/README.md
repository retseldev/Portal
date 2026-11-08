# Online accounts and deployment

The login and registration pages use Supabase Auth. Registered accounts and their roles are stored in Supabase `auth.users` and `public.profiles`. Successful logins are recorded in `public.login_events`. Student registration creates a pending student profile and private 2x2 photo in Supabase. Any teacher can review a pending registration and approve the student onto their own roster; only a school administrator can reject a registration. Parent-child profile linking is disabled.

## 1. Create the Supabase project

1. Create a project at [supabase.com](https://supabase.com/).
2. Open **SQL Editor**, paste in `schema.sql`, and run it. When applying this workflow to an existing project, run the updated schema to add approval status, teacher review/assignment functions, and the required row-level security policies. The script adds `students`, `attendance`, and `advising_requests` to Supabase Realtime and reloads the PostgREST schema cache when it finishes. Existing projects should run the teacher approval and legacy-claim migration to let teachers review pending registrations and claim approved-but-unassigned legacy student rows. This migration also includes the teacher review and assignment changes from the student approval update. Existing projects that previously enabled teacher School Admin access requests should run the related removal migration to clean up those RPCs and their request table. To update an existing project for student advising and attendance sync, run the advising/attendance migration. To update an existing project for registration cleanup and live queue sync, run the registration sync migration. To update an existing project for permanent deletion on decline, run the decline-cleanup migration. To enable live updates without reapplying the full schema, run the realtime migration. Pending registrations refresh every 30 seconds and have a manual refresh button. If the approval column is the only missing part, run the status migration in that project's SQL Editor, then refresh the app.
   The `approved` default preserves access for students already registered before the approval workflow was installed; new registrations are explicitly created as `pending`. If the error remains after running the migration, verify the `Project URL` in `supabase-config.js` matches the Supabase project where you ran it.
3. In **Project Settings → API**, copy the Project URL and the `anon`/publishable public key into `supabase-config.js`.
   - These values are public in a static website. Never put a `service_role` or secret key in this file.
4. In **Authentication → URL Configuration**, set the site URL to your Vercel or GitHub Pages website URL and add the deployed `forgot-password.html` URL to the allowed redirect URLs. Password reset emails return to that page.
5. For a classroom prototype, disable email confirmations in **Authentication → Providers → Email** so student photo uploads can finish immediately after signup. With confirmations enabled, Supabase creates the account but the photo upload requires a confirmation-aware server workflow.

Do not use real student information or photos for a public demonstration. Accounts, student registration and photos, attendance, and academic advising requests use Supabase and are shared between the student and assigned teacher portals. School events and notifications still use browser storage. Parent accounts cannot access student profiles.

## 2. Run locally

Serve the project directory over HTTP (ES modules and Supabase Auth do not work reliably from a `file://` URL). For example:

```powershell
py -m http.server 8000
```

Open `http://localhost:8000` and use the teacher/parent/student links in the hamburger menu.

## 3. Deploy the static example

- **Vercel:** import the repository, keep the project root at the directory containing `index.html`, select the **Other** framework preset, and leave the build command empty. Deploy the static files.
- **GitHub Pages:** push the files to a repository, then enable Pages for the branch and root directory containing `index.html`.
- After deployment, add the deployed URL to the Supabase Auth URL configuration. The `supabase-config.js` file must contain the same project URL and public anon/publishable key in the deployed site.

## Data access and security

- Supabase Auth stores email/password credentials; this application never writes passwords to browser storage or a custom table.
- `profiles` records the account's role and display name. `login_events` records successful logins through the `record_portal_login()` RPC. A user can read their own login history; school administrators can read all login events.
- Student registrations start as `pending` and appear in every Teacher portal's Student approval access list with their name, Student ID, photo, and status. Older student rows can have `approved` status but no teacher because `approved` was the legacy default; teachers can claim these unassigned students as well. Any teacher can approve or claim a student to add them to their own roster; only school administrators can reject registrations. Existing projects must apply the latest teacher approval and legacy-claim migration to enable teacher review, assignment, and claiming approved-but-unassigned legacy students. The registration handler creates the student row, uploads the photo, and only then completes the portal redirect. If either database insert or photo upload fails, it removes the incomplete photo and asks Supabase to delete the incomplete student account. Existing projects must also apply the registration sync migration for this cleanup RPC and its storage policy. Approved students can sign in to their student portal.
- Approved students assigned to a teacher can request an academic advising appointment from the student portal. The assigned teacher sees the request and can accept or decline it. Attendance recorded by a teacher is saved in Supabase and is visible in the student's attendance timeline. Existing projects must apply `migrations/20261106170000_sync_student_advising_attendance.sql`; it enables Realtime updates and limits appointment requests to approved students with an assigned teacher.
- Declining a pending registration permanently removes the uploaded photo through the Storage API, then deletes the student Auth account and its profile. Related student rows such as login history, advising requests, attendance, and legacy parent-link records are removed by database cascades. The admin must confirm this irreversible action. Existing projects must apply `migrations/20261106154500_delete_declined_student_registrations.sql`.
- Student photos are in the private `student-photos` bucket. Row-level security lets the student see their own photo, any teacher review pending registrations, and the assigned teacher access approved student photos.
- Parent registration creates a parent portal account only. It does not link a student; student details remain unavailable in the parent portal.
- Promote a school administrator from the SQL Editor by setting `is_school_admin = true` on that teacher's profile. Teachers review and approve pending students to their own rosters from the Teacher portal's **Admin tools → Student approval access** panel. A school administrator is still required to reject registrations and manage school announcements. For example, promote a teacher account with:

  ```sql
  update public.profiles p
  set is_school_admin = true
  from auth.users u
  where p.id = u.id
    and lower(u.email) = lower('ADMIN_TEACHER_EMAIL')
    and p.role = 'teacher';
  ```

- School Admin access is assigned directly by school leadership in Supabase; it cannot be requested or granted inside the app. Existing projects must run `migrations/20261106162000_remove_teacher_admin_access_requests.sql` if the old access-request feature was enabled. To disable parent-child linking on an existing project, run `migrations/20261106163500_disable_parent_child_linking.sql`. This removes the linking RPCs and parent access to linked student records; it leaves legacy link rows in the database, inaccessible to app users.

- Never rely on hidden links or client-side role checks as a security boundary. Keep RLS enabled and do not expose service-role credentials.
