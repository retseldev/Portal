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
    .select("id, role, display_name")
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

const profiles = load("lw-students", []);
const students = profiles.filter((profile) => profile && profile.id && profile.name);
let linkedStudent = role === "parent"
  ? students.find((student) => student.id === user.childId)
  : null;
const labels = { present: "Present", late: "Late", absent: "Absent" };
const navItems = {
  teacher: [
    ["teacher-home", "Dashboard"], ["advising", "Advising"], ["attendance", "Attendance"],
    ["events", "Events"],
    ["admin", "Admin tools"],
  ],
  parent: [["parent", "Guardian Stays"], ["events", "School events"]],
  student: [["student", "My portal"], ["advising", "Advising"], ["events", "Events"]],
};
const nav = $("#nav");
nav.innerHTML = navItems[role].map(([id, label]) => `
  <a href="#${id}" data-view="${id}"><span>${esc(label)}</span></a>
`).join("");

let currentStudentId = role === "parent" ? linkedStudent?.id : user.studentId;
const events = load("lw-school-posts", []);
const requests = load("lw-advising-requests", []);
const attendance = load("lw-attendance", {});

function initials(name) {
  return String(name || "").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

function photoMarkup(student, className = "student-photo") {
  if (!student.photo) return `<span class="${className} photo-placeholder" aria-label="No photo uploaded">${esc(initials(student.name))}</span>`;
  return `<img class="${className}" src="${esc(student.photo)}" alt="${esc(student.name)}" />`;
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
  if (!students.length) {
    target.innerHTML = `<p class="empty-state">No student profiles are connected yet. Student registrations with a 2x2 photo will appear here.</p>`;
    return;
  }
  target.innerHTML = students.map((student) => `
    <article class="card student-card">${photoMarkup(student)}
      <div class="student-card-content"><h3>${esc(student.name)}</h3><span class="student-tag">Connected learner · ${esc(student.id)}</span>
        <form class="student-update-form" data-profile="${esc(student.id)}">
          <label>Academic standing<input name="standing" value="${esc(student.standing || "")}" placeholder="e.g. On track" /></label>
          <label>Teacher feedback<textarea name="feedback" rows="2" placeholder="Share a note with this child’s parent">${esc(student.feedback || "")}</textarea></label>
          <button class="link-btn" type="submit">Update parent view</button>
        </form>
      </div>
    </article>
  `).join("");
}

$("#teacher-students").addEventListener("submit", (event) => {
  const form = event.target.closest(".student-update-form");
  if (!form || role !== "teacher") return;
  event.preventDefault();
  const student = students.find((item) => item.id === form.dataset.profile);
  if (!student) return;
  const data = new FormData(form);
  student.standing = String(data.get("standing")).trim();
  student.feedback = String(data.get("feedback")).trim();
  save("lw-students", students);
  renderConnectedStudents();
});

function renderAdvising() {
  const target = $("#advising-requests");
  if (role === "teacher") {
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
    target.innerHTML = mine.length
      ? mine.map((request) => `<li><div><strong>Academic advising</strong><span>${esc(request.message)}</span><span>${esc(request.when)}</span></div><span class="pill ${esc(request.status)}">${esc(request.status)}</span></li>`).join("")
      : `<li class="empty">No advising requests yet. Ask your parent to send a request from Guardian Stays.</li>`;
  }
  const pending = requests.filter((request) => request.status === "Pending").length;
  const count = $("#pending-count");
  if (count) count.textContent = `${pending} request${pending === 1 ? "" : "s"} to review`;
}

$("#advising-requests").addEventListener("click", (event) => {
  const button = event.target.closest("[data-accept], [data-decline]");
  if (!button || role !== "teacher") return;
  const id = button.dataset.accept || button.dataset.decline;
  const request = requests.find((item) => item.id === id);
  if (!request) return;
  request.status = button.dataset.accept ? "Accepted" : "Declined";
  save("lw-advising-requests", requests);
  renderAdvising();
  renderNotifications();
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

function renderAttendance() {
  const semester = $("#semester-filter").value;
  const today = new Date().toISOString().slice(0, 10);
  const records = attendance[semester] || {};
  const todaysRecords = records[today] || {};
  const counts = { present: 0, late: 0, absent: 0, unmarked: 0 };
  students.forEach((student) => {
    const status = todaysRecords[student.id];
    if (!status) counts.unmarked += 1;
    else counts[status] += 1;
  });
  $("#summary").textContent = `${counts.present} present · ${counts.late} late · ${counts.absent} absent · ${counts.unmarked} not marked today`;
  $("#roster").innerHTML = students.length ? students.map((student) => {
    const entry = studentAttendance(semester, student.id);
    return `<li><div class="roster-person">${photoMarkup(student, "roster-photo")}<div><strong>${esc(student.name)}</strong><span>${entry ? `${esc(labels[entry.status])} · ${esc(entry.date)}` : "No attendance recorded this semester"}</span></div></div><div class="choices" role="group" aria-label="Attendance for ${esc(student.name)}">${Object.entries(labels).map(([status, label]) => `<button data-attendance="${esc(status)}" data-student="${esc(student.id)}" aria-pressed="${entry?.date === today && entry.status === status}" type="button">${label}</button>`).join("")}</div></li>`;
  }).join("") : `<li class="empty">No student profiles are connected yet.</li>`;
}

$("#roster").addEventListener("click", (event) => {
  const button = event.target.closest("[data-attendance]");
  if (!button || role !== "teacher") return;
  const semester = $("#semester-filter").value;
  const records = attendance[semester] || {};
  const date = new Date().toISOString().slice(0, 10);
  records[date] = records[date] || {};
  records[date][button.dataset.student] = button.dataset.attendance;
  attendance[semester] = records;
  save("lw-attendance", attendance);
  renderAttendance();
  renderParent();
  renderStudent();
  renderNotifications();
});
$("#semester-filter").addEventListener("change", renderAttendance);

function renderParent() {
  if (!linkedStudent) {
    $("#parent-child").innerHTML = `<div class="unlinked-state"><span class="quick-icon">♡</span><h3>No child profile linked</h3><p>Link your own child’s profile using their student ID and private parent link code.</p><form id="link-child-form" class="link-child-form"><label>Child’s full name<input name="childName" autocomplete="off" minlength="2" required /></label><label>Student ID<input name="childId" autocomplete="off" minlength="3" required /></label><label>Parent link code<input name="linkCode" autocomplete="off" minlength="12" required /></label><button class="btn" type="submit">Link child profile</button><p class="form-feedback" id="link-child-feedback" role="status" hidden></p></form></div>`;
    $("#parent-attendance").textContent = "Attendance is available after a child profile is linked.";
    $("#week").innerHTML = `<li class="empty">No child attendance to display.</li>`;
    $("#academic-standing").textContent = "No academic record is available yet.";
    $("#teacher-feedback").textContent = "Teacher feedback will appear here when shared.";
    $("#parent-events").innerHTML = `<p class="empty-state">Child-specific events will appear after linking.</p>`;
    return;
  }
  $("#parent-child").innerHTML = `${photoMarkup(linkedStudent, "child-photo")}<div class="child-copy"><span class="eyebrow">Linked student</span><h3>${esc(linkedStudent.name)}</h3><p>Student ID · ${esc(linkedStudent.id)}</p><span class="student-tag">Pulang Lupa Elementary School</span></div>`;
  const semester = $("#parent-semester").value;
  const entry = studentAttendance(semester, linkedStudent.id);
  $("#parent-attendance").textContent = entry
    ? `${linkedStudent.name} was marked ${entry.status} on ${entry.date}.`
    : `No attendance has been recorded for ${linkedStudent.name} in this semester yet.`;
  const childHistory = Object.entries(attendance[semester] || {})
    .map(([date, records]) => ({ date, status: records[linkedStudent.id] }))
    .filter((record) => record.status)
    .sort((a, b) => b.date.localeCompare(a.date));
  $("#week").innerHTML = childHistory.length
    ? childHistory.map((record) => `<li><span>${esc(record.date)}</span><span class="pill ${esc(record.status)}">${esc(labels[record.status])}</span></li>`).join("")
    : `<li class="empty">No attendance records for this semester.</li>`;
  $("#academic-standing").textContent = linkedStudent.standing || "No academic standing has been shared yet.";
  $("#teacher-feedback").textContent = linkedStudent.feedback || "Your teacher has not shared feedback yet.";
  const childPosts = events.filter((post) => !post.studentId || post.studentId === linkedStudent.id);
  $("#parent-events").innerHTML = childPosts.length
    ? childPosts.map(eventMarkup).join("")
    : `<p class="empty-state">No upcoming events for your child.</p>`;
}
$("#parent-semester").addEventListener("change", renderParent);
$("#parent-child").addEventListener("submit", (event) => {
  const form = event.target.closest("#link-child-form");
  if (!form || role !== "parent") return;
  event.preventDefault();
  const data = new FormData(form);
  const childName = String(data.get("childName")).trim().toLowerCase();
  const childId = String(data.get("childId")).trim().toLowerCase();
  const linkCode = String(data.get("linkCode")).trim().toLowerCase();
  const match = students.find((student) =>
    student.name.trim().toLowerCase() === childName
    && student.id.toLowerCase() === childId
    && student.linkCode === linkCode);
  const feedback = $("#link-child-feedback");
  if (!match) {
    feedback.textContent = "We couldn’t verify those details. Check with your school for the correct student ID and link code.";
    feedback.hidden = false;
    return;
  }
  linkedStudent = match;
  currentStudentId = match.id;
  user.childId = match.id;
  sessionStorage.setItem("lw-user", JSON.stringify(user));
  $("#parent-advising-form").closest(".panel").hidden = false;
  renderParent();
  renderAdvising();
  renderNotifications();
});

function renderStudent() {
  const entry = currentStudentId
    ? studentAttendance($("#semester-filter")?.value || "1", currentStudentId)
    : null;
  const text = entry
    ? `Your attendance was marked ${entry.status} on ${entry.date}.`
    : "No attendance has been recorded for this semester yet.";
  const target = $("#student-attendance");
  if (target) target.textContent = text;
}

document.querySelectorAll("#parent-advising-form, #student-advising-form").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!currentStudentId || !["parent", "student"].includes(role)) return;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    requests.push({
      id: crypto.randomUUID(),
      studentId: currentStudentId,
      message: String(data.get("message")).trim(),
      when: new Date(`${data.get("date")}T${data.get("time")}`).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      status: "Pending",
    });
    save("lw-advising-requests", requests);
    form.reset();
    renderAdvising();
    renderNotifications();
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
if (role === "teacher") {
  renderConnectedStudents();
  renderAttendance();
}
if (role === "parent") {
  $("#parent-advising-form").closest(".panel").hidden = !linkedStudent;
}
if (role === "student") {
  $("#student-advising-form").closest(".panel").hidden = !students.some((student) => student.id === currentStudentId);
  $("#student-link-panel").hidden = !user.linkCode;
  if (user.linkCode) $("#student-link-code").textContent = user.linkCode;
}
renderAdvising();
renderParent();
renderStudent();
renderEvents();
renderNotifications();
showView();
}
