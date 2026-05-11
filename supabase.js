/**
 * supabase.js
 * ============
 * Supabase Client Configuration
 * 
 * IMPORTANT: Replace the placeholder values below with your actual
 * Supabase Project URL and Anon Key from your Supabase Dashboard.
 * Dashboard → Project Settings → API
 */

// ---------------------------------------------------------------------------
// 1.  Import the Supabase CDN client (loaded via <script> in each HTML page)
//     We use the global `supabase` object exposed by the CDN bundle.
// ---------------------------------------------------------------------------

const SUPABASE_URL  = 'https://cavayffpbersxxwatmwf.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhdmF5ZmZwYmVyc3h4d2F0bXdmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1MTAyNTksImV4cCI6MjA5NDA4NjI1OX0.JnkvBZV3jCBdyF17adqvMB6-du52a2ju0bb4C-mUr-4';

// Create and export a single shared Supabase client instance
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

/**
 * Retrieves the authenticated user's public profile from the `users` table.
 * Uses maybeSingle() instead of single() to safely handle cases where
 * overlapping RLS policies might cause duplicate row visibility.
 * @param {string} userId - The auth.uid() of the logged-in user.
 * @returns {object|null} The user profile row or null on error/not found.
 */
async function getUserProfile(userId) {
  console.log('[Supabase] Fetching profile for userId:', userId);

  // Use maybeSingle() — returns null (not an error) when 0 rows found,
  // and does not throw on multiple rows like .single() does.
  const { data, error } = await supabaseClient
    .from('users')
    .select('id, username, full_name, role')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.error('[Supabase] getUserProfile error:', error.message, error);
    return null;
  }

  if (!data) {
    console.warn('[Supabase] No profile row found for userId:', userId);
    return null;
  }

  console.log('[Supabase] Profile loaded:', data);
  return data;
}

/**
 * Role → Dashboard mapping.
 * Extend this object whenever a new role/page is added.
 */
const ROLE_DASHBOARD = {
  Admin:   'admin-dashboard.html',
  Teacher: 'teacher-dashboard.html',
  Student: 'student-dashboard.html',
};

/**
 * Redirects the current window to the correct dashboard for a given role.
 * Falls back to index.html if the role is unknown.
 * @param {string} role - One of 'Admin', 'Teacher', 'Student'.
 */
function redirectToDashboard(role) {
  const target = ROLE_DASHBOARD[role] || 'index.html';
  window.location.href = target;
}
