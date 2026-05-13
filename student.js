/**
 * student.js
 * ===========
 * Student Dashboard — Full Functional Logic
 *
 * Modules:
 *  1. KPI Stats Cards   — Current Borrows, Due Soon (48 h), Total Borrowed
 *  2. Equipment Browser — Fetch available items, search, category filter
 *  3. Borrow Workflow   — Modal → insert into `transactions`
 *  4. Borrow History    — Show the student's own transaction log + derived status
 *
 * NOTE: Works with the base schema (no `status` column on transactions).
 * Status is derived from return_date / due_date at runtime:
 *   return_date IS NOT NULL          → Returned
 *   return_date IS NULL + overdue    → Overdue
 *   return_date IS NULL + active     → Active
 *
 * Depends on: supabase.js (supabaseClient), dashboard.js (showToast, session guard)
 */

/* ============================================================
   MODULE-LEVEL STATE
   ============================================================ */
let currentUserId      = null;   // UUID of the logged-in student
let allEquipment       = [];     // Full list fetched from Supabase
let pendingEquipmentId = null;   // Equipment selected for borrow request
let submitInProgress   = false;  // Debounce guard for modal submit

/* ============================================================
   UTILITY — Date helpers
   ============================================================ */

/**
 * Format a date string as a human-readable short date, e.g. "May 15, 2025".
 */
function fmtDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

/**
 * Returns true if `dateStr` falls within the next 48 hours from now.
 */
function isDueSoon(dateStr) {
  if (!dateStr) return false;
  const due  = new Date(dateStr + 'T23:59:59');
  const now  = new Date();
  const diff = due - now;
  return diff > 0 && diff <= 48 * 60 * 60 * 1000;
}

/**
 * Returns true if `dateStr` is strictly in the past.
 */
function isOverdue(dateStr) {
  if (!dateStr) return false;
  return new Date(dateStr + 'T23:59:59') < new Date();
}

/**
 * Returns tomorrow's date in YYYY-MM-DD format.
 */
function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Derives a display status string from a transaction row.
 * Reads the [STATUS:tag] embedded in notes by the student/admin workflow,
 * then falls back to return_date / due_date for legacy rows.
 *
 * @param {{ return_date: string|null, due_date: string, notes: string|null }} txn
 * @returns {'Pending'|'Approved'|'Rejected'|'Returned'|'Active'|'Overdue'}
 */
function deriveStatus(txn) {
  // Check for embedded status tag in notes (set by student/admin workflow)
  const match = (txn.notes || '').match(/^\[STATUS:(\w+)\]/);
  if (match) {
    const tag = match[1]; // Pending | Approved | Rejected | Returned
    // If admin set Returned tag but no return_date yet, trust the tag
    return tag;
  }
  // Legacy fallback: derive from dates
  if (txn.return_date) return 'Returned';
  if (isOverdue(txn.due_date)) return 'Overdue';
  return 'Active';
}

/* ============================================================
   MODULE 1 — KPI STATS CARDS
   ============================================================ */

async function loadStudentStats() {
  // Mark values as loading
  ['kpi-student-borrows', 'kpi-due-soon', 'kpi-total-borrowed'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = '…'; el.classList.add('loading'); }
  });

  try {
    // Fetch all of the student's transactions — no status column needed
    const { data: txns, error } = await supabaseClient
      .from('transactions')
      .select('id, borrow_date, due_date, return_date')
      .eq('user_id', currentUserId);

    if (error) throw error;

    const rows = txns || [];

    // Current Borrows: actively borrowed (not yet returned)
    const currentBorrows = rows.filter(t => !t.return_date).length;

    // Due Soon: active borrows with due_date in next 48 h
    const dueSoon = rows.filter(t => !t.return_date && isDueSoon(t.due_date)).length;

    // Total Borrowed: every transaction ever (historical)
    const totalBorrowed = rows.length;

    setKpi('kpi-student-borrows', currentBorrows);
    setKpi('kpi-due-soon',        dueSoon);
    setKpi('kpi-total-borrowed',  totalBorrowed);

  } catch (err) {
    console.error('[Stats] Error loading KPIs:', err);
    ['kpi-student-borrows', 'kpi-due-soon', 'kpi-total-borrowed'].forEach(id =>
      setKpi(id, '!')
    );
    showToast('Could not load dashboard stats.', 'error');
  }
}

function setKpi(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  el.classList.remove('loading');
}

/* ============================================================
   MODULE 2 — EQUIPMENT BROWSER
   ============================================================ */

async function loadEquipment() {
  const grid = document.getElementById('equipment-grid');
  if (!grid) return;

  grid.innerHTML = `<div class="eq-empty-state">
    <div class="spinner-inline"></div>
    <p>Loading equipment…</p>
  </div>`;

  try {
    const { data, error } = await supabaseClient
      .from('equipment')
      .select(`
        id, name, serial_number, status, notes,
        categories ( category_name )
      `)
      .eq('status', 'Available')
      .order('name', { ascending: true });

    if (error) throw error;

    allEquipment = data || [];
    populateCategoryFilter(allEquipment);
    applyEquipmentFilters();

  } catch (err) {
    console.error('[Equipment] Error loading equipment:', err);
    grid.innerHTML = `<div class="eq-empty-state">
      <span class="eq-empty-icon">⚠️</span>
      <p>Failed to load equipment. Please refresh.</p>
    </div>`;
    showToast('Could not load equipment list.', 'error');
  }
}

function populateCategoryFilter(equipmentList) {
  const select = document.getElementById('eq-category-filter');
  if (!select) return;

  const categories = [
    ...new Set(
      equipmentList
        .map(e => e.categories?.category_name)
        .filter(Boolean)
    ),
  ].sort();

  const current = select.value;
  select.innerHTML = '<option value="">All Categories</option>';
  categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    select.appendChild(opt);
  });
  if (current && categories.includes(current)) select.value = current;
}

function applyEquipmentFilters() {
  const query    = (document.getElementById('eq-search')?.value || '').toLowerCase().trim();
  const category = document.getElementById('eq-category-filter')?.value || '';

  const filtered = allEquipment.filter(item => {
    const matchesSearch =
      !query ||
      item.name.toLowerCase().includes(query) ||
      (item.categories?.category_name || '').toLowerCase().includes(query);

    const matchesCategory =
      !category || item.categories?.category_name === category;

    return matchesSearch && matchesCategory;
  });

  renderEquipmentGrid(filtered);
}

const CATEGORY_ICONS = {
  'AV Equipment': '📽️',
  'Computing':    '💻',
  'Laboratory':   '🔬',
  'Sports':       '⚽',
  'General':      '📦',
};

function renderEquipmentGrid(items) {
  const grid = document.getElementById('equipment-grid');
  if (!grid) return;

  if (items.length === 0) {
    grid.innerHTML = `<div class="eq-empty-state">
      <span class="eq-empty-icon">${allEquipment.length === 0 ? '📦' : '🔍'}</span>
      <p>${allEquipment.length === 0
        ? 'No equipment is currently available.'
        : 'No items match your search.'}</p>
    </div>`;
    return;
  }

  grid.innerHTML = '';
  items.forEach((item, index) => {
    const catName = item.categories?.category_name || 'General';
    const icon    = CATEGORY_ICONS[catName] || '📦';

    const card = document.createElement('div');
    card.className = 'eq-card';
    card.style.animationDelay = `${index * 40}ms`;

    card.innerHTML = `
      <div class="eq-card-icon">${icon}</div>
      <div class="eq-card-name">${escapeHtml(item.name)}</div>
      <div class="eq-card-meta">
        <span class="eq-badge eq-badge--category">${escapeHtml(catName)}</span>
        <span class="eq-badge eq-badge--available">✓ Available</span>
        ${item.serial_number
          ? `<span class="eq-badge eq-badge--serial">S/N: ${escapeHtml(item.serial_number)}</span>`
          : ''}
      </div>
      ${item.notes
        ? `<p class="eq-card-notes">${escapeHtml(item.notes)}</p>`
        : ''}
      <button
        class="btn-borrow-request"
        id="borrow-btn-${item.id}"
        aria-label="Request to borrow ${escapeHtml(item.name)}"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Request Borrow
      </button>
    `;

    card.querySelector('.btn-borrow-request').addEventListener('click', () => {
      openBorrowModal(item.id, item.name);
    });

    grid.appendChild(card);
  });
}

/* ============================================================
   MODULE 3 — BORROW WORKFLOW (Modal)
   ============================================================ */

function openBorrowModal(equipmentId, equipmentName) {
  pendingEquipmentId = equipmentId;

  const modal     = document.getElementById('borrow-modal');
  const nameEl    = document.getElementById('modal-equipment-name');
  const dueDateEl = document.getElementById('modal-due-date');
  const notesEl   = document.getElementById('modal-notes');
  const submitBtn = document.getElementById('modal-submit-btn');

  if (!modal) return;

  if (nameEl)    nameEl.textContent = equipmentName;
  if (dueDateEl) { dueDateEl.min = tomorrowISO(); dueDateEl.value = ''; }
  if (notesEl)   notesEl.value = '';

  if (submitBtn) {
    submitBtn.disabled  = false;
    submitBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      Submit Request`;
  }

  modal.removeAttribute('hidden');
  dueDateEl?.focus();
}

function closeBorrowModal() {
  const modal = document.getElementById('borrow-modal');
  if (modal) modal.setAttribute('hidden', '');
  pendingEquipmentId = null;
}

async function submitBorrowRequest() {
  if (submitInProgress || !pendingEquipmentId) return;

  const dueDateEl = document.getElementById('modal-due-date');
  const notesEl   = document.getElementById('modal-notes');
  const submitBtn = document.getElementById('modal-submit-btn');

  if (!dueDateEl?.value) {
    showToast('Please select a return date.', 'error');
    dueDateEl?.focus();
    return;
  }

  if (dueDateEl.value < tomorrowISO()) {
    showToast('Due date must be at least tomorrow.', 'error');
    dueDateEl?.focus();
    return;
  }

  submitInProgress = true;

  if (submitBtn) {
    submitBtn.disabled  = true;
    submitBtn.innerHTML = `<span class="btn-spinner"></span> Submitting…`;
  }

  try {
    const today = new Date().toISOString().slice(0, 10);

    // Insert without `status` column — works on the base schema.
    // We prefix the notes with [STATUS:Pending] so the admin dashboard
    // can identify this as a pending approval request.
    const userNote = notesEl?.value?.trim() || '';
    const taggedNote = userNote ? `[STATUS:Pending] ${userNote}` : '[STATUS:Pending]';

    const { error } = await supabaseClient
      .from('transactions')
      .insert({
        user_id:      currentUserId,
        equipment_id: pendingEquipmentId,
        borrow_date:  today,
        due_date:     dueDateEl.value,
        return_date:  null,
        notes:        taggedNote,
      });

    if (error) throw error;

    // Log the action (non-critical — ignore failures).
    // Wrap in Promise.resolve() because Supabase v2 returns a thenable,
    // not a native Promise, so bare .catch() is not available on it.
    Promise.resolve(
      supabaseClient.rpc('log_action', {
        p_action_type: 'BORROW_REQUEST',
        p_details: {
          equipment_id: pendingEquipmentId,
          due_date:     dueDateEl.value,
          requested_by: currentUserId,
        },
      })
    ).catch(() => {});

    showToast('Borrow request submitted! Awaiting admin approval.', 'success', 4500);
    closeBorrowModal();

    // Refresh stats + history
    await Promise.all([loadStudentStats(), loadBorrowHistory()]);

  } catch (err) {
    console.error('[Borrow] Submit error:', err);
    showToast(err.message || 'Failed to submit request. Please try again.', 'error');

    if (submitBtn) {
      submitBtn.disabled  = false;
      submitBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        Submit Request`;
    }
  } finally {
    submitInProgress = false;
  }
}

/* ============================================================
   MODULE 4 — BORROW HISTORY TABLE
   ============================================================ */

async function loadBorrowHistory() {
  const tbody = document.getElementById('history-tbody');
  if (!tbody) return;

  tbody.innerHTML = `<tr>
    <td colspan="6" class="table-loading">
      <div class="spinner-inline"></div> Loading history…
    </td>
  </tr>`;

  try {
    // Select only columns guaranteed to exist in the base schema
    const { data: txns, error } = await supabaseClient
      .from('transactions')
      .select(`
        id, borrow_date, due_date, return_date, notes,
        equipment:equipment_id (
          name, serial_number,
          categories ( category_name )
        )
      `)
      .eq('user_id', currentUserId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    if (!txns || txns.length === 0) {
      tbody.innerHTML = `<tr class="table-empty-row">
        <td colspan="6">
          <span style="font-size:1.5rem">📭</span><br/>
          You haven't made any borrow requests yet.
        </td>
      </tr>`;
      return;
    }

    tbody.innerHTML = '';
    txns.forEach(txn => {
      const tr = document.createElement('tr');
      tr.innerHTML = buildHistoryRow(txn);
      tbody.appendChild(tr);
    });

  } catch (err) {
    console.error('[History] Error loading borrow history:', err);
    tbody.innerHTML = `<tr class="table-empty-row">
      <td colspan="6">⚠️ Failed to load history. Please refresh.</td>
    </tr>`;
    showToast('Could not load borrow history.', 'error');
  }
}

const STATUS_CLASS = {
  'Pending':  'status-badge--pending',
  'Approved': 'status-badge--approved',
  'Rejected': 'status-badge--overdue',   // red for rejected
  'Active':   'status-badge--approved',
  'Overdue':  'status-badge--overdue',
  'Returned': 'status-badge--returned',
};

function buildHistoryRow(txn) {
  const eqName   = txn.equipment?.name           || '(Deleted item)';
  const serial   = txn.equipment?.serial_number;
  const catName  = txn.equipment?.categories?.category_name || '—';
  const status   = deriveStatus(txn);
  const badgeCls = STATUS_CLASS[status] || 'status-badge--approved';

  const overdueStyle   = status === 'Overdue' ? 'style="color:#ff7b72;font-weight:600;"' : '';
  const overdueRowAttr = status === 'Overdue' ? 'style="background:rgba(248,81,73,.04);"' : '';

  return `
    <td ${overdueRowAttr}>
      <div class="eq-name-cell">${escapeHtml(eqName)}</div>
      ${serial ? `<div class="eq-serial-cell">S/N: ${escapeHtml(serial)}</div>` : ''}
    </td>
    <td>${escapeHtml(catName)}</td>
    <td>${fmtDate(txn.borrow_date)}</td>
    <td ${overdueStyle}>${fmtDate(txn.due_date)}</td>
    <td>${fmtDate(txn.return_date)}</td>
    <td><span class="status-badge ${badgeCls}">${status}</span></td>
  `;
}

/* ============================================================
   UTILITY — XSS-safe text escaping
   ============================================================ */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ============================================================
   BOOTSTRAP
   ============================================================ */
async function initStudentDashboard() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return; // dashboard.js handles redirect

  currentUserId = session.user.id;

  // Fetch all data in parallel
  await Promise.all([
    loadStudentStats(),
    loadEquipment(),
    loadBorrowHistory(),
  ]);

  // Search & filter
  document.getElementById('eq-search')
    ?.addEventListener('input', applyEquipmentFilters);
  document.getElementById('eq-category-filter')
    ?.addEventListener('change', applyEquipmentFilters);

  // Refresh buttons
  document.getElementById('btn-refresh-equipment')
    ?.addEventListener('click', loadEquipment);
  document.getElementById('btn-refresh-history')
    ?.addEventListener('click', () => Promise.all([loadBorrowHistory(), loadStudentStats()]));

  // Modal controls
  document.getElementById('modal-close-btn')
    ?.addEventListener('click', closeBorrowModal);
  document.getElementById('modal-cancel-btn')
    ?.addEventListener('click', closeBorrowModal);
  document.getElementById('modal-submit-btn')
    ?.addEventListener('click', submitBorrowRequest);
  document.getElementById('modal-due-date')
    ?.addEventListener('keydown', e => { if (e.key === 'Enter') submitBorrowRequest(); });

  // Close modal on backdrop click or Escape
  document.getElementById('borrow-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('borrow-modal')) closeBorrowModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeBorrowModal();
  });
}

// Small delay to let dashboard.js auth guard finish first
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(initStudentDashboard, 300);
});
