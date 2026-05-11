/**
 * login.js
 * =========
 * Handles all login-page interactions:
 *  - Real-time field validation
 *  - Password visibility toggle
 *  - Supabase authentication (signInWithPassword)
 *  - Role fetching from the `users` public profile table
 *  - Dashboard redirection based on role
 *  - Toast notifications
 */

/* ============================================================
   UTILITY – Toast Notifications
   ============================================================ */

/**
 * Displays a temporary toast notification at the bottom-right of the screen.
 * @param {string} message  - Text to show in the toast.
 * @param {'info'|'success'|'error'} type - Visual style variant.
 * @param {number} duration - Auto-dismiss time in milliseconds (default 4 s).
 */
function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');

  // Icon map per type
  const icons = {
    info:    `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4c91f5" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    success: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    error:   `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f85149" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `${icons[type] || ''}<span>${message}</span>`;
  container.appendChild(toast);

  // Auto-remove after duration
  setTimeout(() => {
    toast.style.animation = 'toastOut 300ms ease forwards';
    setTimeout(() => toast.remove(), 310);
  }, duration);
}

/* ============================================================
   UTILITY – Field Validation Helpers
   ============================================================ */

/** Error-icon SVG injected before every field error message. */
const ERROR_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

/**
 * Marks a form field as invalid and shows an error message.
 * @param {HTMLInputElement} input   - The field element.
 * @param {HTMLElement}      errorEl - The sibling error <div>.
 * @param {string}           message - Error message to display.
 */
function setFieldError(input, errorEl, message) {
  input.classList.remove('input-success');
  input.classList.add('input-error');
  errorEl.innerHTML = `${ERROR_ICON} ${message}`;
}

/**
 * Marks a form field as valid and clears the error message.
 * @param {HTMLInputElement} input   - The field element.
 * @param {HTMLElement}      errorEl - The sibling error <div>.
 */
function clearFieldError(input, errorEl) {
  input.classList.remove('input-error');
  input.classList.add('input-success');
  errorEl.innerHTML = '';
}

/**
 * Validates the username field.
 * Rules: non-empty, at least 3 characters.
 * @param {HTMLInputElement} input   - Username input.
 * @param {HTMLElement}      errorEl - Error display element.
 * @returns {boolean} True if the field is valid.
 */
function validateUsername(input, errorEl) {
  const value = input.value.trim();
  if (!value) {
    setFieldError(input, errorEl, 'Username is required.');
    return false;
  }
  if (value.length < 3) {
    setFieldError(input, errorEl, 'Username must be at least 3 characters.');
    return false;
  }
  clearFieldError(input, errorEl);
  return true;
}

/**
 * Validates the password field.
 * Rules: non-empty, at least 6 characters.
 * @param {HTMLInputElement} input   - Password input.
 * @param {HTMLElement}      errorEl - Error display element.
 * @returns {boolean} True if the field is valid.
 */
function validatePassword(input, errorEl) {
  const value = input.value;
  if (!value) {
    setFieldError(input, errorEl, 'Password is required.');
    return false;
  }
  if (value.length < 6) {
    setFieldError(input, errorEl, 'Password must be at least 6 characters.');
    return false;
  }
  clearFieldError(input, errorEl);
  return true;
}

/* ============================================================
   UTILITY – Global Alert Banner
   ============================================================ */

/**
 * Shows/hides the global alert banner above the form.
 * @param {string}            message - Alert text.
 * @param {'error'|'success'} type    - Visual variant.
 */
function showGlobalAlert(message, type = 'error') {
  const el = document.getElementById('global-alert');
  const icon = type === 'error'
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ff7b72" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#56d364" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;

  el.className = `alert-banner alert-${type}`;
  el.innerHTML = `${icon}<span>${message}</span>`;
  el.style.display = 'flex';
}

function hideGlobalAlert() {
  const el = document.getElementById('global-alert');
  el.style.display = 'none';
  el.innerHTML = '';
}

/* ============================================================
   UTILITY – Button Loading State
   ============================================================ */

/**
 * Enables or disables the login button and shows a spinner when loading.
 * @param {boolean} isLoading - Whether to show the loading state.
 */
function setButtonLoading(isLoading) {
  const btn = document.getElementById('btn-login');
  if (isLoading) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Signing in…`;
  } else {
    btn.disabled = false;
    btn.innerHTML = 'Sign In';
  }
}

/* ============================================================
   CORE – Supabase Login Handler
   ============================================================ */

/**
 * Authenticates the user with Supabase using email+password.
 *
 * Note: Supabase auth uses *email* as the identifier, but we expose a
 * "username" field in our UI and store it in the public `users` table.
 * The convention used here is:
 *   email stored in Supabase Auth = username@cebs.local
 * This keeps the UI school-friendly while still satisfying the
 * Supabase auth requirement of a valid email.
 *
 * @param {string} username - The username entered by the user.
 * @param {string} password - The password entered by the user.
 */
async function handleLogin(username, password) {
  setButtonLoading(true);
  hideGlobalAlert();

  try {
    // ── Step 1: Sign in via Supabase Auth ──────────────────────────
    // We convert the username to the internal email format used at registration.
    const email = `${username.toLowerCase().trim()}@cebs.local`;

    const { data: authData, error: authError } =
      await supabaseClient.auth.signInWithPassword({ email, password });

    if (authError) {
      // Handle common Supabase auth errors with friendly messages
      const msg = authError.message.includes('Invalid login')
        ? 'Incorrect username or password. Please try again.'
        : authError.message;

      showGlobalAlert(msg, 'error');
      showToast(msg, 'error');
      return; // early exit
    }

    const userId = authData.user.id;

    // ── Step 2: Fetch the user's public profile & role ─────────────
    const profile = await getUserProfile(userId);

    if (!profile) {
      showGlobalAlert(
        'Your account was found but your profile is missing. Please contact an administrator.',
        'error'
      );
      // Sign out the ghost session
      await supabaseClient.auth.signOut();
      return;
    }

    // ── Step 3: Success feedback & role-based redirect ─────────────
    showToast(`Welcome back, ${profile.full_name}! Redirecting…`, 'success', 2500);
    showGlobalAlert(`Login successful. Redirecting to your dashboard…`, 'success');

    // Short delay so the user can read the success message
    setTimeout(() => redirectToDashboard(profile.role), 1500);

  } catch (err) {
    // Unexpected network / runtime errors
    console.error('[Login] Unexpected error:', err);
    showGlobalAlert(
      'A network error occurred. Please check your connection and try again.',
      'error'
    );
    showToast('Connection error. Please try again.', 'error');
  } finally {
    // Re-enable button only when NOT redirecting (i.e., on error)
    // If login is successful, the page will redirect; no need to re-enable.
    const alertEl = document.getElementById('global-alert');
    if (alertEl.classList.contains('alert-error')) {
      setButtonLoading(false);
    }
  }
}

/* ============================================================
   DOM – Event Wiring
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {

  // ── Element references ────────────────────────────────────────
  const form         = document.getElementById('login-form');
  const usernameInput = document.getElementById('username-input');
  const passwordInput = document.getElementById('password-input');
  const usernameError = document.getElementById('username-error');
  const passwordError = document.getElementById('password-error');
  const togglePwBtn   = document.getElementById('toggle-password');
  const eyeOpen       = document.getElementById('icon-eye-open');
  const eyeClosed     = document.getElementById('icon-eye-closed');

  // ── Real-time validation (on blur) ───────────────────────────
  usernameInput.addEventListener('blur', () =>
    validateUsername(usernameInput, usernameError)
  );
  passwordInput.addEventListener('blur', () =>
    validatePassword(passwordInput, passwordError)
  );

  // Clear error as the user types (after first validation attempt)
  usernameInput.addEventListener('input', () => {
    if (usernameInput.classList.contains('input-error')) {
      validateUsername(usernameInput, usernameError);
    }
  });
  passwordInput.addEventListener('input', () => {
    if (passwordInput.classList.contains('input-error')) {
      validatePassword(passwordInput, passwordError);
    }
  });

  // ── Password visibility toggle ───────────────────────────────
  togglePwBtn.addEventListener('click', () => {
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    eyeOpen.style.display   = isPassword ? 'none'  : 'block';
    eyeClosed.style.display = isPassword ? 'block' : 'none';
    togglePwBtn.setAttribute('aria-label',
      isPassword ? 'Hide password' : 'Show password'
    );
  });

  // ── Form submission ──────────────────────────────────────────
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Run all validations; only proceed if all pass
    const isUsernameValid = validateUsername(usernameInput, usernameError);
    const isPasswordValid = validatePassword(passwordInput, passwordError);

    if (!isUsernameValid || !isPasswordValid) {
      showToast('Please fix the errors above before submitting.', 'error', 3000);
      return;
    }

    await handleLogin(usernameInput.value.trim(), passwordInput.value);
  });

  // ── Session guard: redirect if already logged in ─────────────
  // Prevents logged-in users from seeing the login page again.
  (async () => {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      const profile = await getUserProfile(session.user.id);
      if (profile) {
        redirectToDashboard(profile.role);
      }
    }
  })();

});
