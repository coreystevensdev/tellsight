-- One-time setup for the RDS instance, mirrors docker/init.sql (local dev).
-- Run once via psql after `terraform apply`, BEFORE the first deploy runs
-- migrations -- ALTER DEFAULT PRIVILEGES only covers tables created after this
-- script runs, so app_user would be missing grants on any table migrations
-- create first. See infra/README.md for the full ordering.
--
-- app_admin (RDS master user, rds.tf) = owns the DB, runs migrations, bypasses RLS
-- app_user = restricted role, RLS policies apply to all queries

CREATE ROLE app_user LOGIN PASSWORD 'REPLACE_WITH_A_REAL_PASSWORD';
GRANT CONNECT ON DATABASE analytics TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- app_admin is the RDS master user (rds.tf username = "app_admin"), just make
-- BYPASSRLS explicit like docker/init.sql does for the local admin role.
ALTER ROLE app_admin BYPASSRLS;
