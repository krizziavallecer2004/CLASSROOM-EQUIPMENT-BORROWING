-- ==============================================================
-- phase2_schema.sql
-- CEBS Phase 2 — Tables, RLS Policies & RPC Functions
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- ==============================================================


-- ==============================================================
-- TABLE 1: categories
-- Equipment categories (AV, Computing, Lab, etc.)
-- ==============================================================
CREATE TABLE IF NOT EXISTS public.categories (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  category_name TEXT        NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default categories
INSERT INTO public.categories (category_name) VALUES
  ('AV Equipment'),
  ('Computing'),
  ('Laboratory'),
  ('Sports'),
  ('General')
ON CONFLICT (category_name) DO NOTHING;


-- ==============================================================
-- TABLE 2: equipment
-- Individual equipment items in the inventory
-- ==============================================================
CREATE TABLE IF NOT EXISTS public.equipment (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  serial_number TEXT        UNIQUE,
  category_id   UUID        REFERENCES public.categories(id) ON DELETE SET NULL,
  status        TEXT        NOT NULL DEFAULT 'Available'
                            CHECK (status IN ('Available', 'Borrowed', 'Maintenance', 'Archived')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_equipment_status      ON public.equipment (status);
CREATE INDEX IF NOT EXISTS idx_equipment_category    ON public.equipment (category_id);
CREATE INDEX IF NOT EXISTS idx_equipment_name_search ON public.equipment USING GIN (to_tsvector('english', name));


-- ==============================================================
-- TABLE 3: transactions
-- Borrow/return records — links users ↔ equipment
-- ==============================================================
CREATE TABLE IF NOT EXISTS public.transactions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES public.users(id)      ON DELETE CASCADE,
  equipment_id  UUID        NOT NULL REFERENCES public.equipment(id)  ON DELETE CASCADE,
  borrow_date   DATE        NOT NULL DEFAULT CURRENT_DATE,
  due_date      DATE        NOT NULL,
  return_date   DATE,                           -- NULL = still borrowed
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_txn_user      ON public.transactions (user_id);
CREATE INDEX IF NOT EXISTS idx_txn_equipment ON public.transactions (equipment_id);
CREATE INDEX IF NOT EXISTS idx_txn_overdue   ON public.transactions (due_date) WHERE return_date IS NULL;


-- ==============================================================
-- TABLE 4: system_logs
-- Audit trail of every important action
-- ==============================================================
CREATE TABLE IF NOT EXISTS public.system_logs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type   TEXT        NOT NULL,   -- e.g. 'BORROW', 'RETURN', 'CREATE_EQUIPMENT', 'DELETE_USER'
  performed_by  UUID        REFERENCES public.users(id) ON DELETE SET NULL,
  details       JSONB,                  -- flexible payload for any extra context
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logs_action ON public.system_logs (action_type);
CREATE INDEX IF NOT EXISTS idx_logs_by     ON public.system_logs (performed_by);
CREATE INDEX IF NOT EXISTS idx_logs_time   ON public.system_logs (created_at DESC);


-- ==============================================================
-- ROW-LEVEL SECURITY
-- ==============================================================

ALTER TABLE public.categories  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equipment   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs  ENABLE ROW LEVEL SECURITY;

-- Categories: everyone authenticated can read; only admins write
CREATE POLICY "All authenticated can read categories"
  ON public.categories FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins manage categories"
  ON public.categories FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Equipment: everyone authenticated can read; only admins write
CREATE POLICY "All authenticated can read equipment"
  ON public.equipment FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins manage equipment"
  ON public.equipment FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Transactions: users see their own; admins see all
CREATE POLICY "Users view own transactions"
  ON public.transactions FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());
CREATE POLICY "Authenticated users can borrow (insert)"
  ON public.transactions FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.is_admin());
CREATE POLICY "Admins manage all transactions"
  ON public.transactions FOR UPDATE TO authenticated
  USING (public.is_admin());
CREATE POLICY "Admins delete transactions"
  ON public.transactions FOR DELETE TO authenticated
  USING (public.is_admin());

-- System logs: admins only
CREATE POLICY "Admins read logs"
  ON public.system_logs FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Authenticated can insert logs"
  ON public.system_logs FOR INSERT TO authenticated WITH CHECK (true);


-- ==============================================================
-- RPC 1: get_dashboard_stats
-- Returns all four KPI values in a single call.
-- Uses COUNT aggregation + JOIN across transactions, users, equipment.
-- ==============================================================
CREATE OR REPLACE FUNCTION public.get_dashboard_stats()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_total_users      INT;
  v_total_equipment  INT;
  v_active_borrows   INT;
  v_overdue          INT;
BEGIN
  -- Total registered users
  SELECT COUNT(*) INTO v_total_users FROM public.users;

  -- Total equipment items (excluding archived)
  SELECT COUNT(*) INTO v_total_equipment
  FROM public.equipment
  WHERE status != 'Archived';

  -- Active borrows: transactions with no return_date (JOIN with users + equipment)
  SELECT COUNT(*) INTO v_active_borrows
  FROM public.transactions t
  JOIN public.users      u ON u.id = t.user_id
  JOIN public.equipment  e ON e.id = t.equipment_id
  WHERE t.return_date IS NULL;

  -- Overdue: active borrows where due_date has passed
  SELECT COUNT(*) INTO v_overdue
  FROM public.transactions t
  JOIN public.users      u ON u.id = t.user_id
  JOIN public.equipment  e ON e.id = t.equipment_id
  WHERE t.return_date IS NULL
    AND t.due_date < CURRENT_DATE;

  RETURN json_build_object(
    'total_users',     v_total_users,
    'total_equipment', v_total_equipment,
    'active_borrows',  v_active_borrows,
    'overdue',         v_overdue
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_dashboard_stats() TO authenticated;


-- ==============================================================
-- RPC 2: get_overdue_borrowers
-- Subquery-based: finds users with at least one overdue item.
-- ==============================================================
CREATE OR REPLACE FUNCTION public.get_overdue_borrowers()
RETURNS TABLE (
  user_id    UUID,
  full_name  TEXT,
  username   TEXT,
  role       TEXT,
  overdue_count BIGINT,
  oldest_due_date DATE
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  -- Outer query: user profile details
  SELECT
    u.id          AS user_id,
    u.full_name,
    u.username,
    u.role,
    -- Subquery: count overdue items per user
    (SELECT COUNT(*)
     FROM public.transactions t2
     WHERE t2.user_id     = u.id
       AND t2.return_date IS NULL
       AND t2.due_date    < CURRENT_DATE
    ) AS overdue_count,
    -- Subquery: oldest unpaid due date
    (SELECT MIN(t3.due_date)
     FROM public.transactions t3
     WHERE t3.user_id     = u.id
       AND t3.return_date IS NULL
       AND t3.due_date    < CURRENT_DATE
    ) AS oldest_due_date
  FROM public.users u
  -- Filter: only users who appear in the overdue subquery
  WHERE u.id IN (
    SELECT DISTINCT t.user_id
    FROM   public.transactions t
    WHERE  t.return_date IS NULL
      AND  t.due_date < CURRENT_DATE
  )
  ORDER BY overdue_count DESC, oldest_due_date ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_overdue_borrowers() TO authenticated;


-- ==============================================================
-- RPC 3: get_monthly_report
-- CTE-based: total borrows per category for the current month.
-- ==============================================================
CREATE OR REPLACE FUNCTION public.get_monthly_report()
RETURNS TABLE (
  category_name  TEXT,
  total_borrows  BIGINT,
  active_borrows BIGINT,
  returned       BIGINT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  -- CTE 1: this month's transactions
  WITH monthly_txns AS (
    SELECT
      t.id,
      t.return_date,
      e.category_id
    FROM public.transactions t
    JOIN public.equipment e ON e.id = t.equipment_id
    WHERE DATE_TRUNC('month', t.borrow_date) = DATE_TRUNC('month', CURRENT_DATE)
  ),
  -- CTE 2: aggregate per category
  category_stats AS (
    SELECT
      mt.category_id,
      COUNT(*)                                        AS total_borrows,
      COUNT(*) FILTER (WHERE mt.return_date IS NULL)  AS active_borrows,
      COUNT(*) FILTER (WHERE mt.return_date IS NOT NULL) AS returned
    FROM monthly_txns mt
    GROUP BY mt.category_id
  )
  -- Final SELECT: join with categories for the human-readable name
  SELECT
    COALESCE(c.category_name, 'Uncategorised') AS category_name,
    cs.total_borrows,
    cs.active_borrows,
    cs.returned
  FROM category_stats cs
  LEFT JOIN public.categories c ON c.id = cs.category_id
  ORDER BY cs.total_borrows DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_monthly_report() TO authenticated;


-- ==============================================================
-- RPC 4: log_action  (helper called from JS after every mutation)
-- ==============================================================
CREATE OR REPLACE FUNCTION public.log_action(
  p_action_type TEXT,
  p_details     JSONB DEFAULT '{}'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.system_logs (action_type, performed_by, details)
  VALUES (p_action_type, auth.uid(), p_details);
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_action(TEXT, JSONB) TO authenticated;
