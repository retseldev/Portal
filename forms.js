import { supabase } from "./supabase-client.js";

const accountForm = document.querySelector("#account-form");
const search = new URLSearchParams(window.location.search);
const allowedRoles = ["teacher", "parent", "student"];
const selectedRole = allowedRoles.includes(search.get("role")) ? search.get("role") : "teacher";
function setSuccess(form, message, isError = false) {
  const notice = form.querySelector(".form-success");
  if (!notice) return;
  notice.textContent = message;
  notice.hidden = false;
  notice.classList.toggle("is-error", isError);
}

function setRequired(selector, required) {
  const input = document.querySelector(selector);
  if (input) input.required = required;
}

function showRoleForm() {
  if (!accountForm) return;
  const roleField = document.querySelector("#account-role");
  roleField.value = selectedRole;
  const isRegister = accountForm.dataset.mode === "register";
  const titles = {
    teacher: ["Teacher", "Create a teacher account with your school email."],
    parent: ["Parent", "Create an account and link your child’s student profile."],
    student: ["Student", "Create a student account and upload a profile photo."],
  };
  const [roleName, intro] = titles[selectedRole];
  document.querySelector("#form-title").textContent = isRegister ? `Register as ${roleName}` : `Log in as ${roleName}`;
  document.querySelector("#form-intro").textContent = isRegister ? intro : `Sign in to your ${roleName.toLowerCase()} portal.`;
  document.querySelector("#submit-label").textContent = isRegister ? `Register as ${roleName}` : `Log in as ${roleName}`;
  const studentFields = document.querySelector("#student-fields");
  const parentFields = document.querySelector("#parent-fields");
  if (studentFields) studentFields.hidden = !isRegister || selectedRole !== "student";
  if (parentFields) parentFields.hidden = !isRegister || selectedRole !== "parent";
  setRequired("#student-id", isRegister && selectedRole === "student");
  setRequired("#student-photo", isRegister && selectedRole === "student");
  setRequired("#child-name", isRegister && selectedRole === "parent");
  setRequired("#child-id", isRegister && selectedRole === "parent");
  setRequired("#child-link-code", isRegister && selectedRole === "parent");
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

async function registerAccount(data, form) {
  const email = String(data.get("email")).trim().toLowerCase();
  const name = String(data.get("name")).trim();
  const password = String(data.get("password"));
  const photo = selectedRole === "student" ? await validateSquarePhoto(data.get("photo")) : null;
  const childName = selectedRole === "parent" ? String(data.get("childName")).trim() : "";
  const options = { data: { role: selectedRole, name } };
  const { data: authData, error } = await supabase.auth.signUp({ email, password, options });
  if (error) throw error;
  if (!authData.user) throw new Error("Supabase did not return the new account. Please try again.");
  if (!authData.session) {
    throw new Error("Your account was created, but email confirmation is enabled, so student photo upload or parent linking could not finish. Ask the Supabase project administrator to remove this incomplete account, disable email confirmation for the school demo, then register again.");
  }

  const portalUser = { role: selectedRole, name, studentId: "", childId: "", linkCode: "" };
  if (selectedRole === "student") {
    const studentCode = String(data.get("studentId")).trim();
    const studentId = crypto.randomUUID();
    const extension = photo.type === "image/png" ? "png" : photo.type === "image/webp" ? "webp" : "jpg";
    const photoPath = `${studentId}/${crypto.randomUUID()}.${extension}`;
    const { error: insertError } = await supabase.from("students").insert({
      id: studentId,
      profile_id: authData.user.id,
      student_code: studentCode,
      display_name: name,
      photo_path: photoPath,
    });
    if (insertError) throw insertError;

    const { error: uploadError } = await supabase.storage
      .from("student-photos")
      .upload(photoPath, photo, { contentType: photo.type, upsert: false });
    if (uploadError) {
      const { error: cleanupError } = await supabase.from("students").delete().eq("id", studentId);
      if (cleanupError) {
        console.error("Unable to remove the incomplete student profile.", cleanupError);
      }
      throw uploadError;
    }

    const { data: linkCode, error: inviteError } = await supabase
      .rpc("create_parent_link_invite", { target_student_id: studentId });
    if (inviteError) throw inviteError;
    portalUser.studentId = studentId;
    portalUser.studentCode = studentCode;
    portalUser.linkCode = linkCode;
  } else if (selectedRole === "parent") {
    const studentCode = String(data.get("childId")).trim();
    const linkCode = String(data.get("childLinkCode")).trim().toLowerCase();
    const { data: childId, error: linkError } = await supabase
      .rpc("link_child_profile", {
        target_student_code: studentCode,
        target_student_name: childName,
        invite_code: linkCode,
      });
    if (linkError) throw linkError;
    portalUser.childId = childId;
  }

  if (!savePortalUser(portalUser, form)) return;
  window.location.href = "dashboard.html";
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

  const portalUser = { role: profile.role, name: profile.display_name, studentId: "", childId: "", linkCode: "" };
  if (profile.role === "student") {
    const { data: student, error: studentError } = await supabase
      .from("students")
      .select("id, student_code")
      .eq("profile_id", profile.id)
      .maybeSingle();
    if (studentError) throw studentError;
    if (student) {
      portalUser.studentId = student.id;
      portalUser.studentCode = student.student_code;
    }
  } else if (profile.role === "parent") {
    const { data: links, error: linksError } = await supabase
      .from("parent_student_links")
      .select("student_id")
      .eq("parent_id", profile.id)
      .limit(1);
    if (linksError) throw linksError;
    if (links?.length) portalUser.childId = links[0].student_id;
  }

  if (!savePortalUser(portalUser, form)) return;
  window.location.href = "dashboard.html";
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
    setSuccess(form, error.message || "The online account operation failed. Please try again.", true);
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

document.querySelectorAll("form.demo-form:not(#account-form)").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    setSuccess(form, "Your school details passed validation. This demo does not submit them to a school server.");
  });
});
