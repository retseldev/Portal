# Online accounts and deployment

The login and registration pages use Supabase Auth. Registered accounts and their roles are stored in Supabase `auth.users` and `public.profiles`. Successful logins are recorded in `public.login_events`. Student registration stores the student profile and private 2x2 photo in Supabase; parent registration links to the child using the student's ID, name, and time-limited invite code.

## 1. Create the Supabase project

1. Create a project at [supabase.com](https://supabase.com/).
2. Open **SQL Editor**, paste in `schema.sql`, and run it.
3. In **Project Settings → API**, copy the Project URL and the `anon`/publishable public key into `supabase-config.js`.
   - These values are public in a static website. Never put a `service_role` or secret key in this file.
4. In **Authentication → URL Configuration**, set the site URL to your Vercel or GitHub Pages website URL and add the deployed `forgot-password.html` URL to the allowed redirect URLs. Password reset emails return to that page.
5. For a classroom prototype, disable email confirmations in **Authentication → Providers → Email** so student photo uploads and parent linking can finish immediately after signup. With confirmations enabled, Supabase creates the account but the additional student/parent registration steps require a confirmation-aware server workflow.

Do not use real student information or photos for a public demonstration. The portal dashboard's attendance, advising, event, and notification content still uses browser storage; accounts, login history, student registration/photo, parent-child links, and public feedback submissions use Supabase.

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
- Student photos are in the private `student-photos` bucket. Table/storage row-level security limits access to the student, linked parent, and assigned teacher.
- Parent links use `link_child_profile(student_code, student_name, invite_code)`. Student invite codes expire after seven days and are single-use.
- Promote the initial school administrator from the SQL Editor by setting `is_school_admin = true` on that teacher's profile. Assign students to teachers through a trusted school-administration process.
- Never rely on hidden links or client-side role checks as a security boundary. Keep RLS enabled and do not expose service-role credentials.
