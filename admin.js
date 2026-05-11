/**
 * admin.js
 * =========
 * Phase 2 Admin Dashboard — Full logic module.
 *
 * Responsibilities:
 *  A. Dynamic KPI cards (via RPC: get_dashboard_stats)
 *  B. Equipment CRUD (create, read, update-status, archive/delete)
 *  C. User role management (read, update role)
 *  D. Overdue borrowers panel (via RPC: get_overdue_borrowers)
 *  E. Monthly report panel (via RPC: get_monthly_report)
 *  F. Equipment search & filter
 *  G. System log viewer
 *
 * Depends on: supabase.js (supabaseClient), dashboard.js (showToast, session guard)
 * Loaded AFTER dashboard.js in admin-dashboard.html
 */

/* ============================================================
   SECTION A — DASHBOARD KPI CARDS
   RPC: get_dashboard_stats() — uses COUNT + JOIN
   ============================================================ */

/**
 * Fetches all four KPI values in one RPC call and updates the DOM.
 */
async function loadDashboardStats() {
  try {
    const { data, error } = await supabaseClient.rpc('get_dashboard_stats');
    if (error) throw error;

    // Animate count-up for each card
    animateCount('kpi-total-users',     data.total_users     ?? 0);
    animateCount('kpi-total-equipment', data.total_equipment ?? 0);
    animateCount('kpi-active-borrows',  data.active_borrows  ?? 0);
    animateCount('kpi-overdue',         data.overdue         ?? 0);

    // Highlight overdue card if there are overdue items
    if (data.overdue > 0) {
      document.getElementById('kpi-overdue')?.closest('.kpi-card')
        ?.classList.add('kpi-card--warning');
    }
  } catch (err) {
    console.error('[Admin] loadDashboardStats error:', err.message);
    showToast('Could not load dashboard stats.', 'error');
  }
}

/**
 * Animates a number counter from 0 to `target` over ~600ms.
 * @param {string} elementId - ID of the element to update.
 * @param {number} target    - Final value.
 */
function animateCount(elementId, target) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const duration = 600;
  const start = performance.now();
  const from = parseInt(el.textContent) || 0;

  function step(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    el.textContent = Math.round(from + (target - from) * eased);
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}


/* ============================================================
   SECTION B — EQUIPMENT CRUD
   ============================================================ */

/** In-memory state for the equipment table */
let equipmentData  = [];
let categoriesData = [];
let currentEquipmentEditId = null;

/**
 * Loads all categories from Supabase for dropdowns.
 */
async function loadCategories() {
  try {
    const { data, error } = await supabaseClient
      .from('categories')
      .select('id, category_name')
      .order('category_name');
    if (error) throw error;
    categoriesData = data || [];
    populateCategoryDropdowns();
  } catch (err) {
    console.error('[Admin] loadCategories error:', err.message);
  }
}

/** Fills all <select> elements with class `category-select` */
function populateCategoryDropdowns() {
  document.querySelectorAll('.category-select').forEach(sel => {
    const current = sel.value;
    sel.innerHTML = `<option value="">All Categories</option>` +
      categoriesData.map(c =>
        `<option value="${c.id}">${escHtml(c.category_name)}</option>`
      ).join('');
    sel.value = current; // restore previous selection
  });
}

/**
 * Reads equipment from Supabase with optional search & filter.
 * Satisfies: Search by name/serial_number, Filter by status.
 * @param {string} searchTerm - Text to search name or serial_number.
 * @param {string} statusFilter - 'Available'|'Borrowed'|'Maintenance'|''
 * @param {string} categoryFilter - UUID or ''
 */
async function loadEquipment(searchTerm = '', statusFilter = '', categoryFilter = '') {
  try {
    let query = supabaseClient
      .from('equipment')
      .select(`
        id, name, serial_number, status, notes, created_at,
        categories ( category_name )
      `)
      .neq('status', 'Archived') // never show archived in main list
      .order('created_at', { ascending: false });

    // Filter by status
    if (statusFilter) query = query.eq('status', statusFilter);

    // Filter by category
    if (categoryFilter) query = query.eq('category_id', categoryFilter);

    // Text search — name OR serial_number (ilike = case-insensitive LIKE)
    if (searchTerm.trim()) {
      query = query.or(
        `name.ilike.%${searchTerm.trim()}%,serial_number.ilike.%${searchTerm.trim()}%`
      );
    }

    const { data, error } = await query;
    if (error) throw error;

    equipmentData = data || [];
    renderEquipmentTable(equipmentData);
  } catch (err) {
    console.error('[Admin] loadEquipment error:', err.message);
    showToast('Failed to load equipment list.', 'error');
  }
}

/** Renders the equipment data into #equipment-table-body */
function renderEquipmentTable(rows) {
  const tbody = document.getElementById('equipment-table-body');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = `
      <tr><td colspan="6" class="table-empty">No equipment found.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(item => `
    <tr data-id="${item.id}">
      <td>${escHtml(item.name)}</td>
      <td>${escHtml(item.serial_number || '—')}</td>
      <td>${escHtml(item.categories?.category_name || '—')}</td>
      <td><span class="status-badge status-${item.status.toLowerCase()}">${item.status}</span></td>
      <td>${escHtml(item.notes || '—')}</td>
      <td class="table-actions">
        <button class="btn-table btn-edit"   onclick="openEditEquipment('${item.id}')">Edit</button>
        <button class="btn-table btn-archive" onclick="archiveEquipment('${item.id}')">Archive</button>
      </td>
    </tr>
  `).join('');
}

/**
 * Creates a new equipment entry in Supabase.
 * Called from the "Add Equipment" form submit handler.
 */
async function createEquipment(formData) {
  try {
    const { data, error } = await supabaseClient
      .from('equipment')
      .insert([{
        name:          formData.name,
        serial_number: formData.serial_number || null,
        category_id:   formData.category_id   || null,
        status:        formData.status         || 'Available',
        notes:         formData.notes          || null,
      }])
      .select()
      .single();

    if (error) throw error;

    // Log the action
    await supabaseClient.rpc('log_action', {
      p_action_type: 'CREATE_EQUIPMENT',
      p_details: { equipment_id: data.id, name: data.name },
    });

    showToast(`Equipment "${data.name}" added successfully.`, 'success');
    closeModal('modal-equipment');
    await loadEquipment();
    await loadDashboardStats();
  } catch (err) {
    console.error('[Admin] createEquipment error:', err.message);
    showToast(`Failed to add equipment: ${err.message}`, 'error');
  }
}

/**
 * Opens the equipment modal pre-filled for editing.
 * @param {string} id - Equipment UUID.
 */
function openEditEquipment(id) {
  const item = equipmentData.find(e => e.id === id);
  if (!item) return;
  currentEquipmentEditId = id;

  document.getElementById('eq-modal-title').textContent   = 'Edit Equipment';
  document.getElementById('eq-name').value                = item.name;
  document.getElementById('eq-serial').value              = item.serial_number || '';
  document.getElementById('eq-status').value              = item.status;
  document.getElementById('eq-notes').value               = item.notes || '';
  // Set category select
  const catSel = document.getElementById('eq-category');
  if (catSel && item.categories) {
    const match = categoriesData.find(c => c.category_name === item.categories.category_name);
    if (match) catSel.value = match.id;
  }

  openModal('modal-equipment');
}

/**
 * Updates an existing equipment entry.
 * @param {string} id       - Equipment UUID.
 * @param {object} formData - Updated field values.
 */
async function updateEquipment(id, formData) {
  try {
    const { error } = await supabaseClient
      .from('equipment')
      .update({
        name:          formData.name,
        serial_number: formData.serial_number || null,
        category_id:   formData.category_id   || null,
        status:        formData.status,
        notes:         formData.notes          || null,
      })
      .eq('id', id);

    if (error) throw error;

    await supabaseClient.rpc('log_action', {
      p_action_type: 'UPDATE_EQUIPMENT',
      p_details: { equipment_id: id, updates: formData },
    });

    showToast('Equipment updated.', 'success');
    closeModal('modal-equipment');
    currentEquipmentEditId = null;
    await loadEquipment();
    await loadDashboardStats();
  } catch (err) {
    console.error('[Admin] updateEquipment error:', err.message);
    showToast(`Update failed: ${err.message}`, 'error');
  }
}

/**
 * Archives (soft-deletes) an equipment item by setting status = 'Archived'.
 * @param {string} id - Equipment UUID.
 */
async function archiveEquipment(id) {
  const item = equipmentData.find(e => e.id === id);
  if (!confirm(`Archive "${item?.name}"? It will be hidden from the inventory.`)) return;

  try {
    const { error } = await supabaseClient
      .from('equipment')
      .update({ status: 'Archived' })
      .eq('id', id);

    if (error) throw error;

    await supabaseClient.rpc('log_action', {
      p_action_type: 'ARCHIVE_EQUIPMENT',
      p_details: { equipment_id: id, name: item?.name },
    });

    showToast(`"${item?.name}" has been archived.`, 'info');
    await loadEquipment();
    await loadDashboardStats();
  } catch (err) {
    console.error('[Admin] archiveEquipment error:', err.message);
    showToast(`Archive failed: ${err.message}`, 'error');
  }
}


/* ============================================================
   SECTION C — USER ROLE MANAGEMENT
   ============================================================ */

let usersData = [];

/**
 * Loads all users for the user management panel.
 */
async function loadUsers() {
  try {
    const { data, error } = await supabaseClient
      .from('users')
      .select('id, username, full_name, role, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    usersData = data || [];
    renderUsersTable(usersData);
  } catch (err) {
    console.error('[Admin] loadUsers error:', err.message);
    showToast('Failed to load users.', 'error');
  }
}

/** Renders the users data into #users-table-body */
function renderUsersTable(rows) {
  const tbody = document.getElementById('users-table-body');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="table-empty">No users found.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(u => `
    <tr data-id="${u.id}">
      <td>${escHtml(u.username)}</td>
      <td>${escHtml(u.full_name)}</td>
      <td>
        <select class="role-select inline-select" data-user-id="${u.id}"
                onchange="updateUserRole('${u.id}', this.value)">
          <option value="Admin"   ${u.role === 'Admin'   ? 'selected' : ''}>Admin</option>
          <option value="Teacher" ${u.role === 'Teacher' ? 'selected' : ''}>Teacher</option>
          <option value="Student" ${u.role === 'Student' ? 'selected' : ''}>Student</option>
        </select>
      </td>
      <td>${new Date(u.created_at).toLocaleDateString()}</td>
      <td class="table-actions">
        <button class="btn-table btn-danger"
                onclick="deleteUser('${u.id}', '${escHtml(u.username)}')">Remove</button>
      </td>
    </tr>
  `).join('');
}

/**
 * Updates a user's role in the `users` table.
 * @param {string} userId - UUID of the user.
 * @param {string} newRole - 'Admin' | 'Teacher' | 'Student'
 */
async function updateUserRole(userId, newRole) {
  try {
    const { error } = await supabaseClient
      .from('users')
      .update({ role: newRole })
      .eq('id', userId);

    if (error) throw error;

    await supabaseClient.rpc('log_action', {
      p_action_type: 'UPDATE_USER_ROLE',
      p_details: { target_user_id: userId, new_role: newRole },
    });

    showToast(`Role updated to ${newRole}.`, 'success');
  } catch (err) {
    console.error('[Admin] updateUserRole error:', err.message);
    showToast(`Role update failed: ${err.message}`, 'error');
    await loadUsers(); // reload to reset the dropdown
  }
}

/**
 * Deletes a user profile from the users table.
 * (Note: deleting from auth.users requires server-side / service_role key)
 * @param {string} userId   - UUID of the user.
 * @param {string} username - Display name for the confirm dialog.
 */
async function deleteUser(userId, username) {
  if (!confirm(`Remove user "${username}"? This cannot be undone.`)) return;

  try {
    const { error } = await supabaseClient
      .from('users')
      .delete()
      .eq('id', userId);

    if (error) throw error;

    await supabaseClient.rpc('log_action', {
      p_action_type: 'DELETE_USER',
      p_details: { target_user_id: userId, username },
    });

    showToast(`User "${username}" removed.`, 'info');
    await loadUsers();
    await loadDashboardStats();
  } catch (err) {
    console.error('[Admin] deleteUser error:', err.message);
    showToast(`Delete failed: ${err.message}`, 'error');
  }
}


/* ============================================================
   SECTION D — OVERDUE BORROWERS
   RPC: get_overdue_borrowers() — uses Subqueries
   ============================================================ */

/**
 * Fetches overdue borrowers and renders them in the overdue panel.
 */
async function loadOverdueBorrowers() {
  const tbody = document.getElementById('overdue-table-body');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="5" class="table-loading">Loading…</td></tr>`;

  try {
    const { data, error } = await supabaseClient.rpc('get_overdue_borrowers');
    if (error) throw error;

    if (!data || !data.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="table-empty">✅ No overdue borrowers.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.map(r => `
      <tr>
        <td>${escHtml(r.full_name)}</td>
        <td>${escHtml(r.username)}</td>
        <td><span class="role-badge ${r.role.toLowerCase()}">${r.role}</span></td>
        <td class="overdue-count">${r.overdue_count}</td>
        <td class="overdue-date">${r.oldest_due_date ?? '—'}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('[Admin] loadOverdueBorrowers error:', err.message);
    tbody.innerHTML = `<tr><td colspan="5" class="table-empty table-error">Failed to load overdue data.</td></tr>`;
  }
}


/* ============================================================
   SECTION E — MONTHLY REPORT (CTE)
   RPC: get_monthly_report()
   ============================================================ */

/**
 * Fetches the monthly borrow report (CTE) and renders it.
 */
async function loadMonthlyReport() {
  const tbody = document.getElementById('report-table-body');
  const title = document.getElementById('report-month-label');
  if (!tbody) return;

  if (title) {
    const now = new Date();
    title.textContent = now.toLocaleString('default', { month: 'long', year: 'numeric' });
  }

  tbody.innerHTML = `<tr><td colspan="4" class="table-loading">Generating report…</td></tr>`;

  try {
    const { data, error } = await supabaseClient.rpc('get_monthly_report');
    if (error) throw error;

    if (!data || !data.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="table-empty">No borrow activity this month.</td></tr>`;
      return;
    }

    const totalBorrows = data.reduce((s, r) => s + Number(r.total_borrows), 0);

    tbody.innerHTML = data.map(r => {
      const pct = totalBorrows ? Math.round((r.total_borrows / totalBorrows) * 100) : 0;
      return `
        <tr>
          <td>${escHtml(r.category_name)}</td>
          <td>${r.total_borrows}</td>
          <td>${r.active_borrows}</td>
          <td>${r.returned}</td>
        </tr>
      `;
    }).join('') + `
      <tr class="table-total">
        <td><strong>Total</strong></td>
        <td><strong>${totalBorrows}</strong></td>
        <td><strong>${data.reduce((s,r) => s + Number(r.active_borrows), 0)}</strong></td>
        <td><strong>${data.reduce((s,r) => s + Number(r.returned), 0)}</strong></td>
      </tr>`;
  } catch (err) {
    console.error('[Admin] loadMonthlyReport error:', err.message);
    tbody.innerHTML = `<tr><td colspan="4" class="table-error table-empty">Failed to generate report.</td></tr>`;
  }
}


/* ============================================================
   SECTION F — SEARCH & FILTER
   ============================================================ */

/** Debounce timer reference for search input */
let searchDebounceTimer = null;

/**
 * Handles the search input with a 350ms debounce.
 */
function handleEquipmentSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    const term     = document.getElementById('search-equipment')?.value || '';
    const status   = document.getElementById('filter-status')?.value   || '';
    const category = document.getElementById('filter-category')?.value || '';
    loadEquipment(term, status, category);
  }, 350);
}


/* ============================================================
   SECTION G — SYSTEM LOGS VIEWER
   ============================================================ */

/**
 * Loads the latest 50 system log entries for the admin.
 */
async function loadSystemLogs() {
  const tbody = document.getElementById('logs-table-body');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="4" class="table-loading">Loading logs…</td></tr>`;

  try {
    const { data, error } = await supabaseClient
      .from('system_logs')
      .select(`
        id, action_type, details, created_at,
        users:performed_by ( username, full_name )
      `)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    if (!data || !data.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="table-empty">No log entries yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.map(log => `
      <tr>
        <td>${new Date(log.created_at).toLocaleString()}</td>
        <td><code>${escHtml(log.action_type)}</code></td>
        <td>${escHtml(log.users?.username || 'System')}</td>
        <td class="log-details">${escHtml(JSON.stringify(log.details || {}))}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('[Admin] loadSystemLogs error:', err.message);
    tbody.innerHTML = `<tr><td colspan="4" class="table-error table-empty">Failed to load logs.</td></tr>`;
  }
}


/* ============================================================
   MODAL HELPERS
   ============================================================ */

function openModal(modalId) {
  const m = document.getElementById(modalId);
  if (m) { m.classList.add('modal-open'); m.setAttribute('aria-hidden', 'false'); }
}

function closeModal(modalId) {
  const m = document.getElementById(modalId);
  if (m) { m.classList.remove('modal-open'); m.setAttribute('aria-hidden', 'true'); }
}

/** Close modal when clicking the backdrop */
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-backdrop')) {
    document.querySelectorAll('.modal-backdrop.modal-open').forEach(m => {
      closeModal(m.id);
    });
  }
});

/** Close modal on Escape key */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop.modal-open').forEach(m => {
      closeModal(m.id);
    });
  }
});


/* ============================================================
   TAB NAVIGATION
   ============================================================ */

/**
 * Switches the active admin panel tab.
 * @param {string} tabId - ID of the tab panel to show.
 */
function switchTab(tabId) {
  // Hide all panels
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('tab-active'));
  // Deactivate all tab buttons
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

  // Show target panel
  const panel = document.getElementById(tabId);
  if (panel) panel.classList.add('tab-active');

  // Activate corresponding button
  const btn = document.querySelector(`[data-tab="${tabId}"]`);
  if (btn) btn.classList.add('active');

  // Lazy-load data when switching tabs
  if (tabId === 'tab-equipment')  loadEquipment();
  if (tabId === 'tab-users')      loadUsers();
  if (tabId === 'tab-overdue')    loadOverdueBorrowers();
  if (tabId === 'tab-report')     loadMonthlyReport();
  if (tabId === 'tab-logs')       loadSystemLogs();
}


/* ============================================================
   UTILITY — XSS prevention
   ============================================================ */

/**
 * Escapes a string for safe HTML insertion.
 * @param {string} str
 * @returns {string}
 */
function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


/* ============================================================
   BOOT — Runs after dashboard.js DOMContentLoaded completes
   ============================================================ */

/**
 * Admin-specific initialisation, called after the shared session
 * guard in dashboard.js has already confirmed the user is an Admin.
 */
async function initAdminDashboard() {
  // Load categories first (needed for dropdowns in equipment tab)
  await loadCategories();

  // Always-visible: KPI stats on the overview tab
  await loadDashboardStats();

  // Wire up tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Wire up equipment search & filter inputs
  document.getElementById('search-equipment')
    ?.addEventListener('input', handleEquipmentSearch);
  document.getElementById('filter-status')
    ?.addEventListener('change', handleEquipmentSearch);
  document.getElementById('filter-category')
    ?.addEventListener('change', handleEquipmentSearch);

  // Wire up "Add Equipment" button
  document.getElementById('btn-add-equipment')?.addEventListener('click', () => {
    currentEquipmentEditId = null;
    document.getElementById('eq-modal-title').textContent = 'Add Equipment';
    document.getElementById('form-equipment').reset();
    openModal('modal-equipment');
  });

  // Wire up Equipment form submit (handles both CREATE and UPDATE)
  document.getElementById('form-equipment')?.addEventListener('submit', async e => {
    e.preventDefault();
    const formData = {
      name:          document.getElementById('eq-name').value.trim(),
      serial_number: document.getElementById('eq-serial').value.trim(),
      category_id:   document.getElementById('eq-category').value,
      status:        document.getElementById('eq-status').value,
      notes:         document.getElementById('eq-notes').value.trim(),
    };

    if (!formData.name) {
      showToast('Equipment name is required.', 'error');
      return;
    }

    if (currentEquipmentEditId) {
      await updateEquipment(currentEquipmentEditId, formData);
    } else {
      await createEquipment(formData);
    }
  });

  // Wire up modal close buttons
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.modal-backdrop');
      if (modal) closeModal(modal.id);
    });
  });

  // Refresh stats button
  document.getElementById('btn-refresh-stats')?.addEventListener('click', async () => {
    await loadDashboardStats();
    showToast('Stats refreshed.', 'info', 2000);
  });

  // Default: show equipment tab
  switchTab('tab-equipment');
}

// ── Hook into the shared dashboard.js DOMContentLoaded lifecycle ─────────────
// dashboard.js fires its own DOMContentLoaded listener for session guard.
// We use a second listener here which also fires after DOM is ready.
document.addEventListener('DOMContentLoaded', () => {
  // Small delay to ensure dashboard.js session guard ran first
  setTimeout(initAdminDashboard, 200);
});
