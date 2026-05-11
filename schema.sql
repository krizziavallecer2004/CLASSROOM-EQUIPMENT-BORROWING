-- ==============================================================
-- schema.sql
-- Classroom Equipment Borrowing System — Supabase Database Setup
--
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ==============================================================


-- ==============================================================
-- TABLE: public.users  (Public Profile / "User Profiles" table)
--
-- This table mirrors each row in auth.users and stores the
-- app-specific data (username, full name, role).
-- Linked to auth.users via a Foreign Key on `id`.
-- ==============================================================

CREATE TABLE IF NOT EXISTS public.users (
  -- Primary key = the auth user's UUID (set automatically on signup)
  id          UUID        PRIMARY KEY DEFAULT auth.uid()
                          REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Username must be unique (used as the login identifier in the UI)
  username    TEXT        NOT NULL UNIQUE,

  -- Display name for the dashboard
  full_name   TEXT        NOT NULL,

  -- Role determines which dashboard the user is redirected to
  role        TEXT        NOT NULL
                          CHECK (role IN ('Admin', 'Teacher', 'Student')),

  -- Automatic timestamp
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on username for fast lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON public.users (username);

-- Index on role for efficient role-based queries / reports
CREATE INDEX IF NOT EXISTS idx_users_role ON public.users (role);


-- ==============================================================
-- ROW-LEVEL SECURITY (RLS)
-- Enable RLS so that Supabase only returns rows the caller is
-- authorised to see.
-- ==============================================================

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Allow every authenticated user to read their OWN profile row
CREATE POLICY "Users can view own profile"
  ON public.users
  FOR SELECT
  USING (auth.uid() = id);

-- Allow every authenticated user to update their OWN profile row
CREATE POLICY "Users can update own profile"
  ON public.users
  FOR UPDATE
  USING (auth.uid() = id);

-- Admins can read ALL profiles (needed for the admin dashboard)
CREATE POLICY "Admins can view all profiles"
  ON public.users
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM   public.users AS u
      WHERE  u.id   = auth.uid()
        AND  u.role = 'Admin'
    )
  );

-- Admins can insert new profiles (user management)
CREATE POLICY "Admins can insert profiles"
  ON public.users
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM   public.users AS u
      WHERE  u.id   = auth.uid()
        AND  u.role = 'Admin'
    )
  );

-- Admins can delete profiles
CREATE POLICY "Admins can delete profiles"
  ON public.users
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM   public.users AS u
      WHERE  u.id   = auth.uid()
        AND  u.role = 'Admin'
    )
  );


-- ==============================================================
-- TRIGGER: auto_create_user_profile
--
-- When a new user signs up via Supabase Auth (auth.users),
-- this trigger inserts a skeleton row into public.users.
-- The username defaults to the email prefix (before the @).
-- Full name and role can be updated later by the admin.
--
-- This ensures every auth user has a matching public profile.
-- ==============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (id, username, full_name, role)
  VALUES (
    NEW.id,
    -- Strip the @cebs.local suffix to get the username
    SPLIT_PART(NEW.email, '@', 1),
    -- Default full_name = raw_user_meta_data->>'full_name' if provided,
    -- otherwise fall back to the username
    COALESCE(NEW.raw_user_meta_data->>'full_name', SPLIT_PART(NEW.email, '@', 1)),
    -- Default role; the Admin can update this via the admin dashboard
    COALESCE(NEW.raw_user_meta_data->>'role', 'Student')
  )
  ON CONFLICT (id) DO NOTHING;  -- Prevent duplicate-insert errors

  RETURN NEW;
END;
$$;

-- Attach the trigger to auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();


-- ==============================================================
-- SAMPLE DATA  (optional — remove before production)
-- Creates 3 test accounts, one per role.
--
-- ⚠  You must first create these users in Supabase Auth
--    (Authentication → Users → Invite / Create User)
--    using the emails below, then their UUIDs will be in auth.users.
--    The trigger above will create matching public.users rows.
--
-- Alternatively, use Supabase's Admin API or the Dashboard to
-- sign up users, then UPDATE public.users to set the correct role.
-- ==============================================================

/*
-- Example: manually set roles after auth accounts exist
UPDATE public.users SET role = 'Admin',   full_name = 'System Administrator'
WHERE username = 'admin';

UPDATE public.users SET role = 'Teacher', full_name = 'Ms. Maria Santos'
WHERE username = 'msantos';

UPDATE public.users SET role = 'Student', full_name = 'Juan Dela Cruz'
WHERE username = 'jdelacruz';
*/


-- ==============================================================
-- HELPER RPC FUNCTION: get_user_role
--
-- Called from JavaScript via supabaseClient.rpc('get_user_role')
-- Returns the role for the currently authenticated user.
-- Useful for row-level permission checks on the client.
-- ==============================================================

CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT role
  FROM   public.users
  WHERE  id = auth.uid()
  LIMIT  1;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_role() TO authenticated;


-- ==============================================================
-- FUTURE TABLES (stubs for the borrowing system)
-- Uncomment and extend when you build those modules.
-- ==============================================================

/*
-- Equipment catalogue
CREATE TABLE IF NOT EXISTS public.equipment (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  description TEXT,
  quantity    INT         NOT NULL DEFAULT 1,
  available   INT         NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Borrow requests / transactions
CREATE TABLE IF NOT EXISTS public.borrow_requests (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id   UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  equipment_id   UUID        NOT NULL REFERENCES public.equipment(id) ON DELETE RESTRICT,
  status         TEXT        NOT NULL DEFAULT 'Pending'
                             CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Returned', 'Overdue')),
  borrow_date    DATE,
  return_date    DATE,
  actual_return  DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
*/
