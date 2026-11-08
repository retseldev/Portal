import { supabase } from "./supabase-client.js";

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));
const load = (key, fallback) => {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    throw new Error("This browser could not save the portal data.");
  }
};

async function loadAuthenticatedProfile() {
  if (!supabase) {
    window.location.replace("login.html");
    return null;
  }
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) {
    console.error("Unable to verify the portal session.", sessionError);
    window.location.replace("login.html");
    return null;
  }
  if (!sessionData.session) {
    window.location.replace("login.html");
    return null;
  }
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, role, display_name, is_school_admin")
    .eq("id", sessionData.session.user.id)
    .single();
  if (profileError) {
    console.error("Unable to load the authenticated portal profile.", profileError);
    window.location.replace("login.html");
    return null;
  }
  return profile;
}

const profile = await loadAuthenticatedProfile();
if (profile) {

let savedUser = {};
try {
  savedUser = JSON.parse(sessionStorage.getItem("lw-user")) || {};
} catch (error) {
  console.error("Unable to read the portal session details.", error);
}
const user = { ...savedUser, role: profile.role, name: profile.display_name };
delete user.childId;
delete user.linkCode;
try {
  sessionStorage.setItem("lw-user", JSON.stringify(user));
} catch (error) {
  console.error("Unable to persist the portal session details.", error);
  window.location.replace("login.html");
  throw new Error("The portal could not store the authenticated session details.");
}

const validRoles = ["teacher", "parent", "student"];
const role = validRoles.includes(profile.role) ? profile.role : null;
if (!role) {
  await supabase.auth.signOut();
  window.location.replace("login.html");
  throw new Error("The authenticated account has an unsupported portal role.");
}

let studentProfileError = "";
let studentTeacherId = null;
if (role === "student") {
  try {
    const { data: student, error: studentError } = await supabase
      .from("students")
      .select("id, student_code, approval_status, teacher_id")
      .eq("profile_id", profile.id)
      .maybeSingle();
    if (studentError) throw studentError;
    if (!student) throw new Error("No student registration is associated with this account.");
    user.studentId = student.id;
    user.studentCode = student.student_code;
    user.studentStatus = student.approval_status;
    studentTeacherId = student.teacher_id;
    try {
      sessionStorage.setItem("lw-user", JSON.stringify(user));
    } catch (error) {
      console.error("Unable to refresh the student portal details.", error);
    }
  } catch (error) {
    console.error("Unable to refresh the student registration status.", error);
    studentProfileError = "Your student approval status could not be checked. Refresh or contact your school.";
  }
}

const profiles = load("lw-students", []);
let students = profiles.filter((profile) => profile && profile.id && profile.name);
let studentLoadError = "";
let pendingStudents = [];
let approvalLoadError = "";
async function refreshAssignedStudents() {
  if (role !== "teacher") return;
  try {
    const { data: assignedStudents, error: studentsError } = await supabase
      .from("students")
      .select("id, student_code, display_name, photo_path, academic_standing, teacher_feedback")
      .eq("teacher_id", profile.id)
      .eq("approval_status", "approved")
      .order("display_name");
    if (studentsError) throw studentsError;

    students = await Promise.all((assignedStudents || []).map(async (student) => {
      const { data: photo, error: photoError } = await supabase
        .storage
        .from("student-photos")
        .createSignedUrl(student.photo_path, 3600);
      if (photoError) throw photoError;
      return {
        id: student.id,
        studentCode: student.student_code,
        name: student.display_name,
        photo: photo.signedUrl,
        standing: student.academic_standing,
        feedback: student.teacher_feedback,
      };
    }));
    studentLoadError = "";
  } catch (error) {
    console.error("Unable to load assigned student profiles.", error);
    students = [];
    studentLoadError = "Student profiles could not be loaded from Supabase. Please refresh or contact your school administrator.";
  }
}
if (role === "teacher") await refreshAssignedStudents();
const labels = { present: "Present", late: "Late", absent: "Absent" };
const navItems = {
  teacher: [
    ["teacher-home", "Dashboard"], ["advising", "Advising"], ["attendance", "Attendance"],
    ["events", "Events"], ["admin", "Admin tools"],
  ],
  parent: [["parent", "Guardian"], ["events", "School events"]],
  student: [
    ["student", "My portal"], ["advising", "Advising"], ["tutors", "Tutors"],
    ["study-sessions", "Study sessions"], ["events", "Events"],
  ],
};
const nav = $("#nav");
nav.innerHTML = navItems[role].map(([id, label]) => `
  <a href="#${id}" data-view="${id}"><span>${esc(label)}</span></a>
`).join("");

let currentStudentId = role === "parent" ? null : user.studentId;
const events = load("lw-school-posts", []);
let requests = [];
let attendance = {};
let advisingLoadError = "";
let attendanceLoadError = "";

const helpAssistant = $("#help-assistant");
if (helpAssistant && (role === "parent" || role === "student")) {
  helpAssistant.hidden = false;
  const chatLog = $("#help-chat-log");
  const chatForm = $("#help-chat-form");
  const chatInput = $("#help-chat-input");

  function answerHelpQuestion(question) {
    const text = question.toLowerCase();
    if (/tutor|tutoring/.test(text)) {
      return "Ask your teacher or school office which tutors are available for your subject. Tutor listings and bookings are not connected to this demo portal yet.";
    }
    if (/study|session|homework|assignment/.test(text)) {
      return "Choose one subject or assignment, focus for 25 minutes, take a 5-minute break, then review what you finished.";
    }
    if (/register|registration|sign up|link code|connect.*student/.test(text)) {
      return role === "parent"
        ? "Parents can register with their name, email, and password. No child link code or student connection is needed."
        : "After student registration succeeds, you are taken directly to the Student Portal. Your registration may still need school approval.";
    }
    if (/attendance|absent|present|late/.test(text)) {
      return role === "parent"
        ? "Your child's attendance would appear in the Guardian portal when a student profile is connected. Parent-child linking is unavailable in this demo."
        : "Open My portal to view your attendance timeline.";
    }
    if (/advis(e|ing)|appointment|teacher/.test(text)) {
      return role === "student"
        ? "You can request academic advising after your registration is approved and a teacher is assigned."
        : "For tutoring or school concerns, contact your child's teacher or the school office.";
    }
    if (/event|calendar|announcement/.test(text)) {
      return "Open School events (or Events in the student portal) to see school calendar updates.";
    }
    return "I can help with registration, tutoring, study sessions, attendance, advising, and school events. Try asking about one of those topics.";
  }

  function addHelpMessage(speaker, message) {
    const item = document.createElement("p");
    item.className = "help-message";
    item.textContent = `${speaker}: ${message}`;
    chatLog.append(item);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!chatForm.reportValidity()) return;
    const question = chatInput.value.trim();
    if (!question) return;
    addHelpMessage("You", question);
    addHelpMessage("PLES Help", answerHelpQuestion(question));
    chatForm.reset();
    chatInput.focus();
  });

  document.querySelectorAll(".help-prompt-button").forEach((button) => {
    button.addEventListener("click", () => {
      const question = button.dataset.helpPrompt;
      addHelpMessage("You", question);
      addHelpMessage("PLES Help", answerHelpQuestion(question));
      helpAssistant.scrollIntoView({ behavior: "smooth", block: "nearest" });
      chatInput.focus();
    });
  });
}

function initials(name) {
  return String(name || "").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

function photoMarkup(student, className = "student-photo") {
  if (!student.photo) return `<span class="${className} photo-placeholder" aria-label="No photo uploaded">${esc(initials(student.name))}</span>`;
  return `<img class="${className}" src="${esc(student.photo)}" alt="${esc(student.name)}" />`;
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function eventMarkup(post, canRemove = false) {
  const date = post.date ? new Date(`${post.date}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "";
  return `<article class="event-card"><span class="event-type">${esc(post.type === "announcement" ? "Announcement" : "School event")}</span><strong>${esc(post.title)}</strong>${date ? `<time datetime="${esc(post.date)}">${esc(date)}</time>` : ""}<p>${esc(post.details)}</p>${canRemove ? `<button class="link-btn" type="button" data-delete-post="${esc(post.id)}">Remove post</button>` : ""}</article>`;
}

function renderEvents() {
  const markup = events.length
    ? [...events].sort((a, b) => String(a.date || "").localeCompare(String(b.date || ""))).map(eventMarkup).join("")
    : `<p class="empty-state">No events or announcements have been posted.</p>`;
  ["#teacher-events", "#parent-events", "#calendar-events", "#admin-events"].forEach((selector) => {
    const target = $(selector);
    if (target) target.innerHTML = selector === "#admin-events" && role === "teacher" && events.length
      ? [...events].sort((a, b) => String(a.date || "").localeCompare(String(b.date || ""))).map((post) => eventMarkup(post, true)).join("")
      : markup;
  });
}

function renderConnectedStudents() {
  const target = $("#teacher-students");
  if (studentLoadError) {
    target.innerHTML = `<p class="empty-state">${esc(studentLoadError)}</p>`;
    return;
  }
  if (!students.length) {
    target.innerHTML = `<p class="empty-state">No student profiles are assigned to your account yet. Ask your school administrator to assign registered students to you.</p>`;
    return;
  }
  target.innerHTML = students.map((student) => `
    <article class="card student-card">${photoMarkup(student)}
      <div class="student-card-content"><h3>${esc(student.name)}</h3><span class="student-tag">Student ID · ${esc(student.studentCode)}</span>
        <form class="student-update-form" data-profile="${esc(student.id)}">
          <label>Academic standing<input name="standing" value="${esc(student.standing || "")}" placeholder="e.g. On track" /></label>
          <label>Teacher feedback<textarea name="feedback" rows="2" placeholder="Add a note to this student’s profile">${esc(student.feedback || "")}</textarea></label>
          <button class="link-btn" type="submit">Save student updates</button>
          <p class="form-feedback" role="status" hidden></p>
        </form>
      </div>
    </article>
  `).join("");
}

function renderPendingApprovals() {
  const target = $("#pending-student-approvals");
  if (!target || role !== "teacher") return;
  if (approvalLoadError) {
    target.innerHTML = `<p class="empty-state">${esc(approvalLoadError)}</p>`;
    return;
  }
  if (!pendingStudents.length) {
    target.innerHTML = `<p class="empty-state">No pending or unassigned student registrations are visible. Verify that the configured Supabase project includes the latest teacher approval updates, then refresh.</p>`;
    return;
  }
  target.innerHTML = pendingStudents.map((student) => `
    <article class="approval-card" data-approval="${esc(student.id)}">
      ${photoMarkup(student, "approval-photo")}
      <div class="approval-content">
        <h4>${esc(student.display_name)}</h4>
        <p><strong>Status:</strong> ${student.approval_status === "pending" ? "Pending approval" : "Approved · awaiting teacher assignment"}</p>
        <p>Student ID · ${esc(student.student_code)} · Registered ${esc(new Date(student.created_at).toLocaleDateString())}</p>
        <form class="approval-actions" data-student="${esc(student.id)}">
          <button class="btn" type="submit">${student.approval_status === "pending" ? "Approve and add to my students" : "Add to my students"}</button>
          ${profile.is_school_admin && student.approval_status === "pending" ? `<button class="btn btn-danger" type="button" data-reject-student="${esc(student.id)}">Reject</button>` : ""}
          <p class="form-feedback" role="status" hidden></p>
        </form>
      </div>
    </article>
  `).join("");
}

function renderTeacherPendingStudents() {
  const target = $("#teacher-pending-students");
  if (!target || role !== "teacher") return;
  if (approvalLoadError) {
    target.innerHTML = `<p class="empty-state">${esc(approvalLoadError)}</p>`;
    return;
  }
  if (!pendingStudents.length) {
    target.innerHTML = `<p class="empty-state">No pending or unassigned student registrations are visible. Verify that the configured Supabase project includes the latest teacher approval updates, then refresh.</p>`;
    return;
  }
  target.innerHTML = pendingStudents.map((student) => `
    <article class="card student-card pending-registration-card">
      ${photoMarkup(student)}
      <div class="student-card-content">
        <h3>${esc(student.display_name)}</h3>
        <span class="student-tag">Student ID · ${esc(student.student_code)}</span>
        <p class="pending-registration-status">${student.approval_status === "pending" ? "Pending approval" : "Approved · awaiting teacher assignment"} · Registered ${esc(new Date(student.created_at).toLocaleDateString())}</p>
      </div>
    </article>
  `).join("");
}

async function refreshAdvisingRequests() {
  advisingLoadError = "";
  try {
    let query = supabase
      .from("advising_requests")
      .select("id, student_id, requester_id, requested_at, message, status, reviewed_by")
      .order("requested_at", { ascending: false });
    if (role === "teacher") {
      if (!students.length) {
        requests = [];
        return;
      }
      query = query.in("student_id", students.map((student) => student.id));
    } else if (role === "student" && currentStudentId) {
      query = query.eq("student_id", currentStudentId).eq("requester_id", profile.id);
    } else {
      requests = [];
      return;
    }

    const { data, error } = await query;
    if (error) throw error;
    requests = (data || []).map((request) => ({
      id: request.id,
      studentId: request.student_id,
      message: request.message,
      when: new Date(request.requested_at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      status: request.status,
      reviewedBy: request.reviewed_by,
    }));
  } catch (error) {
    console.error("Unable to load academic advising requests.", error);
    requests = [];
    advisingLoadError = "Academic advising requests could not be loaded. Refresh or contact your school.";
  }
}

async function refreshAttendance() {
  attendanceLoadError = "";
  const semester = role === "teacher" ? $("#semester-filter").value : $("#student-semester-filter").value;
  try {
    let query = supabase
      .from("attendance")
      .select("student_id, attendance_date, semester, status")
      .eq("semester", Number(semester));
    if (role === "teacher") {
      if (!students.length) {
        attendance = {};
        return;
      }
      query = query.in("student_id", students.map((student) => student.id));
    } else if (role === "student" && currentStudentId) {
      query = query.eq("student_id", currentStudentId);
    } else {
      attendance = {};
      return;
    }

    const { data, error } = await query;
    if (error) throw error;
    attendance = { [semester]: {} };
    (data || []).forEach((row) => {
      const date = String(row.attendance_date).slice(0, 10);
      attendance[semester][date] ||= {};
      attendance[semester][date][row.student_id] = row.status;
    });
  } catch (error) {
    console.error("Unable to load student attendance.", error);
    attendance = {};
    attendanceLoadError = "Attendance could not be loaded. Refresh or contact your school.";
  }
}

async function refreshPendingApprovals() {
  if (role !== "teacher") return;
  const refreshButton = $("#refresh-student-approvals");
  if (refreshButton) refreshButton.disabled = true;
  approvalLoadError = "";
  try {
    const { data: pendingRows, error: pendingError } = await supabase
      .from("students")
      .select("id, student_code, display_name, photo_path, created_at, approval_status")
      .or("approval_status.eq.pending,and(approval_status.eq.approved,teacher_id.is.null)")
      .order("created_at");
    if (pendingError) throw pendingError;
    pendingStudents = await Promise.all((pendingRows || []).map(async (student) => {
      const { data: photo, error: photoError } = await supabase
        .storage
        .from("student-photos")
        .createSignedUrl(student.photo_path, 3600);
      if (photoError) console.error("Unable to load a pending student's photo.", photoError);
      return {
        ...student,
        name: student.display_name,
        photo: photoError ? "" : photo?.signedUrl || "",
      };
    }));
  } catch (error) {
    console.error("Unable to refresh pending student approvals.", error);
    pendingStudents = [];
    approvalLoadError = "Pending student registrations could not be loaded. Check the Supabase setup or try again.";
  } finally {
    if (refreshButton) refreshButton.disabled = false;
  }
  renderPendingApprovals();
  renderTeacherPendingStudents();
  if (role === "teacher") renderAttendance();
}

$("#refresh-student-approvals")?.addEventListener("click", refreshPendingApprovals);

function startStudentApprovalSync() {
  if (role !== "teacher") return;
  let refreshTimer;
  const channel = supabase
    .channel(`student-approvals-${profile.id}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "students",
    }, () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshPendingApprovals();
      }, 750);
    })
    .subscribe((status, error) => {
      if (status === "SUBSCRIBED") {
        console.info("Live student registration updates are connected.");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error("Live student registration updates are unavailable.", error);
      }
    });

  const pollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") refreshPendingApprovals();
  }, 30000);

  window.addEventListener("pagehide", () => {
    window.clearTimeout(refreshTimer);
    window.clearInterval(pollTimer);
    supabase.removeChannel(channel);
  }, { once: true });
}

$("#pending-student-approvals")?.addEventListener("submit", async (event) => {
  const form = event.target.closest(".approval-actions");
  if (!form || role !== "teacher") return;
  event.preventDefault();
  const studentId = form.dataset.student;
  const button = form.querySelector('button[type="submit"]');
  const feedback = form.querySelector('[role="status"]');
  button.disabled = true;
  try {
    const { error } = await supabase.rpc("approve_student_registration", {
      target_student_id: studentId,
    });
    if (error) throw error;
    window.location.reload();
  } catch (error) {
    console.error("Unable to approve student registration.", error);
    feedback.textContent = "Could not approve this registration. Please try again.";
    feedback.hidden = false;
    button.disabled = false;
  }
});

$("#pending-student-approvals")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-reject-student]");
  if (!button || !profile.is_school_admin) return;
  const student = pendingStudents.find((item) => item.id === button.dataset.rejectStudent);
  if (!student) return;
  if (!window.confirm(`Permanently delete ${student.display_name}'s student registration, photo, account, and related student records? This cannot be undone.`)) return;
  const card = button.closest(".approval-card");
  const feedback = card.querySelector('[role="status"]');
  button.disabled = true;
  try {
    const { error: photoError } = await supabase
      .storage
      .from("student-photos")
      .remove([student.photo_path]);
    if (photoError) throw photoError;
    const { error } = await supabase.rpc("reject_student_registration", {
      target_student_id: button.dataset.rejectStudent,
    });
    if (error) throw error;
    pendingStudents = pendingStudents.filter((student) => student.id !== button.dataset.rejectStudent);
    renderPendingApprovals();
  } catch (error) {
    console.error("Unable to reject student registration.", error);
    feedback.textContent = "Could not finish deleting this registration. If the photo was removed, retry the decline action or contact your administrator.";
    feedback.hidden = false;
    button.disabled = false;
  }
});

$("#teacher-students").addEventListener("submit", async (event) => {
  const form = event.target.closest(".student-update-form");
  if (!form || role !== "teacher") return;
  event.preventDefault();
  const student = students.find((item) => item.id === form.dataset.profile);
  if (!student) return;
  const data = new FormData(form);
  const standing = String(data.get("standing")).trim();
  const feedback = String(data.get("feedback")).trim();
  const submitButton = form.querySelector('button[type="submit"]');
  const status = form.querySelector('[role="status"]');
  submitButton.disabled = true;
  status.hidden = true;
  let saveError;
  try {
    const { data: updated, error } = await supabase
      .from("students")
      .update({ academic_standing: standing || null, teacher_feedback: feedback || null })
      .eq("id", student.id)
      .eq("teacher_id", profile.id)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      status.textContent = "This student is no longer assigned to your account.";
      status.hidden = false;
      return;
    }
  } catch (error) {
    console.error("Unable to save student updates.", error);
    saveError = error;
  } finally {
    submitButton.disabled = false;
  }
  if (saveError) {
    status.textContent = "Could not save your update. Please try again.";
    status.hidden = false;
    return;
  }
  student.standing = standing;
  student.feedback = feedback;
  status.textContent = "Update saved.";
  status.hidden = false;
});

function renderAdvising() {
  const target = $("#advising-requests");
  if (role === "teacher") {
    if (advisingLoadError) {
      target.innerHTML = `<li class="empty">${esc(advisingLoadError)}</li>`;
      $("#pending-count").textContent = "Requests unavailable";
      return;
    }
    const ownRequests = requests.filter((request) => {
      const requestStudent = students.find((student) => student.id === request.studentId);
      return requestStudent;
    });
    target.innerHTML = ownRequests.length ? ownRequests.map((request) => {
      const student = students.find((item) => item.id === request.studentId);
      return `<li><div><strong>${esc(student.name)}</strong><span>${esc(request.message)}</span><span>${esc(request.when)}</span></div><div class="request-actions"><span class="pill ${esc(request.status)}">${esc(request.status)}</span>${request.status === "Pending" ? `<button class="btn" type="button" data-accept="${esc(request.id)}">Accept</button><button class="link-btn" type="button" data-decline="${esc(request.id)}">Decline</button>` : ""}</div></li>`;
    }).join("") : `<li class="empty">No academic advising requests yet.</li>`;
  } else {
    const mine = requests.filter((request) => request.studentId === currentStudentId);
    target.innerHTML = advisingLoadError
      ? `<li class="empty">${esc(advisingLoadError)}</li>`
      : mine.length
      ? mine.map((request) => `<li><div><strong>Academic advising</strong><span>${esc(request.message)}</span><span>${esc(request.when)}</span></div><span class="pill ${esc(request.status)}">${esc(request.status)}</span></li>`).join("")
      : `<li class="empty">No advising requests yet. You can request an appointment with your assigned teacher.</li>`;
  }
  const pending = requests.filter((request) => request.status === "Pending").length;
  const count = $("#pending-count");
  if (count) count.textContent = `${pending} request${pending === 1 ? "" : "s"} to review`;
}

$("#advising-requests").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-accept], [data-decline]");
  if (!button || role !== "teacher") return;
  const id = button.dataset.accept || button.dataset.decline;
  const request = requests.find((item) => item.id === id);
  if (!request) return;
  button.disabled = true;
  try {
    const status = button.dataset.accept ? "Accepted" : "Declined";
    const { data: updated, error } = await supabase
      .from("advising_requests")
      .update({ status, reviewed_by: profile.id })
      .eq("id", request.id)
      .eq("status", "Pending")
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!updated) throw new Error("The advising request is no longer pending or assigned to this teacher.");
    request.status = status;
    request.reviewedBy = profile.id;
    renderAdvising();
    renderNotifications();
  } catch (error) {
    console.error("Unable to update the advising request.", error);
    button.disabled = false;
    window.alert("Could not update this advising request. Please refresh and try again.");
  }
});

function studentAttendance(semester, studentId) {
  const records = attendance[semester] || {};
  const dates = Object.keys(records).sort().reverse();
  for (const date of dates) {
    const status = records[date]?.[studentId];
    if (status) return { status, date };
  }
  return null;
}

function startPortalDataSync() {
  const refresh = async (table) => {
    if (table === "students" && role === "teacher") {
      await refreshAssignedStudents();
      await Promise.all([refreshAdvisingRequests(), refreshAttendance()]);
    }
    if (table === "advising_requests") await refreshAdvisingRequests();
    if (table === "attendance") await refreshAttendance();
    if (role === "teacher") renderConnectedStudents();
    renderAdvising();
    if (role === "teacher") renderAttendance();
    if (role === "student") renderStudent();
    renderNotifications();
  };
  let refreshTimer;
  const channel = supabase
    .channel(`portal-data-${profile.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "advising_requests" }, () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => refresh("advising_requests"), 300);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "attendance" }, () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => refresh("attendance"), 300);
    });
  if (role === "teacher") {
    channel.on("postgres_changes", { event: "*", schema: "public", table: "students" }, () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => refresh("students"), 300);
    });
  }
  channel.subscribe((status, error) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      console.error("Live portal updates are unavailable.", error);
    }
  });
  const pollTimer = window.setInterval(async () => {
    if (document.visibilityState !== "visible") return;
    if (role === "teacher") await refreshAssignedStudents();
    await Promise.all([refreshAdvisingRequests(), refreshAttendance()]);
    if (role === "teacher") renderConnectedStudents();
    renderAdvising();
    if (role === "teacher") renderAttendance();
    if (role === "student") renderStudent();
    renderNotifications();
  }, 30000);
  window.addEventListener("pagehide", () => {
    window.clearTimeout(refreshTimer);
    window.clearInterval(pollTimer);
    supabase.removeChannel(channel);
  }, { once: true });
}

function renderAttendance() {
  if (attendanceLoadError) {
    $("#summary").textContent = attendanceLoadError;
    $("#roster").innerHTML = `<li class="empty">${esc(attendanceLoadError)}</li>`;
    return;
  }
  const semester = $("#semester-filter").value;
  const today = localDateKey();
  const records = attendance[semester] || {};
  const todaysRecords = records[today] || {};
  const counts = { present: 0, late: 0, absent: 0, unmarked: 0 };
  students.forEach((student) => {
    const status = todaysRecords[student.id];
    if (!status) counts.unmarked += 1;
    else counts[status] += 1;
  });
  $("#summary").textContent = `${counts.present} present · ${counts.late} late · ${counts.absent} absent · ${counts.unmarked} not marked today`;
  const assignedRoster = students.map((student) => {
    const entry = studentAttendance(semester, student.id);
    return `<li><div class="roster-person">${photoMarkup(student, "roster-photo")}<div><strong>${esc(student.name)}</strong><span>${entry ? `${esc(labels[entry.status])} · ${esc(entry.date)}` : "No attendance recorded this semester"}</span></div></div><div class="choices" role="group" aria-label="Attendance for ${esc(student.name)}">${Object.entries(labels).map(([status, label]) => `<button data-attendance="${esc(status)}" data-student="${esc(student.id)}" aria-pressed="${entry?.date === today && entry.status === status}" type="button">${label}</button>`).join("")}</div></li>`;
  });
  const pendingRoster = role === "teacher"
    ? pendingStudents.map((student) => `
      <li class="pending-attendance-row">
        <div class="roster-person">${photoMarkup(student, "roster-photo")}<div><strong>${esc(student.display_name)}</strong><span>${student.approval_status === "pending" ? "Registered · pending approval and teacher assignment" : "Approved · awaiting teacher assignment"}</span></div></div>
        <span class="pill pending">Not available for attendance</span>
      </li>
    `)
    : [];
  $("#roster").innerHTML = assignedRoster.length || pendingRoster.length
    ? [...assignedRoster, ...pendingRoster].join("")
    : `<li class="empty">No student profiles are connected yet.</li>`;
}

$("#roster").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-attendance]");
  if (!button || role !== "teacher") return;
  const semester = $("#semester-filter").value;
  const student = students.find((item) => item.id === button.dataset.student);
  if (!student) return;
  const date = localDateKey();
  button.disabled = true;
  try {
    const { error } = await supabase.from("attendance").upsert({
      student_id: student.id,
      marked_by: profile.id,
      attendance_date: date,
      semester: Number(semester),
      status: button.dataset.attendance,
    }, { onConflict: "student_id,attendance_date" });
    if (error) throw error;
    await refreshAttendance();
    $("#attendance-feedback").textContent = "";
    renderAttendance();
    renderStudent();
  } catch (error) {
    console.error("Unable to save student attendance.", error);
    $("#attendance-feedback").textContent = "Could not save attendance. Please refresh and try again.";
  } finally {
    button.disabled = false;
  }
});
$("#semester-filter").addEventListener("change", async () => {
  await refreshAttendance();
  renderAttendance();
});
$("#student-semester-filter").addEventListener("change", async () => {
  await refreshAttendance();
  renderStudent();
});

function renderParent() {
  $("#parent-child").innerHTML = `<div class="unlinked-state"><span class="quick-icon">♡</span><h3>Parent portal</h3><p>Parent-child profile linking is currently unavailable. Contact your school for student information.</p></div>`;
  $("#parent-attendance").textContent = "Student attendance is unavailable in this parent portal.";
  $("#week").innerHTML = `<li class="empty">No child attendance to display.</li>`;
  $("#academic-standing").textContent = "No academic record is available.";
  $("#teacher-feedback").textContent = "Teacher feedback is unavailable.";
  $("#parent-events").innerHTML = `<p class="empty-state">Student-specific events are unavailable in this parent portal.</p>`;
}

function renderStudent() {
  const semester = $("#student-semester-filter")?.value || "1";
  const entry = currentStudentId
    ? studentAttendance(semester, currentStudentId)
    : null;
  const text = attendanceLoadError
    ? attendanceLoadError
    : entry
    ? `Your attendance was marked ${labels[entry.status]?.toLowerCase() || entry.status} on ${entry.date}.`
    : "No attendance has been recorded for this semester yet.";
  const target = $("#student-attendance");
  if (target) target.textContent = text;
}

document.querySelectorAll("#parent-advising-form, #student-advising-form").forEach((form) => {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (role !== "student" || !currentStudentId || user.studentStatus !== "approved" || !studentTeacherId) return;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const button = form.querySelector('button[type="submit"]');
    const feedback = form.querySelector('[role="status"]');
    button.disabled = true;
    feedback.hidden = true;
    try {
      const { data: inserted, error } = await supabase
        .from("advising_requests")
        .insert({
          student_id: currentStudentId,
          requester_id: profile.id,
          requested_at: new Date(`${data.get("date")}T${data.get("time")}`).toISOString(),
          message: String(data.get("message")).trim(),
        })
        .select("id, student_id, requester_id, requested_at, message, status, reviewed_by")
        .single();
      if (error) throw error;
      requests.unshift({
        id: inserted.id,
        studentId: inserted.student_id,
        message: inserted.message,
        when: new Date(inserted.requested_at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
        status: inserted.status,
        reviewedBy: inserted.reviewed_by,
      });
      form.reset();
      feedback.textContent = "Your appointment request was sent to your teacher.";
      feedback.hidden = false;
      renderAdvising();
      renderNotifications();
    } catch (error) {
      console.error("Unable to submit the academic advising request.", error);
      feedback.textContent = "Could not send your appointment request. Please refresh and try again.";
      feedback.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
});

$("#event-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (role !== "teacher") return;
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  events.push({
    id: crypto.randomUUID(),
    type: String(data.get("type")),
    title: String(data.get("title")).trim(),
    date: String(data.get("date") || ""),
    details: String(data.get("details")).trim(),
  });
  save("lw-school-posts", events);
  form.reset();
  renderEvents();
  renderNotifications();
});

$("#admin-events").addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-post]");
  if (!button || role !== "teacher") return;
  const index = events.findIndex((post) => post.id === button.dataset.deletePost);
  if (index < 0) return;
  events.splice(index, 1);
  save("lw-school-posts", events);
  renderEvents();
  renderNotifications();
});

function renderNotifications() {
  const visibleRequests = role === "teacher"
    ? requests.filter((request) => request.status === "Pending")
    : requests.filter((request) => request.studentId === currentStudentId);
  const visibleEvents = role === "teacher"
    ? events
    : events.filter((post) => !post.studentId || post.studentId === currentStudentId);
  const notifications = [
    ...visibleRequests.map((request) => ({ title: "Advising request", detail: `${request.status} · ${request.when}` })),
    ...visibleEvents.slice(-3).map((post) => ({ title: post.title, detail: post.type === "announcement" ? "School announcement" : "Upcoming school event" })),
  ];
  $("#notification-count").textContent = notifications.length ? String(notifications.length) : "";
  $("#notification-count").hidden = !notifications.length;
  $("#notification-list").innerHTML = notifications.length
    ? notifications.map((item) => `<article class="notification-item"><strong>${esc(item.title)}</strong><span>${esc(item.detail)}</span></article>`).join("")
    : `<p class="empty-state">You’re all caught up.</p>`;
}

$("#notification-button").addEventListener("click", () => {
  const panel = $("#notification-panel");
  panel.hidden = !panel.hidden;
  $("#notification-button").setAttribute("aria-expanded", String(!panel.hidden));
});
$("#close-notifications").addEventListener("click", () => {
  $("#notification-panel").hidden = true;
  $("#notification-button").setAttribute("aria-expanded", "false");
});

function showView() {
  const ids = navItems[role].map(([id]) => id);
  let id = location.hash.slice(1);
  if (!ids.includes(id)) id = navItems[role][0][0];
  document.querySelectorAll(".view").forEach((view) => { view.hidden = view.id !== id; });
  nav.querySelectorAll("a").forEach((link) => {
    if (link.dataset.view === id) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (id === "admin" && role !== "teacher") window.location.hash = navItems[role][0][0];
  if (id === "attendance") renderAttendance();
}
window.addEventListener("hashchange", showView);

document.querySelectorAll(".logout-link").forEach((link) => link.addEventListener("click", async (event) => {
  event.preventDefault();
  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error("Unable to sign out of the portal.", error);
    window.alert("You could not be signed out. Please try again.");
    return;
  }
  sessionStorage.removeItem("lw-user");
  window.location.href = "index.html";
}));

const hour = new Date().getHours();
const firstName = String(user.name || "").trim().split(/\s+/)[0];
$("#hello").textContent = `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}${firstName ? `, ${firstName}` : ""}`;
$("#today").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
$("#role-label").textContent = role === "parent" ? "Parent portal" : role === "student" ? "Student portal" : "Teacher workspace";
await Promise.all([refreshAdvisingRequests(), refreshAttendance()]);
if (role === "teacher") {
  renderConnectedStudents();
  renderAttendance();
  startPortalDataSync();
  $("#admin-entry").hidden = false;
  $("#student-approvals-panel").hidden = false;
  $("#teacher-registrations-panel").hidden = false;
  $("#attendance-registration-note").hidden = false;
  startStudentApprovalSync();
  await refreshPendingApprovals();
}
if (role === "parent") {
  $("#parent-advising-form").closest(".panel").hidden = true;
}
if (role === "student") {
  const canRequestAdvising = Boolean(currentStudentId && studentTeacherId && user.studentStatus === "approved");
  $("#student-advising-form").hidden = !canRequestAdvising;
  $("#student-advising-status").hidden = canRequestAdvising;
  if (!canRequestAdvising) {
    $("#student-advising-status").textContent = "Appointment requests are available after your registration is approved and a teacher is assigned.";
  }
  startPortalDataSync();
  $("#student-registration-panel").hidden = !user.studentCode;
  if (user.studentCode) $("#student-school-id").textContent = user.studentCode;
  const isApproved = user.studentStatus === "approved";
  $("#student-approval-status").textContent = studentProfileError
    ? studentProfileError
    : isApproved
      ? "Your registration is approved. Your teacher can now see your profile."
      : user.studentStatus === "rejected"
        ? "Your registration was not approved. Please contact your school."
        : "Your registration is waiting for school approval.";
}
renderAdvising();
renderParent();
renderStudent();
renderEvents();
renderNotifications();
showView();
}
