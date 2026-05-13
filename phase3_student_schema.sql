-- ==============================================================
-- phase3_student_schema.sql
-- CEBS Phase 3 — Add `status` column to transactions table
--
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- This is additive — safe to run on existing data.
-- ==============================================================


-- ── Add status column to transactions ────────────────────────
-- Tracks the lifecycle of a borrow request:
--   Pending  → submitted by student, awaiting admin action
--   Borrowed → approved by admin, item is with the student
--   Returned → item has been physically returned
--   Rejected → admin declined the request

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'Borrowed', 'Returned', 'Rejected'));

-- Index for fast status-based lookups (e.g. "all pending requests")
CREATE INDEX IF NOT EXISTS idx_txn_status ON public.transactions (status);


-- ── Back-fill existing rows ───────────────────────────────────
-- Rows that already have a return_date → mark as Returned
UPDATE public.transactions
  SET status = 'Returned'
  WHERE return_date IS NOT NULL AND status = 'Pending';

-- Rows without return_date that were already "active" → mark as Borrowed
-- (These existed before the status column — assume they were approved)
UPDATE public.transactions
  SET status = 'Borrowed'
  WHERE return_date IS NULL AND status = 'Pending'
    AND borrow_date < CURRENT_DATE;


-- ==============================================================
-- RPC: get_student_stats
-- Returns the three KPI values for a specific student.
-- Called from student.js to populate the stat cards.
-- ==============================================================
CREATE OR REPLACE FUNCTION public.get_student_stats(p_user_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_current_borrows INT;
  v_due_soon        INT;
  v_total_borrowed  INT;
BEGIN
  -- Current Borrows: items the student actively has (status = 'Borrowed')
  SELECT COUNT(*) INTO v_current_borrows
  FROM public.transactions
  WHERE user_id     = p_user_id
    AND status      = 'Borrowed'
    AND return_date IS NULL;

  -- Due Soon: Borrowed items due within the next 48 hours
  SELECT COUNT(*) INTO v_due_soon
  FROM public.transactions
  WHERE user_id     = p_user_id
    AND status      = 'Borrowed'
    AND return_date IS NULL
    AND due_date    BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '2 days';

  -- Total Borrowed: historical — all ever-approved borrows
  SELECT COUNT(*) INTO v_total_borrowed
  FROM public.transactions
  WHERE user_id = p_user_id
    AND status  IN ('Borrowed', 'Returned');

  RETURN json_build_object(
    'current_borrows', v_current_borrows,
    'due_soon',        v_due_soon,
    'total_borrowed',  v_total_borrowed
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_student_stats(UUID) TO authenticated;


-- ==============================================================
-- RLS: students can UPDATE their own pending transactions
-- (allows future "cancel request" feature)
-- ==============================================================
CREATE POLICY IF NOT EXISTS "Students can cancel own pending requests"
  ON public.transactions FOR UPDATE TO authenticated
  USING  (user_id = auth.uid() AND status = 'Pending')
  WITH CHECK (user_id = auth.uid());
