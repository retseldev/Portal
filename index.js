const feedbackForm = document.querySelector("#feedback-form");
const note = document.querySelector("#feedback-confirmation");

if (feedbackForm && note) {
  const say = (text, good) => {
    note.textContent = text;
    note.hidden = !text;
    note.classList.toggle("is-error", !good);
  };

  feedbackForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!feedbackForm.reportValidity()) return;

    const f = new FormData(feedbackForm);
    const button = feedbackForm.querySelector("button");
    button.disabled = true;

    try {
      const { supabase } = await import("./supabase-client.js");
      if (!supabase) {
        return say("Feedback can't be sent yet because the database isn't connected.", false);
      }

      const { error } = await supabase.from("feedback").insert({
        name: String(f.get("name") || "").trim() || null,
        role: f.get("role"),
        message: String(f.get("feedback") || "").trim(),
      });

      if (error) {
        console.error("Unable to send school feedback.", error);
        return say("We couldn't send your feedback. Try again in a moment.", false);
      }

      feedbackForm.reset();
      say("Thanks. Your feedback was sent.", true);
    } catch (error) {
      console.error("Unable to send school feedback.", error);
      say("We couldn't send your feedback. Check your connection and try again.", false);
    } finally {
      button.disabled = false;
    }
  });

  feedbackForm.addEventListener("input", () => { note.hidden = true; });
}

const year = document.querySelector("#year");
if (year) year.textContent = new Date().getFullYear();

const menuToggle = document.querySelector("#menu-toggle");
const siteMenu = document.querySelector("#site-menu");

function setMenuOpen(open) {
  if (!menuToggle || !siteMenu) return;
  siteMenu.hidden = !open;
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
}

if (menuToggle && siteMenu) {
  menuToggle.addEventListener("click", () => {
    setMenuOpen(menuToggle.getAttribute("aria-expanded") !== "true");
  });
  document.querySelectorAll("[data-open-menu]").forEach((button) => {
    button.addEventListener("click", () => {
      setMenuOpen(true);
      menuToggle.focus();
    });
  });
  siteMenu.addEventListener("click", (event) => {
    if (event.target.closest("a")) setMenuOpen(false);
  });
  document.addEventListener("click", (event) => {
    if (!siteMenu.hidden && !event.target.closest("#site-menu, #menu-toggle, [data-open-menu]")) {
      setMenuOpen(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !siteMenu.hidden) {
      setMenuOpen(false);
      menuToggle.focus();
    }
  });
}

const publicUpdates = document.querySelector("#public-updates");
if (publicUpdates) {
  let posts = [];
  try {
    const stored = JSON.parse(localStorage.getItem("lw-school-posts") || "[]");
    if (Array.isArray(stored)) posts = stored;
  } catch (error) {
    console.error("Unable to read school announcements from this browser.", error);
  }
  if (!posts.length) {
    const empty = document.createElement("p");
    empty.className = "public-update-empty";
    empty.textContent = "No school events or announcements have been posted yet.";
    publicUpdates.append(empty);
  } else {
    posts
      .filter((post) => !post.studentId)
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
      .forEach((post) => {
        const card = document.createElement("article");
        card.className = "public-update-card";
        const type = document.createElement("span");
        type.className = "public-update-type";
        type.textContent = post.type === "announcement" ? "Announcement" : "School event";
        const title = document.createElement("strong");
        title.textContent = post.title || "School update";
        const details = document.createElement("p");
        details.textContent = post.details || "";
        card.append(type, title);
        if (post.date) {
          const date = document.createElement("time");
          date.dateTime = post.date;
          date.textContent = new Date(`${post.date}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
          card.append(date);
        }
        card.append(details);
        publicUpdates.append(card);
      });
  }
}