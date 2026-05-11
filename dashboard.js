/**
 * dashboard.js
 * =============
 * Shared logic loaded on every dashboard page.
 *
 * Responsibilities:
 *  1. Session guard  — redirect unauthenticated visitors to login.
 *  2. Profile loader — populate the nav-bar with the user's name & initials.
 *  3. Logout handler — sign out and redirect to index.html.
 *  4. Toast utility  — reusable notification helper.
 */

/* ============================================================
   UTILITY – Toast Notifications (shared copy)
   ============================================================ */
function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const icons = {
    info:    `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4c91f5" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    success: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    error:   `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f85149" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `${icons[type] || ''}<span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toastOut 300ms ease forwards';
    setTimeout(() => toast.remove(), 310);
  }, duration);
}

/* ============================================================
   HELPERS
   ============================================================ */

/**
 * Returns the initial(s) for a given full name (up to 2 characters).
 * @param {string} name
 * @returns {string}
 */
function getInitials(name) {
  return name
    .split(' ')
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/**
 * Safely sets the text content of an element by ID (no-op if not found).
 * @param {string} id
 * @param {string} text
 */
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/* ============================================================
   CORE — Dashboard Initialiser
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {

  // ── 1. Session guard ─────────────────────────────────────────
  const { data: { session } } = await supabaseClient.auth.getSession();

  if (!session) {
    // No active session — bounce to login
    showToast('Session expired. Please log in again.', 'error', 3000);
    setTimeout(() => { window.location.href = 'index.html'; }, 1200);
    return;
  }

  // ── 2. Load user profile ──────────────────────────────────────
  const profile = await getUserProfile(session.user.id);

  if (!profile) {
    showToast('Could not load your profile. Redirecting to login…', 'error');
    await supabaseClient.auth.signOut();
    setTimeout(() => { window.location.href = 'index.html'; }, 1500);
    return;
  }

  // ── 3. Populate nav-bar ───────────────────────────────────────
  // Each dashboard page has differently-prefixed IDs; we try all possibilities.
  const prefixes = ['admin', 'teacher', 'student'];
  for (const prefix of prefixes) {
    setText(`${prefix}-fullname`, profile.full_name);
    const avatarEl = document.getElementById(`${prefix}-avatar`);
    if (avatarEl) avatarEl.textContent = getInitials(profile.full_name);
  }

  // ── 4. Logout buttons ─────────────────────────────────────────
  const logoutBtnIds = [
    'btn-logout-admin',
    'btn-logout-teacher',
    'btn-logout-student',
  ];

  logoutBtnIds.forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Signing out…';

      const { error } = await supabaseClient.auth.signOut();

      if (error) {
        showToast('Sign-out failed. Please try again.', 'error');
        btn.disabled = false;
        btn.textContent = 'Sign Out';
        return;
      }

      showToast('You have been signed out.', 'info', 2000);
      setTimeout(() => { window.location.href = 'index.html'; }, 800);
    });
  });

  // ── 5. Welcome toast ──────────────────────────────────────────
  showToast(`Logged in as ${profile.full_name} (${profile.role})`, 'success', 3500);

});
