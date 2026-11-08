import { supabase } from "./supabase-client.js";

const accountForm = document.querySelector("#account-form");
const search = new URLSearchParams(window.location.search);
const allowedRoles = ["teacher", "parent", "student"];
const requestedRole = search.get("role");
const hasSelectedRole = allowedRoles.includes(requestedRole);
const selectedRole = hasSelectedRole ? requestedRole : "teacher";
function setSuccess(form, message, isError = false) {
  const notice = form.querySelector(".form-success");
  if (!notice) return;
  notice.textContent = message;
  notice.hidden = false;
  notice.classList.toggle("is-error", isError);
}

function getAccountErrorMessage(error) {
  const message = String(error?.message || "");
  if (/cancel_incomplete_student_registration/i.test(message)) {
    return "Student registration setup is incomplete. Ask your project administrator to apply supabase/migrations/20261106160000_student_registration_sync.sql in the SQL Editor for the project configured in supabase-config.js, then try again.";
  }
  if (/approval_status/i.test(message) && /(column|schema cache|PGRST204|42703)/i.test(message)) {
    return "Student registration is missing the approval_status column in Supabase. Ask the project administrator to run supabase/migrations/20261106150000_add_students_approval_status.sql in the SQL Editor for the project configured in supabase-config.js, wait for the schema cache to reload, then try again. If it was already applied, verify that supabase-config.js points to that same project.";
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "Could not connect to Supabase. Check your internet connection and confirm the project URL and public key in supabase-config.js are correct.";
  }
  return message || "The online account operation failed. Please try again.";
}

function setRequired(selector, required) {
  const input = document.querySelector(selector);
  if (input) input.required = required;
}

function showRoleForm() {
  if (!accountForm) return;
  if (accountForm.dataset.mode === "login" && !hasSelectedRole) {
    window.location.replace("index.html");
    return;
  }
  const roleField = document.querySelector("#account-role");
  roleField.value = selectedRole;
  const isRegister = accountForm.dataset.mode === "register";
  const titles = {
    teacher: ["Teacher", "Create a teacher account with your school email."],
    parent: ["Parent", "Create a parent portal account. No child link code or student connection is required."],
    student: ["Student", "Register and go straight to your Student Portal. School approval may still be needed for some features."],
  };
  const [roleName, intro] = titles[selectedRole];
  document.querySelector("#form-title").textContent = isRegister ? `Register as ${roleName}` : `Log in as ${roleName}`;
  document.querySelector("#form-intro").textContent = isRegister ? intro : `Sign in to your ${roleName.toLowerCase()} portal.`;
  document.querySelector("#submit-label").textContent = isRegister ? `Register as ${roleName}` : `Log in as ${roleName}`;
  const studentFields = document.querySelector("#student-fields");
  if (studentFields) studentFields.hidden = !isRegister || selectedRole !== "student";
  setRequired("#student-id", isRegister && selectedRole === "student");
  setRequired("#student-photo", isRegister && selectedRole === "student");
  const registerLink = document.querySelector("#register-link");
  if (registerLink) registerLink.href = `register.html?role=${selectedRole}`;
  const loginLink = document.querySelector("#login-link");
  if (loginLink) loginLink.href = `login.html?role=${selectedRole}`;
  document.querySelectorAll(".role-switch a").forEach((link) => {
    link.setAttribute("aria-current", link.href.includes(`role=${selectedRole}`) ? "page" : "false");
  });
}

async function validateSquarePhoto(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Choose a JPEG, PNG, or WebP image for the 2x2 photo.");
  }
  if (file.size > 2 * 1024 * 1024) throw new Error("The photo must be 2 MB or smaller.");
  const objectUrl = URL.createObjectURL(file);
  try {
    const dimensions = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error("This image could not be opened. Choose another photo."));
      image.src = objectUrl;
    });
    if (Math.abs(dimensions.width / dimensions.height - 1) > 0.1) {
      throw new Error("Upload a square, 2x2-style photo. Crop the image to a square and try again.");
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  return file;
}

function savePortalUser(user, form) {
  try {
    sessionStorage.setItem("lw-user", JSON.stringify(user));
  } catch (error) {
    console.error("Unable to start a portal session.", error);
    setSuccess(form, "Your browser could not start a session. Please enable session storage and try again.", true);
    return false;
  }
  return true;
}

function goToPortal(role) {
  window.location.href = role === "student" ? "dashboard.html#student" : "dashboard.html";
}

async function registerAccount(data, form) {
  const email = String(data.get("email")).trim().toLowerCase();
  const name = String(data.get("name")).trim();
  const password = String(data.get("password"));
  const photo = selectedRole === "student" ? await validateSquarePhoto(data.get("photo")) : null;
  const options = { data: { role: selectedRole, name } };
  const { data: authData, error } = await supabase.auth.signUp({ email, password, options });
  if (error) throw error;
  if (!authData.user) throw new Error("Supabase did not return the new account. Please try again.");
  if (!authData.session) {
    if (authData.user.identities?.length === 0) {
      throw new Error("An account with this email already exists. Log in with that account instead.");
    }
    throw new Error("Supabase created the account but did not sign it in, so the student profile and photo were not submitted for approval. For this school demo, the administrator must disable email confirmation in Supabase before student registration can finish.");
  }

  const portalUser = { role: selectedRole, name, studentId: "" };
  if (selectedRole === "student") {
    const studentCode = String(data.get("studentId")).trim();
    const studentId = crypto.randomUUID();
    const extension = photo.type === "image/png" ? "png" : photo.type === "image/webp" ? "webp" : "jpg";
    const photoPath = `${studentId}/${crypto.randomUUID()}.${extension}`;
    try {
      const { error: insertError } = await supabase.from("students").insert({
        id: studentId,
        profile_id: authData.user.id,
        student_code: studentCode,
        display_name: name,
        photo_path: photoPath,
        approval_status: "pending",
      });
      if (insertError) throw insertError;

      const { error: uploadError } = await supabase.storage
        .from("student-photos")
        .upload(photoPath, photo, { contentType: photo.type, upsert: false });
      if (uploadError) throw uploadError;
    } catch (registrationError) {
      const { error: photoCleanupError } = await supabase.storage
        .from("student-photos")
        .remove([photoPath]);
      if (photoCleanupError) console.error("Unable to clean up the incomplete student photo.", photoCleanupError);

      const { error: accountCleanupError } = await supabase.rpc("cancel_incomplete_student_registration");
      if (accountCleanupError) {
        console.error("Unable to clean up the incomplete student account.", accountCleanupError);
        const cleanupMessage = /cancel_incomplete_student_registration|PGRST202/i.test(String(accountCleanupError.message || ""))
          ? "The cleanup function is unavailable."
          : `The cleanup function also failed: ${accountCleanupError.message}.`;
        throw new Error(`Student registration failed: ${registrationError.message || "The student profile or photo could not be saved."} ${cleanupMessage} Ask your project administrator to apply supabase/migrations/20261106160000_student_registration_sync.sql in the SQL Editor for the project configured in supabase-config.js. The student portal will open after registration succeeds.`);
      }

      const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
      if (signOutError) console.error("Unable to clear the local session after registration cleanup.", signOutError);
      throw registrationError;
    }

    portalUser.studentId = studentId;
    portalUser.studentCode = studentCode;
    portalUser.studentStatus = "pending";
  }

  if (!savePortalUser(portalUser, form)) return;
  goToPortal(portalUser.role);
}

async function loginAccount(data, form) {
  const email = String(data.get("email")).trim().toLowerCase();
  const password = String(data.get("password"));
  const { data: authData, error: loginError } = await supabase.auth.signInWithPassword({ email, password });
  if (loginError) throw loginError;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, role, display_name")
    .eq("id", authData.user.id)
    .single();
  if (profileError) throw profileError;
  if (profile.role !== selectedRole) {
    await supabase.auth.signOut();
    throw new Error(`This account is registered as ${profile.role}. Choose the matching role from the home page.`);
  }

  const { error: historyError } = await supabase.rpc("record_portal_login");
  if (historyError) throw historyError;

  const portalUser = { role: profile.role, name: profile.display_name, studentId: "" };
  if (profile.role === "student") {
    const { data: student, error: studentError } = await supabase
      .from("students")
      .select("id, student_code, approval_status")
      .eq("profile_id", profile.id)
      .maybeSingle();
    if (studentError) throw studentError;
    if (student) {
      portalUser.studentId = student.id;
      portalUser.studentCode = student.student_code;
      portalUser.studentStatus = student.approval_status;
    }
  }

  if (!savePortalUser(portalUser, form)) return;
  goToPortal(portalUser.role);
}

async function submitAccount(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const notice = form.querySelector(".form-success");
  if (notice) notice.hidden = true;
  const submitButton = form.querySelector("#submit-label");
  submitButton.disabled = true;

  try {
    const data = new FormData(form);
    if (form.dataset.mode === "login") {
      await loginAccount(data, form);
    } else {
      await registerAccount(data, form);
    }
  } catch (error) {
    console.error("Online account operation failed.", error);
    setSuccess(form, getAccountErrorMessage(error), true);
  } finally {
    submitButton.disabled = false;
  }
}

showRoleForm();
document.querySelectorAll(".password-toggle").forEach((toggle) => {
  toggle.addEventListener("click", () => {
    const password = document.getElementById(toggle.getAttribute("aria-controls"));
    if (!password) return;
    const showPassword = password.type === "password";
    password.type = showPassword ? "text" : "password";
    toggle.setAttribute("aria-pressed", String(showPassword));
    toggle.setAttribute("aria-label", showPassword ? "Hide password" : "Show password");
  });
});
if (accountForm) {
  if (!supabase) {
    setSuccess(accountForm, "Online account storage is not configured. Add your Supabase project URL and publishable anon key to supabase-config.js, then apply supabase/schema.sql.", true);
    accountForm.querySelector("#submit-label").disabled = true;
  } else {
    accountForm.addEventListener("submit", submitAccount);
  }
}

const passwordRequestForm = document.querySelector("#password-request-form");
const passwordUpdateForm = document.querySelector("#password-update-form");

function showPasswordUpdateForm() {
  if (!passwordRequestForm || !passwordUpdateForm) return;
  document.querySelector("#password-request-panel").hidden = true;
  document.querySelector("#password-update-panel").hidden = false;
}

if (passwordRequestForm && passwordUpdateForm) {
  const showRecoveryFormFromHash = () => {
    const recoveryType = new URLSearchParams(window.location.hash.slice(1)).get("type");
    if (recoveryType === "recovery") showPasswordUpdateForm();
  };
  showRecoveryFormFromHash();
  window.addEventListener("hashchange", showRecoveryFormFromHash);

  if (supabase) {
    supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") showPasswordUpdateForm();
    });

    passwordRequestForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!passwordRequestForm.reportValidity()) return;
      const notice = passwordRequestForm.querySelector(".form-success");
      if (notice) notice.hidden = true;
      const button = passwordRequestForm.querySelector(".submit-button");
      button.disabled = true;

      try {
        const email = String(new FormData(passwordRequestForm).get("email")).trim().toLowerCase();
        const redirectTo = new URL("forgot-password.html", window.location.href).href;
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
        setSuccess(passwordRequestForm, "If an account exists for that email, a password reset link has been sent.");
      } catch (error) {
        console.error("Unable to request a password reset.", error);
        setSuccess(passwordRequestForm, error.message || "We couldn't send a reset link. Please try again.", true);
      } finally {
        button.disabled = false;
      }
    });

    passwordUpdateForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!passwordUpdateForm.reportValidity()) return;
      const notice = passwordUpdateForm.querySelector(".form-success");
      if (notice) notice.hidden = true;
      const button = passwordUpdateForm.querySelector(".submit-button");
      button.disabled = true;

      try {
        const password = String(new FormData(passwordUpdateForm).get("password"));
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        passwordUpdateForm.reset();
        setSuccess(passwordUpdateForm, "Your password has been updated. You can now log in with your new password.");
      } catch (error) {
        console.error("Unable to update the account password.", error);
        setSuccess(passwordUpdateForm, error.message || "We couldn't update your password. Request a new reset link and try again.", true);
      } finally {
        button.disabled = false;
      }
    });
  } else {
    setSuccess(passwordRequestForm, "Online account storage is not configured. Add your Supabase project URL and publishable anon key to supabase-config.js.", true);
    passwordRequestForm.querySelector(".submit-button").disabled = true;
    passwordUpdateForm.querySelector(".submit-button").disabled = true;
  }
}

document.querySelectorAll("form.demo-form:not(#account-form):not(#password-request-form):not(#password-update-form)").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    setSuccess(form, "Your school details passed validation. This demo does not submit them to a school server.");
  });
});
