import { createHash } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import type { WorkspaceSql } from "./postgres";

interface WorkspaceServerMigration {
  version: number;
  name: string;
  statements: readonly string[];
}

const migrations: readonly WorkspaceServerMigration[] = [
  {
    version: 1,
    name: "workspace_server_postgres_rls_foundation",
    statements: [
      "CREATE EXTENSION IF NOT EXISTS pg_trgm",
      `CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'read_only', 'archived')),
        hosting_mode TEXT NOT NULL CHECK (hosting_mode IN ('hosted', 'self_host')),
        storage_namespace TEXT NOT NULL UNIQUE,
        database_placement TEXT NOT NULL CHECK (database_placement IN ('shared', 'dedicated')),
        created_by TEXT NOT NULL,
        version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE workspace_members (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        account_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')) DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ,
        PRIMARY KEY (workspace_id, account_id)
      )`,
      `CREATE TABLE rooms (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id)
      )`,
      `CREATE TABLE room_members (
        workspace_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')) DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ,
        PRIMARY KEY (workspace_id, room_id, account_id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_records (
        workspace_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        record_type TEXT NOT NULL,
        id TEXT NOT NULL,
        version BIGINT NOT NULL CHECK (version > 0),
        payload JSONB NOT NULL,
        search_text TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, record_type, id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      "CREATE INDEX workspace_records_room_index ON workspace_records(workspace_id, room_id, record_type, updated_at DESC)",
      "CREATE INDEX workspace_records_search_index ON workspace_records USING GIN (search_text gin_trgm_ops)",
      `CREATE TABLE workspace_files (
        workspace_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        path TEXT NOT NULL,
        version BIGINT NOT NULL CHECK (version > 0),
        sha256 TEXT NOT NULL,
        size BIGINT NOT NULL CHECK (size >= 0),
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, path),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_file_transactions (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        target_path TEXT NOT NULL,
        staged_path TEXT NOT NULL,
        previous_file JSONB,
        next_file JSONB NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('db_committed', 'renamed', 'rolled_back')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      "CREATE INDEX workspace_file_transactions_recovery_index ON workspace_file_transactions(workspace_id, status, created_at)",
      `CREATE TABLE workspace_operations (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        actor_account_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        result JSONB,
        error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, idempotency_key)
      )`,
      `CREATE TABLE workspace_events (
        id BIGSERIAL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        record_type TEXT,
        record_id TEXT,
        operation_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      "CREATE INDEX workspace_events_replay_index ON workspace_events(workspace_id, room_id, id)",
      `CREATE TABLE workspace_jobs (
        workspace_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'blocked')),
        version BIGINT NOT NULL CHECK (version > 0),
        idempotency_key TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, idempotency_key),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      "CREATE INDEX workspace_jobs_due_index ON workspace_jobs(workspace_id, room_id, status, updated_at)",
      `CREATE TABLE workspace_invitations (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        room_id TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        workspace_role TEXT NOT NULL CHECK (workspace_role IN ('owner', 'admin', 'member', 'guest')),
        room_role TEXT CHECK (room_role IN ('owner', 'admin', 'member', 'guest')),
        created_by TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        accepted_by TEXT,
        accepted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      "CREATE INDEX workspace_invitations_lookup_index ON workspace_invitations(workspace_id, token_hash, expires_at) WHERE revoked_at IS NULL AND accepted_at IS NULL",
      `CREATE TABLE workspace_transfers (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('preparing', 'exported', 'imported', 'committed', 'rolled_back', 'failed')),
        bundle_path TEXT,
        bundle_hash TEXT,
        initiated_by TEXT NOT NULL,
        error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id)
      )`,
      `CREATE TABLE workspace_bundles (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        format_version INTEGER NOT NULL CHECK (format_version = 3),
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        record_counts JSONB NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id)
      )`,
      "CREATE INDEX workspace_bundles_latest_index ON workspace_bundles(workspace_id, created_at DESC)",
      `CREATE OR REPLACE FUNCTION samurai_context_value(setting_name TEXT)
      RETURNS TEXT LANGUAGE SQL STABLE AS $$
        SELECT NULLIF(current_setting(setting_name, true), '')
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_current_account_id()
      RETURNS TEXT LANGUAGE SQL STABLE AS $$
        SELECT samurai_context_value('samurai.account_id')
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_current_workspace_id()
      RETURNS TEXT LANGUAGE SQL STABLE AS $$
        SELECT samurai_context_value('samurai.workspace_id')
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_is_bootstrap()
      RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT samurai_context_value('samurai.bootstrap') = '1'
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_role_rank(role_name TEXT)
      RETURNS INTEGER LANGUAGE SQL IMMUTABLE AS $$
        SELECT CASE role_name
          WHEN 'owner' THEN 3
          WHEN 'admin' THEN 2
          WHEN 'member' THEN 1
          WHEN 'guest' THEN 0
          ELSE -1
        END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_workspace_role(target_workspace_id TEXT)
      RETURNS TEXT
      LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT role
        FROM workspace_members
        WHERE workspace_id = target_workspace_id
          AND account_id = samurai_current_account_id()
          AND state = 'active'
        LIMIT 1
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_can_workspace(target_workspace_id TEXT, required_role TEXT)
      RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT samurai_role_rank(samurai_workspace_role(target_workspace_id)) >= samurai_role_rank(required_role)
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_room_role(target_workspace_id TEXT, target_room_id TEXT)
      RETURNS TEXT
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
      DECLARE workspace_role_name TEXT;
      BEGIN
        workspace_role_name := samurai_workspace_role(target_workspace_id);
        IF samurai_role_rank(workspace_role_name) >= samurai_role_rank('admin') THEN
          RETURN workspace_role_name;
        END IF;
        RETURN (
          SELECT role
          FROM room_members
          WHERE workspace_id = target_workspace_id
            AND room_id = target_room_id
            AND account_id = samurai_current_account_id()
            AND state = 'active'
          LIMIT 1
        );
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_can_room(target_workspace_id TEXT, target_room_id TEXT, action_name TEXT)
      RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT samurai_role_rank(samurai_room_role(target_workspace_id, target_room_id)) >=
          CASE action_name
            WHEN 'read' THEN 0
            WHEN 'notify' THEN 0
            WHEN 'edit' THEN 1
            WHEN 'execute' THEN 1
            WHEN 'manage' THEN 2
            WHEN 'owner' THEN 3
            ELSE 99
          END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_create_room(target_workspace_id TEXT, new_room_id TEXT, new_room_name TEXT)
      RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'member') THEN
          RAISE EXCEPTION 'workspace_permission_denied';
        END IF;
        INSERT INTO rooms(workspace_id, id, name, created_by)
        VALUES (target_workspace_id, new_room_id, new_room_name, samurai_current_account_id());
        INSERT INTO room_members(workspace_id, room_id, account_id, role, state)
        VALUES (target_workspace_id, new_room_id, samurai_current_account_id(), 'owner', 'active');
        RETURN new_room_id;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_set_workspace_member(
        target_workspace_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
          RAISE EXCEPTION 'workspace_permission_denied';
        END IF;
        IF target_role NOT IN ('owner', 'admin', 'member', 'guest') OR target_state NOT IN ('active', 'revoked') THEN
          RAISE EXCEPTION 'workspace_membership_invalid';
        END IF;
        IF target_role = 'owner' AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        IF target_state = 'revoked' AND target_account_id = samurai_current_account_id()
          AND samurai_workspace_role(target_workspace_id) = 'owner'
          AND (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = target_workspace_id AND role = 'owner' AND state = 'active') <= 1 THEN
          RAISE EXCEPTION 'workspace_last_owner_cannot_be_revoked';
        END IF;
        INSERT INTO workspace_members(workspace_id, account_id, role, state, revoked_at, updated_at)
        VALUES (target_workspace_id, target_account_id, target_role, target_state,
          CASE WHEN target_state = 'revoked' THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET
          role = EXCLUDED.role,
          state = EXCLUDED.state,
          revoked_at = EXCLUDED.revoked_at,
          updated_at = NOW();
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_set_room_member(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_room(target_workspace_id, target_room_id, 'manage') THEN
          RAISE EXCEPTION 'room_permission_denied';
        END IF;
        IF target_role NOT IN ('owner', 'admin', 'member', 'guest') OR target_state NOT IN ('active', 'revoked') THEN
          RAISE EXCEPTION 'room_membership_invalid';
        END IF;
        INSERT INTO room_members(workspace_id, room_id, account_id, role, state, revoked_at, updated_at)
        VALUES (target_workspace_id, target_room_id, target_account_id, target_role, target_state,
          CASE WHEN target_state = 'revoked' THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (workspace_id, room_id, account_id) DO UPDATE SET
          role = EXCLUDED.role,
          state = EXCLUDED.state,
          revoked_at = EXCLUDED.revoked_at,
          updated_at = NOW();
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_accept_invitation(target_workspace_id TEXT, supplied_token_hash TEXT)
      RETURNS TABLE(workspace_role TEXT, room_id TEXT, room_role TEXT)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE invitation workspace_invitations%ROWTYPE;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR samurai_current_account_id() IS NULL THEN
          RAISE EXCEPTION 'workspace_invitation_invalid';
        END IF;
        SELECT * INTO invitation
        FROM workspace_invitations
        WHERE workspace_id = target_workspace_id
          AND token_hash = supplied_token_hash
          AND revoked_at IS NULL
          AND accepted_at IS NULL
          AND expires_at > NOW()
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_invitation_invalid'; END IF;
        INSERT INTO workspace_members(workspace_id, account_id, role, state, updated_at)
        VALUES (target_workspace_id, samurai_current_account_id(), invitation.workspace_role, 'active', NOW())
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET
          role = CASE
            WHEN samurai_role_rank(EXCLUDED.role) > samurai_role_rank(workspace_members.role) THEN EXCLUDED.role
            ELSE workspace_members.role
          END,
          state = 'active', revoked_at = NULL, updated_at = NOW();
        IF invitation.room_id IS NOT NULL THEN
          INSERT INTO room_members(workspace_id, room_id, account_id, role, state, updated_at)
          VALUES (target_workspace_id, invitation.room_id, samurai_current_account_id(), COALESCE(invitation.room_role, invitation.workspace_role), 'active', NOW())
          ON CONFLICT (workspace_id, room_id, account_id) DO UPDATE SET
            role = CASE
              WHEN samurai_role_rank(EXCLUDED.role) > samurai_role_rank(room_members.role) THEN EXCLUDED.role
              ELSE room_members.role
            END,
            state = 'active', revoked_at = NULL, updated_at = NOW();
        END IF;
        UPDATE workspace_invitations
        SET accepted_by = samurai_current_account_id(), accepted_at = NOW()
        WHERE workspace_id = target_workspace_id AND id = invitation.id;
        RETURN QUERY SELECT invitation.workspace_role, invitation.room_id, invitation.room_role;
      END
      $$`
    ]
  },
  {
    version: 2,
    name: "workspace_server_row_level_security",
    statements: [
      "ALTER TABLE accounts ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE rooms ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE room_members ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_records ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_files ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_file_transactions ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_operations ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_events ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_jobs ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_invitations ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_transfers ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_bundles ENABLE ROW LEVEL SECURITY",
      "CREATE POLICY accounts_self ON accounts FOR ALL USING (id = samurai_current_account_id()) WITH CHECK (id = samurai_current_account_id())",
      `CREATE POLICY workspaces_read ON workspaces FOR SELECT USING (
        (samurai_current_workspace_id() IS NULL OR id = samurai_current_workspace_id())
        AND samurai_can_workspace(id, 'guest')
      )`,
      `CREATE POLICY workspaces_bootstrap_insert ON workspaces FOR INSERT WITH CHECK (
        samurai_is_bootstrap() AND id = samurai_current_workspace_id() AND created_by = samurai_current_account_id()
      )`,
      `CREATE POLICY workspaces_owner_update ON workspaces FOR UPDATE
        USING (id = samurai_current_workspace_id() AND samurai_can_workspace(id, 'owner'))
        WITH CHECK (id = samurai_current_workspace_id() AND samurai_can_workspace(id, 'owner'))`,
      `CREATE POLICY workspace_members_read ON workspace_members FOR SELECT USING (
        (samurai_current_workspace_id() IS NULL OR workspace_id = samurai_current_workspace_id())
        AND (account_id = samurai_current_account_id() OR samurai_can_workspace(workspace_id, 'admin'))
      )`,
      `CREATE POLICY workspace_members_write ON workspace_members FOR ALL
        USING (workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'admin'))
        WITH CHECK ((samurai_is_bootstrap() OR samurai_can_workspace(workspace_id, 'admin')) AND workspace_id = samurai_current_workspace_id())`,
      `CREATE POLICY rooms_read ON rooms FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, id, 'read')
      )`,
      `CREATE POLICY rooms_create ON rooms FOR INSERT WITH CHECK (
        workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'member')
      )`,
      `CREATE POLICY rooms_manage ON rooms FOR UPDATE
        USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, id, 'manage'))
        WITH CHECK (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, id, 'manage'))`,
      `CREATE POLICY room_members_read ON room_members FOR SELECT USING (
        workspace_id = samurai_current_workspace_id()
        AND (account_id = samurai_current_account_id() OR samurai_can_room(workspace_id, room_id, 'manage'))
      )`,
      `CREATE POLICY room_members_manage ON room_members FOR ALL
        USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'manage'))
        WITH CHECK ((samurai_is_bootstrap() OR samurai_can_room(workspace_id, room_id, 'manage')) AND workspace_id = samurai_current_workspace_id())`,
      `CREATE POLICY workspace_records_read ON workspace_records FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')
      )`,
      `CREATE POLICY workspace_records_write ON workspace_records FOR ALL
        USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'edit'))
        WITH CHECK ((samurai_is_bootstrap() OR samurai_can_room(workspace_id, room_id, 'edit')) AND workspace_id = samurai_current_workspace_id())`,
      `CREATE POLICY workspace_files_read ON workspace_files FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')
      )`,
      `CREATE POLICY workspace_files_write ON workspace_files FOR ALL
        USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'edit'))
        WITH CHECK ((samurai_is_bootstrap() OR samurai_can_room(workspace_id, room_id, 'edit')) AND workspace_id = samurai_current_workspace_id())`,
      `CREATE POLICY workspace_file_transactions_manage ON workspace_file_transactions FOR ALL
        USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'edit'))
        WITH CHECK ((samurai_is_bootstrap() OR samurai_can_room(workspace_id, room_id, 'edit')) AND workspace_id = samurai_current_workspace_id())`,
      `CREATE POLICY workspace_operations_access ON workspace_operations FOR ALL
        USING (workspace_id = samurai_current_workspace_id() AND (actor_account_id = samurai_current_account_id() OR samurai_can_workspace(workspace_id, 'admin')))
        WITH CHECK (workspace_id = samurai_current_workspace_id() AND actor_account_id = samurai_current_account_id())`,
      `CREATE POLICY workspace_events_read ON workspace_events FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')
      )`,
      `CREATE POLICY workspace_events_write ON workspace_events FOR INSERT WITH CHECK (
        (samurai_is_bootstrap() OR samurai_can_room(workspace_id, room_id, 'edit')) AND workspace_id = samurai_current_workspace_id()
      )`,
      `CREATE POLICY workspace_jobs_read ON workspace_jobs FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')
      )`,
      `CREATE POLICY workspace_jobs_write ON workspace_jobs FOR ALL
        USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'execute'))
        WITH CHECK ((samurai_is_bootstrap() OR samurai_can_room(workspace_id, room_id, 'execute')) AND workspace_id = samurai_current_workspace_id())`,
      `CREATE POLICY workspace_invitations_manage ON workspace_invitations FOR ALL
        USING (workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'admin'))
        WITH CHECK ((samurai_is_bootstrap() OR samurai_can_workspace(workspace_id, 'admin')) AND workspace_id = samurai_current_workspace_id())`,
      `CREATE POLICY workspace_transfers_owner ON workspace_transfers FOR ALL
        USING (workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'owner'))
        WITH CHECK ((samurai_is_bootstrap() OR samurai_can_workspace(workspace_id, 'owner')) AND workspace_id = samurai_current_workspace_id())`,
      `CREATE POLICY workspace_bundles_owner ON workspace_bundles FOR ALL
        USING (workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'owner'))
        WITH CHECK ((samurai_is_bootstrap() OR samurai_can_workspace(workspace_id, 'owner')) AND workspace_id = samurai_current_workspace_id())`
    ]
  },
  {
    version: 3,
    name: "workspace_server_bundle_event_source_ids",
    statements: [
      "ALTER TABLE workspace_events ADD COLUMN IF NOT EXISTS source_event_id BIGINT",
      "CREATE UNIQUE INDEX IF NOT EXISTS workspace_events_source_id_index ON workspace_events(workspace_id, source_event_id) WHERE source_event_id IS NOT NULL"
    ]
  },
  {
    version: 4,
    name: "workspace_server_account_operation_idempotency",
    statements: [
      `CREATE TABLE account_operations (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
        result JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (account_id, id)
      )`,
      "ALTER TABLE account_operations ENABLE ROW LEVEL SECURITY",
      `CREATE POLICY account_operations_self ON account_operations FOR ALL
        USING (account_id = samurai_current_account_id())
        WITH CHECK (account_id = samurai_current_account_id())`
    ]
  },
  {
    version: 5,
    name: "workspace_server_revoke_public_database_access",
    statements: [
      "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC",
      "REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC",
      "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC",
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC",
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC",
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"
    ]
  },
  {
    version: 6,
    name: "workspace_server_bundle_bootstrap_operations",
    statements: [
      `ALTER POLICY workspace_operations_access ON workspace_operations
       WITH CHECK (
         workspace_id = samurai_current_workspace_id()
         AND (samurai_is_bootstrap() OR actor_account_id = samurai_current_account_id())
      )`
    ]
  },
  {
    version: 7,
    name: "workspace_server_owner_role_escalation_guards",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_set_workspace_member(
        target_workspace_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing_member workspace_members%ROWTYPE;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
          RAISE EXCEPTION 'workspace_permission_denied';
        END IF;
        IF target_role NOT IN ('owner', 'admin', 'member', 'guest') OR target_state NOT IN ('active', 'revoked') THEN
          RAISE EXCEPTION 'workspace_membership_invalid';
        END IF;
        SELECT * INTO existing_member
        FROM workspace_members
        WHERE workspace_id = target_workspace_id AND account_id = target_account_id;
        IF target_role = 'owner' AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        IF FOUND AND existing_member.role = 'owner' AND existing_member.state = 'active'
          AND (target_role <> 'owner' OR target_state <> 'active') THEN
          IF NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
            RAISE EXCEPTION 'workspace_owner_permission_required';
          END IF;
          IF (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = target_workspace_id AND role = 'owner' AND state = 'active') <= 1 THEN
            RAISE EXCEPTION 'workspace_last_owner_cannot_be_revoked';
          END IF;
        END IF;
        INSERT INTO workspace_members(workspace_id, account_id, role, state, revoked_at, updated_at)
        VALUES (target_workspace_id, target_account_id, target_role, target_state,
          CASE WHEN target_state = 'revoked' THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET
          role = EXCLUDED.role,
          state = EXCLUDED.state,
          revoked_at = EXCLUDED.revoked_at,
          updated_at = NOW();
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_set_room_member(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing_member room_members%ROWTYPE;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_room(target_workspace_id, target_room_id, 'manage') THEN
          RAISE EXCEPTION 'room_permission_denied';
        END IF;
        IF target_role NOT IN ('owner', 'admin', 'member', 'guest') OR target_state NOT IN ('active', 'revoked') THEN
          RAISE EXCEPTION 'room_membership_invalid';
        END IF;
        SELECT * INTO existing_member
        FROM room_members
        WHERE workspace_id = target_workspace_id AND room_id = target_room_id AND account_id = target_account_id;
        IF target_role = 'owner' AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        IF FOUND AND existing_member.role = 'owner' AND existing_member.state = 'active'
          AND (target_role <> 'owner' OR target_state <> 'active')
          AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        INSERT INTO room_members(workspace_id, room_id, account_id, role, state, revoked_at, updated_at)
        VALUES (target_workspace_id, target_room_id, target_account_id, target_role, target_state,
          CASE WHEN target_state = 'revoked' THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (workspace_id, room_id, account_id) DO UPDATE SET
          role = EXCLUDED.role,
          state = EXCLUDED.state,
          revoked_at = EXCLUDED.revoked_at,
          updated_at = NOW();
      END
      $$`,
      `ALTER POLICY workspace_invitations_manage ON workspace_invitations
       WITH CHECK (
         (samurai_is_bootstrap() OR samurai_can_workspace(workspace_id, 'admin'))
         AND workspace_id = samurai_current_workspace_id()
         AND (workspace_role <> 'owner' OR samurai_can_workspace(workspace_id, 'owner'))
         AND (room_role IS DISTINCT FROM 'owner' OR samurai_can_workspace(workspace_id, 'owner'))
      )`
    ]
  },
  {
    version: 8,
    name: "workspace_server_revoke_public_schema_create",
    statements: [
      "REVOKE CREATE ON SCHEMA public FROM PUBLIC"
    ]
  },
  {
    version: 9,
    name: "workspace_server_consistency_import_and_audit_boundaries",
    statements: [
      "ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0)",
      "ALTER TABLE room_members ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0)",
      "ALTER TABLE workspace_invitations ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0)",
      "ALTER TABLE workspace_transfers ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0)",
      "ALTER TABLE workspace_transfers ADD COLUMN IF NOT EXISTS target_workspace_id TEXT",
      "ALTER TABLE workspace_transfers ADD COLUMN IF NOT EXISTS target_receipt JSONB",
      `CREATE TABLE workspace_import_sessions (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK (state IN ('writing', 'completed', 'aborted', 'failed')),
        manifest_hash TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id)
      )`,
      "CREATE INDEX workspace_import_sessions_active_index ON workspace_import_sessions(workspace_id, account_id, state, expires_at)",
      `CREATE TABLE workspace_audit_entries (
        id BIGSERIAL PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        room_id TEXT,
        actor_account_id TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'rejected', 'failed')),
        operation_id TEXT,
        subject_kind TEXT,
        subject_id TEXT,
        before_version BIGINT,
        after_version BIGINT,
        details JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      "CREATE INDEX workspace_audit_entries_workspace_index ON workspace_audit_entries(workspace_id, created_at DESC)",
      "CREATE INDEX workspace_audit_entries_actor_index ON workspace_audit_entries(workspace_id, actor_account_id, created_at DESC)",
      "ALTER TABLE workspace_import_sessions ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_audit_entries ENABLE ROW LEVEL SECURITY",
      `CREATE OR REPLACE FUNCTION samurai_workspace_is_writable(target_workspace_id TEXT)
      RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT EXISTS(
          SELECT 1 FROM workspaces
          WHERE id = target_workspace_id AND state = 'active'
        )
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_assert_workspace_writable(target_workspace_id TEXT)
      RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF NOT samurai_workspace_is_writable(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_read_only';
        END IF;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_is_import_session(target_workspace_id TEXT)
      RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT EXISTS(
          SELECT 1
          FROM workspace_import_sessions
          WHERE workspace_id = target_workspace_id
            AND id = samurai_context_value('samurai.import_id')
            AND account_id = samurai_current_account_id()
            AND state = 'writing'
            AND expires_at > NOW()
        )
      $$`,
      `ALTER POLICY workspaces_bootstrap_insert ON workspaces WITH CHECK (false)`,
      `ALTER POLICY workspace_members_write ON workspace_members
       USING (workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'admin'))
       WITH CHECK (
         workspace_id = samurai_current_workspace_id()
         AND (samurai_is_import_session(workspace_id) OR (samurai_can_workspace(workspace_id, 'admin') AND samurai_workspace_is_writable(workspace_id)))
       )`,
      `ALTER POLICY rooms_create ON rooms
       WITH CHECK (
         workspace_id = samurai_current_workspace_id()
         AND (samurai_is_import_session(workspace_id) OR (samurai_can_workspace(workspace_id, 'member') AND samurai_workspace_is_writable(workspace_id)))
       )`,
      `ALTER POLICY rooms_manage ON rooms
       USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, id, 'manage'))
       WITH CHECK (
         workspace_id = samurai_current_workspace_id()
         AND (samurai_is_import_session(workspace_id) OR (samurai_can_room(workspace_id, id, 'manage') AND samurai_workspace_is_writable(workspace_id)))
       )`,
      `ALTER POLICY room_members_manage ON room_members
       USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'manage'))
       WITH CHECK (
         workspace_id = samurai_current_workspace_id()
         AND (samurai_is_import_session(workspace_id) OR (samurai_can_room(workspace_id, room_id, 'manage') AND samurai_workspace_is_writable(workspace_id)))
       )`,
      `ALTER POLICY workspace_records_write ON workspace_records
       USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'edit'))
       WITH CHECK (
         workspace_id = samurai_current_workspace_id()
         AND (samurai_is_import_session(workspace_id) OR (samurai_can_room(workspace_id, room_id, 'edit') AND samurai_workspace_is_writable(workspace_id)))
       )`,
      `ALTER POLICY workspace_files_write ON workspace_files
       USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'edit'))
       WITH CHECK (
         workspace_id = samurai_current_workspace_id()
         AND (samurai_is_import_session(workspace_id) OR (samurai_can_room(workspace_id, room_id, 'edit') AND samurai_workspace_is_writable(workspace_id)))
       )`,
      `ALTER POLICY workspace_file_transactions_manage ON workspace_file_transactions
       USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'edit'))
       WITH CHECK (
         workspace_id = samurai_current_workspace_id()
         AND (samurai_is_import_session(workspace_id) OR (samurai_can_room(workspace_id, room_id, 'edit') AND samurai_workspace_is_writable(workspace_id)))
       )`,
      `ALTER POLICY workspace_events_write ON workspace_events
       WITH CHECK (
         workspace_id = samurai_current_workspace_id()
         AND (samurai_is_import_session(workspace_id) OR (samurai_can_room(workspace_id, room_id, 'edit') AND samurai_workspace_is_writable(workspace_id)))
       )`,
      `ALTER POLICY workspace_jobs_write ON workspace_jobs
       USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'execute'))
       WITH CHECK (
         workspace_id = samurai_current_workspace_id()
         AND (samurai_is_import_session(workspace_id) OR (samurai_can_room(workspace_id, room_id, 'execute') AND samurai_workspace_is_writable(workspace_id)))
       )`,
      `ALTER POLICY workspace_invitations_manage ON workspace_invitations
       USING (workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'admin'))
       WITH CHECK (
         workspace_id = samurai_current_workspace_id()
         AND (samurai_is_import_session(workspace_id) OR (samurai_can_workspace(workspace_id, 'admin') AND samurai_workspace_is_writable(workspace_id)))
         AND (workspace_role <> 'owner' OR samurai_can_workspace(workspace_id, 'owner'))
         AND (room_role IS DISTINCT FROM 'owner' OR samurai_can_workspace(workspace_id, 'owner'))
       )`,
      `CREATE POLICY workspace_audit_entries_read ON workspace_audit_entries FOR SELECT USING (
        workspace_id = samurai_current_workspace_id()
        AND (actor_account_id = samurai_current_account_id() OR samurai_can_workspace(workspace_id, 'admin'))
      )`,
      `CREATE POLICY workspace_audit_entries_write ON workspace_audit_entries FOR INSERT WITH CHECK (
        workspace_id = samurai_current_workspace_id()
        AND actor_account_id = samurai_current_account_id()
        AND samurai_can_workspace(workspace_id, 'guest')
      )`,
      `DROP FUNCTION IF EXISTS samurai_create_room(TEXT, TEXT, TEXT)`,
      `CREATE OR REPLACE FUNCTION samurai_create_room(
        target_workspace_id TEXT,
        new_room_id TEXT,
        new_room_name TEXT,
        target_workspace_version BIGINT
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE current_workspace_version BIGINT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'member') THEN
          RAISE EXCEPTION 'workspace_permission_denied';
        END IF;
        SELECT version INTO current_workspace_version
        FROM workspaces WHERE id = target_workspace_id FOR UPDATE;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF current_workspace_version IS DISTINCT FROM target_workspace_version THEN
          RAISE EXCEPTION 'workspace_version_conflict';
        END IF;
        INSERT INTO rooms(workspace_id, id, name, created_by)
        VALUES (target_workspace_id, new_room_id, new_room_name, samurai_current_account_id());
        INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version)
        VALUES (target_workspace_id, new_room_id, samurai_current_account_id(), 'owner', 'active', 1);
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
        RETURN new_room_id;
      END
      $$`,
      `DROP FUNCTION IF EXISTS samurai_set_workspace_member(TEXT, TEXT, TEXT, TEXT)`,
      `CREATE OR REPLACE FUNCTION samurai_set_workspace_member(
        target_workspace_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT,
        target_expected_version BIGINT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing_member workspace_members%ROWTYPE;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
          RAISE EXCEPTION 'workspace_permission_denied';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF target_role NOT IN ('owner', 'admin', 'member', 'guest') OR target_state NOT IN ('active', 'revoked') THEN
          RAISE EXCEPTION 'workspace_membership_invalid';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.owner:' || target_workspace_id, 0));
        SELECT * INTO existing_member
        FROM workspace_members
        WHERE workspace_id = target_workspace_id AND account_id = target_account_id
        FOR UPDATE;
        IF COALESCE(existing_member.version, 0) <> target_expected_version THEN
          RAISE EXCEPTION 'workspace_membership_version_conflict';
        END IF;
        IF target_role = 'owner' AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        IF FOUND AND existing_member.role = 'owner' AND existing_member.state = 'active'
          AND (target_role <> 'owner' OR target_state <> 'active') THEN
          IF NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
            RAISE EXCEPTION 'workspace_owner_permission_required';
          END IF;
          IF (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = target_workspace_id AND role = 'owner' AND state = 'active') <= 1 THEN
            RAISE EXCEPTION 'workspace_last_owner_cannot_be_revoked';
          END IF;
        END IF;
        INSERT INTO workspace_members(workspace_id, account_id, role, state, version, revoked_at, updated_at)
        VALUES (target_workspace_id, target_account_id, target_role, target_state, 1,
          CASE WHEN target_state = 'revoked' THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET
          role = EXCLUDED.role,
          state = EXCLUDED.state,
          version = workspace_members.version + 1,
          revoked_at = EXCLUDED.revoked_at,
          updated_at = NOW();
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
      END
      $$`,
      `DROP FUNCTION IF EXISTS samurai_set_room_member(TEXT, TEXT, TEXT, TEXT, TEXT)`,
      `CREATE OR REPLACE FUNCTION samurai_set_room_member(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT,
        target_expected_version BIGINT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing_member room_members%ROWTYPE;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_room(target_workspace_id, target_room_id, 'manage') THEN
          RAISE EXCEPTION 'room_permission_denied';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF target_role NOT IN ('owner', 'admin', 'member', 'guest') OR target_state NOT IN ('active', 'revoked') THEN
          RAISE EXCEPTION 'room_membership_invalid';
        END IF;
        SELECT * INTO existing_member
        FROM room_members
        WHERE workspace_id = target_workspace_id AND room_id = target_room_id AND account_id = target_account_id
        FOR UPDATE;
        IF COALESCE(existing_member.version, 0) <> target_expected_version THEN
          RAISE EXCEPTION 'room_membership_version_conflict';
        END IF;
        IF target_role = 'owner' AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        IF FOUND AND existing_member.role = 'owner' AND existing_member.state = 'active'
          AND (target_role <> 'owner' OR target_state <> 'active')
          AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version, revoked_at, updated_at)
        VALUES (target_workspace_id, target_room_id, target_account_id, target_role, target_state, 1,
          CASE WHEN target_state = 'revoked' THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (workspace_id, room_id, account_id) DO UPDATE SET
          role = EXCLUDED.role,
          state = EXCLUDED.state,
          version = room_members.version + 1,
          revoked_at = EXCLUDED.revoked_at,
          updated_at = NOW();
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_create_workspace(
        target_workspace_id TEXT,
        workspace_name TEXT,
        target_hosting_mode TEXT,
        target_database_placement TEXT,
        default_room_id TEXT,
        default_room_name TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR samurai_current_account_id() IS NULL THEN
          RAISE EXCEPTION 'workspace_creation_context_invalid';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = samurai_current_account_id() AND status = 'active') THEN
          RAISE EXCEPTION 'account_not_found';
        END IF;
        IF target_hosting_mode NOT IN ('hosted', 'self_host') OR target_database_placement NOT IN ('shared', 'dedicated') THEN
          RAISE EXCEPTION 'workspace_creation_invalid';
        END IF;
        IF EXISTS (SELECT 1 FROM workspaces WHERE id = target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_id_conflict';
        END IF;
        INSERT INTO workspaces(id, name, state, hosting_mode, storage_namespace, database_placement, created_by)
        VALUES (target_workspace_id, workspace_name, 'active', target_hosting_mode,
          'workspaces/' || target_workspace_id, target_database_placement, samurai_current_account_id());
        INSERT INTO workspace_members(workspace_id, account_id, role, state, version)
        VALUES (target_workspace_id, samurai_current_account_id(), 'owner', 'active', 1);
        INSERT INTO rooms(workspace_id, id, name, created_by)
        VALUES (target_workspace_id, default_room_id, default_room_name, samurai_current_account_id());
        INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version)
        VALUES (target_workspace_id, default_room_id, samurai_current_account_id(), 'owner', 'active', 1);
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_start_workspace_import(
        target_workspace_id TEXT,
        workspace_name TEXT,
        target_hosting_mode TEXT,
        target_database_placement TEXT,
        import_session_id TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR samurai_current_account_id() IS NULL THEN
          RAISE EXCEPTION 'workspace_import_context_invalid';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = samurai_current_account_id() AND status = 'active') THEN
          RAISE EXCEPTION 'account_not_found';
        END IF;
        IF target_hosting_mode NOT IN ('hosted', 'self_host') OR target_database_placement NOT IN ('shared', 'dedicated') THEN
          RAISE EXCEPTION 'workspace_import_invalid';
        END IF;
        IF EXISTS (SELECT 1 FROM workspaces WHERE id = target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_target_exists';
        END IF;
        INSERT INTO workspaces(id, name, state, hosting_mode, storage_namespace, database_placement, created_by)
        VALUES (target_workspace_id, workspace_name, 'read_only', target_hosting_mode,
          'workspaces/' || target_workspace_id, target_database_placement, samurai_current_account_id());
        INSERT INTO workspace_members(workspace_id, account_id, role, state, version)
        VALUES (target_workspace_id, samurai_current_account_id(), 'owner', 'active', 1);
        INSERT INTO workspace_import_sessions(workspace_id, id, account_id, state, expires_at)
        VALUES (target_workspace_id, import_session_id, samurai_current_account_id(), 'writing', NOW() + INTERVAL '1 hour');
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_complete_workspace_import(
        target_workspace_id TEXT,
        import_session_id TEXT,
        target_manifest_hash TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM workspace_members
          WHERE workspace_id = target_workspace_id AND role = 'owner' AND state = 'active'
        ) THEN
          RAISE EXCEPTION 'workspace_import_owner_missing';
        END IF;
        UPDATE workspace_import_sessions
        SET state = 'completed', manifest_hash = target_manifest_hash, updated_at = NOW()
        WHERE workspace_id = target_workspace_id AND id = import_session_id AND state = 'writing';
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_import_session_invalid'; END IF;
        UPDATE workspaces SET state = 'active', version = version + 1, updated_at = NOW()
        WHERE id = target_workspace_id AND state = 'read_only';
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_import_target_invalid'; END IF;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_abort_workspace_import(
        target_workspace_id TEXT,
        import_session_id TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        DELETE FROM workspace_audit_entries WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_bundles WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_transfers WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_invitations WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_jobs WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_events WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_operations WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_file_transactions WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_files WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_records WHERE workspace_id = target_workspace_id;
        DELETE FROM room_members WHERE workspace_id = target_workspace_id;
        DELETE FROM rooms WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_members WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_import_sessions WHERE workspace_id = target_workspace_id AND id = import_session_id;
        DELETE FROM workspaces WHERE id = target_workspace_id AND state = 'read_only';
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_import_target_invalid'; END IF;
      END
      $$`,
      `DROP FUNCTION IF EXISTS samurai_accept_invitation(TEXT, TEXT)`,
      `CREATE OR REPLACE FUNCTION samurai_accept_invitation(target_workspace_id TEXT, supplied_token_hash TEXT)
      RETURNS TABLE(workspace_role TEXT, room_id TEXT, room_role TEXT, invitation_version BIGINT)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE invitation workspace_invitations%ROWTYPE;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR samurai_current_account_id() IS NULL THEN
          RAISE EXCEPTION 'workspace_invitation_invalid';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        SELECT * INTO invitation
        FROM workspace_invitations
        WHERE workspace_id = target_workspace_id
          AND token_hash = supplied_token_hash
          AND revoked_at IS NULL
          AND accepted_at IS NULL
          AND expires_at > NOW()
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_invitation_invalid'; END IF;
        INSERT INTO workspace_members(workspace_id, account_id, role, state, version, updated_at)
        VALUES (target_workspace_id, samurai_current_account_id(), invitation.workspace_role, 'active', 1, NOW())
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET
          role = CASE WHEN samurai_role_rank(EXCLUDED.role) > samurai_role_rank(workspace_members.role) THEN EXCLUDED.role ELSE workspace_members.role END,
          state = 'active', revoked_at = NULL, version = workspace_members.version + 1, updated_at = NOW();
        IF invitation.room_id IS NOT NULL THEN
          INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version, updated_at)
          VALUES (target_workspace_id, invitation.room_id, samurai_current_account_id(), COALESCE(invitation.room_role, invitation.workspace_role), 'active', 1, NOW())
          ON CONFLICT (workspace_id, room_id, account_id) DO UPDATE SET
            role = CASE WHEN samurai_role_rank(EXCLUDED.role) > samurai_role_rank(room_members.role) THEN EXCLUDED.role ELSE room_members.role END,
            state = 'active', revoked_at = NULL, version = room_members.version + 1, updated_at = NOW();
        END IF;
        UPDATE workspace_invitations
        SET accepted_by = samurai_current_account_id(), accepted_at = NOW(), version = version + 1
        WHERE workspace_id = target_workspace_id AND id = invitation.id
        RETURNING version INTO invitation_version;
        RETURN QUERY SELECT invitation.workspace_role, invitation.room_id, invitation.room_role, invitation_version;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_revoke_invitation(
        target_workspace_id TEXT,
        target_invitation_id TEXT,
        target_expected_version BIGINT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE current_version BIGINT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
          RAISE EXCEPTION 'workspace_permission_denied';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        SELECT version INTO current_version FROM workspace_invitations
        WHERE workspace_id = target_workspace_id AND id = target_invitation_id
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_invitation_not_found'; END IF;
        IF current_version <> target_expected_version THEN RAISE EXCEPTION 'workspace_invitation_version_conflict'; END IF;
        UPDATE workspace_invitations
        SET revoked_at = NOW(), version = version + 1
        WHERE workspace_id = target_workspace_id AND id = target_invitation_id
          AND revoked_at IS NULL AND accepted_at IS NULL;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_invitation_not_available'; END IF;
      END
      $$`
    ]
  },
  {
    version: 10,
    name: "workspace_server_transfer_receipts_and_runtime_write_gates",
    statements: [
      `ALTER POLICY workspaces_owner_update ON workspaces
       USING (false) WITH CHECK (false)`,
      "DROP POLICY workspace_transfers_owner ON workspace_transfers",
      `CREATE POLICY workspace_transfers_read ON workspace_transfers FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'owner')
      )`,
      `CREATE POLICY workspace_transfers_write_denied ON workspace_transfers FOR ALL
       USING (false) WITH CHECK (false)`,
      "DROP POLICY workspace_bundles_owner ON workspace_bundles",
      `CREATE POLICY workspace_bundles_read ON workspace_bundles FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'owner')
      )`,
      `CREATE POLICY workspace_bundles_write_denied ON workspace_bundles FOR ALL
       USING (false) WITH CHECK (false)`,
      `CREATE OR REPLACE FUNCTION samurai_begin_workspace_transfer(
        target_workspace_id TEXT,
        target_transfer_id TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE current_state TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        SELECT state INTO current_state FROM workspaces WHERE id = target_workspace_id FOR UPDATE;
        IF current_state <> 'active' THEN RAISE EXCEPTION 'workspace_transfer_source_not_active'; END IF;
        INSERT INTO workspace_transfers(workspace_id, id, state, initiated_by, version)
        VALUES (target_workspace_id, target_transfer_id, 'preparing', samurai_current_account_id(), 1);
        UPDATE workspaces SET state = 'read_only', version = version + 1, updated_at = NOW()
        WHERE id = target_workspace_id;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_record_workspace_bundle(
        target_workspace_id TEXT,
        target_bundle_id TEXT,
        target_path TEXT,
        target_hash TEXT,
        target_record_counts JSONB,
        target_transfer_id TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        IF target_transfer_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM workspace_transfers
          WHERE workspace_id = target_workspace_id AND id = target_transfer_id AND state = 'preparing'
        ) THEN RAISE EXCEPTION 'workspace_transfer_not_ready'; END IF;
        INSERT INTO workspace_bundles(workspace_id, id, format_version, path, sha256, record_counts, created_by)
        VALUES (target_workspace_id, target_bundle_id, 3, target_path, target_hash, target_record_counts, samurai_current_account_id())
        ON CONFLICT (workspace_id, id) DO UPDATE SET
          path = EXCLUDED.path, sha256 = EXCLUDED.sha256, record_counts = EXCLUDED.record_counts;
        IF target_transfer_id IS NOT NULL THEN
          UPDATE workspace_transfers
          SET state = 'exported', bundle_path = target_path, bundle_hash = target_hash,
              version = version + 1, updated_at = NOW()
          WHERE workspace_id = target_workspace_id AND id = target_transfer_id AND state = 'preparing';
          IF NOT FOUND THEN RAISE EXCEPTION 'workspace_transfer_not_ready'; END IF;
        END IF;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_fail_workspace_transfer(
        target_workspace_id TEXT,
        target_transfer_id TEXT,
        target_error_code TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        UPDATE workspace_transfers SET state = 'failed', error_code = target_error_code,
          version = version + 1, updated_at = NOW()
        WHERE workspace_id = target_workspace_id AND id = target_transfer_id
          AND state IN ('preparing', 'exported');
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_transfer_not_found'; END IF;
        UPDATE workspaces SET state = 'active', version = version + 1, updated_at = NOW()
        WHERE id = target_workspace_id AND state = 'read_only';
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_rollback_workspace_transfer(
        target_workspace_id TEXT,
        target_transfer_id TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        UPDATE workspace_transfers SET state = 'rolled_back', version = version + 1, updated_at = NOW()
        WHERE workspace_id = target_workspace_id AND id = target_transfer_id
          AND state IN ('preparing', 'exported', 'failed');
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_transfer_not_found'; END IF;
        UPDATE workspaces SET state = 'active', version = version + 1, updated_at = NOW()
        WHERE id = target_workspace_id AND state = 'read_only';
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_record_workspace_transfer_receipt(
        target_workspace_id TEXT,
        target_transfer_id TEXT,
        target_destination_workspace_id TEXT,
        target_receipt JSONB
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE exported_hash TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        SELECT bundle_hash INTO exported_hash FROM workspace_transfers
        WHERE workspace_id = target_workspace_id AND id = target_transfer_id AND state = 'exported'
        FOR UPDATE;
        IF NOT FOUND OR exported_hash IS NULL
          OR target_receipt->>'transfer_id' IS DISTINCT FROM target_transfer_id
          OR target_receipt->>'source_workspace_id' IS DISTINCT FROM target_workspace_id
          OR target_receipt->>'source_integrity_hash' IS DISTINCT FROM exported_hash
          OR target_receipt->>'target_workspace_id' IS DISTINCT FROM target_destination_workspace_id THEN
          RAISE EXCEPTION 'workspace_transfer_receipt_invalid';
        END IF;
        UPDATE workspace_transfers
        SET state = 'imported', target_workspace_id = target_destination_workspace_id,
            target_receipt = target_receipt, version = version + 1, updated_at = NOW()
        WHERE workspace_id = target_workspace_id AND id = target_transfer_id AND state = 'exported';
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_complete_workspace_transfer(
        target_workspace_id TEXT,
        target_transfer_id TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        UPDATE workspace_transfers AS transfer SET state = 'committed', version = transfer.version + 1, updated_at = NOW()
        WHERE transfer.workspace_id = target_workspace_id AND transfer.id = target_transfer_id
          AND transfer.state = 'imported' AND transfer.target_receipt IS NOT NULL AND transfer.target_workspace_id IS NOT NULL;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_transfer_not_ready'; END IF;
        UPDATE workspaces SET state = 'archived', version = version + 1, updated_at = NOW()
        WHERE id = target_workspace_id AND state = 'read_only';
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_transfer_source_not_active'; END IF;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_record_import_bundle(
        target_workspace_id TEXT,
        import_session_id TEXT,
        target_path TEXT,
        target_hash TEXT,
        target_record_counts JSONB
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR samurai_context_value('samurai.import_id') IS DISTINCT FROM import_session_id
          OR NOT samurai_is_import_session(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        INSERT INTO workspace_bundles(workspace_id, id, format_version, path, sha256, record_counts, created_by)
        VALUES (target_workspace_id, 'import_' || LEFT(target_hash, 40), 3, target_path, target_hash,
          target_record_counts, samurai_current_account_id())
        ON CONFLICT (workspace_id, id) DO UPDATE SET
          path = EXCLUDED.path, sha256 = EXCLUDED.sha256, record_counts = EXCLUDED.record_counts;
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_begin_workspace_transfer(TEXT, TEXT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_record_workspace_bundle(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_fail_workspace_transfer(TEXT, TEXT, TEXT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_rollback_workspace_transfer(TEXT, TEXT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_record_workspace_transfer_receipt(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_complete_workspace_transfer(TEXT, TEXT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_record_import_bundle(TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC"
    ]
  },
  {
    version: 11,
    name: "workspace_server_import_source_version",
    statements: [
      "DROP FUNCTION IF EXISTS samurai_start_workspace_import(TEXT, TEXT, TEXT, TEXT, TEXT)",
      `CREATE OR REPLACE FUNCTION samurai_start_workspace_import(
        target_workspace_id TEXT,
        workspace_name TEXT,
        target_hosting_mode TEXT,
        target_database_placement TEXT,
        import_session_id TEXT,
        target_initial_version BIGINT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR samurai_current_account_id() IS NULL THEN
          RAISE EXCEPTION 'workspace_import_context_invalid';
        END IF;
        IF target_initial_version < 1 THEN RAISE EXCEPTION 'workspace_import_invalid'; END IF;
        IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = samurai_current_account_id() AND status = 'active') THEN
          RAISE EXCEPTION 'account_not_found';
        END IF;
        IF target_hosting_mode NOT IN ('hosted', 'self_host') OR target_database_placement NOT IN ('shared', 'dedicated') THEN
          RAISE EXCEPTION 'workspace_import_invalid';
        END IF;
        IF EXISTS (SELECT 1 FROM workspaces WHERE id = target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_target_exists';
        END IF;
        INSERT INTO workspaces(id, name, state, hosting_mode, storage_namespace, database_placement, created_by, version)
        VALUES (target_workspace_id, workspace_name, 'read_only', target_hosting_mode,
          'workspaces/' || target_workspace_id, target_database_placement, samurai_current_account_id(), target_initial_version);
        INSERT INTO workspace_members(workspace_id, account_id, role, state, version)
        VALUES (target_workspace_id, samurai_current_account_id(), 'owner', 'active', 1);
        INSERT INTO workspace_import_sessions(workspace_id, id, account_id, state, expires_at)
        VALUES (target_workspace_id, import_session_id, samurai_current_account_id(), 'writing', NOW() + INTERVAL '1 hour');
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_start_workspace_import(TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC"
    ]
  },
  {
    version: 12,
    name: "workspace_server_portable_accounts_and_audit_integrity",
    statements: [
      "DROP POLICY workspace_audit_entries_write ON workspace_audit_entries",
      `CREATE POLICY workspace_audit_entries_write_denied ON workspace_audit_entries FOR ALL
       USING (false) WITH CHECK (false)`,
      `CREATE OR REPLACE FUNCTION samurai_append_workspace_audit(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_action TEXT,
        target_outcome TEXT,
        target_operation_id TEXT,
        target_subject_kind TEXT,
        target_subject_id TEXT,
        target_before_version BIGINT,
        target_after_version BIGINT,
        target_details JSONB
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR (NOT samurai_is_import_session(target_workspace_id) AND NOT samurai_can_workspace(target_workspace_id, 'guest')) THEN
          RAISE EXCEPTION 'workspace_audit_permission_denied';
        END IF;
        IF target_outcome NOT IN ('completed', 'rejected', 'failed') THEN RAISE EXCEPTION 'workspace_audit_invalid'; END IF;
        INSERT INTO workspace_audit_entries(
          workspace_id, room_id, actor_account_id, action, outcome, operation_id, subject_kind, subject_id,
          before_version, after_version, details
        ) VALUES (
          target_workspace_id, target_room_id, samurai_current_account_id(), target_action, target_outcome,
          target_operation_id, target_subject_kind, target_subject_id, target_before_version, target_after_version,
          COALESCE(target_details, '{}'::JSONB)
        );
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_create_workspace_invitation(
        target_workspace_id TEXT,
        target_invitation_id TEXT,
        target_room_id TEXT,
        target_token_hash TEXT,
        target_workspace_role TEXT,
        target_room_role TEXT,
        target_expires_at TIMESTAMPTZ,
        target_workspace_version BIGINT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE current_workspace_version BIGINT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
          RAISE EXCEPTION 'workspace_permission_denied';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF target_workspace_role NOT IN ('owner', 'admin', 'member', 'guest')
          OR (target_room_role IS NOT NULL AND target_room_role NOT IN ('owner', 'admin', 'member', 'guest'))
          OR target_expires_at <= NOW() THEN
          RAISE EXCEPTION 'workspace_invitation_invalid';
        END IF;
        IF (target_workspace_role = 'owner' OR target_room_role = 'owner')
          AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        SELECT version INTO current_workspace_version FROM workspaces WHERE id = target_workspace_id FOR UPDATE;
        IF current_workspace_version IS DISTINCT FROM target_workspace_version THEN
          RAISE EXCEPTION 'workspace_version_conflict';
        END IF;
        INSERT INTO workspace_invitations(
          workspace_id, id, room_id, token_hash, workspace_role, room_role, created_by, expires_at, version
        ) VALUES (
          target_workspace_id, target_invitation_id, target_room_id, target_token_hash, target_workspace_role,
          target_room_role, samurai_current_account_id(), target_expires_at, 1
        );
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_list_workspace_account_identities(target_workspace_id TEXT)
      RETURNS TABLE(id TEXT, public_key TEXT, display_name TEXT, status TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        RETURN QUERY
        SELECT account.id, account.public_key, account.display_name, account.status, account.created_at, account.updated_at
        FROM accounts AS account
        JOIN workspace_members AS member ON member.account_id = account.id
        WHERE member.workspace_id = target_workspace_id
        ORDER BY account.id;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_import_workspace_account_identity(
        target_workspace_id TEXT,
        target_account_id TEXT,
        target_public_key TEXT,
        target_display_name TEXT,
        target_status TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing_key TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        IF target_status NOT IN ('active', 'disabled') THEN RAISE EXCEPTION 'account_status_invalid'; END IF;
        SELECT public_key INTO existing_key FROM accounts WHERE id = target_account_id FOR UPDATE;
        IF FOUND AND existing_key <> target_public_key THEN RAISE EXCEPTION 'account_public_key_conflict'; END IF;
        INSERT INTO accounts(id, public_key, display_name, status)
        VALUES (target_account_id, target_public_key, target_display_name, target_status)
        ON CONFLICT (id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          status = EXCLUDED.status,
          updated_at = NOW()
        WHERE accounts.public_key = EXCLUDED.public_key;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_accept_invitation(target_workspace_id TEXT, supplied_token_hash TEXT)
      RETURNS TABLE(workspace_role TEXT, room_id TEXT, room_role TEXT, invitation_version BIGINT)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE invitation workspace_invitations%ROWTYPE;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR samurai_current_account_id() IS NULL THEN
          RAISE EXCEPTION 'workspace_invitation_invalid';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        SELECT * INTO invitation
        FROM workspace_invitations
        WHERE workspace_id = target_workspace_id
          AND token_hash = supplied_token_hash
          AND revoked_at IS NULL
          AND accepted_at IS NULL
          AND expires_at > NOW()
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_invitation_invalid'; END IF;
        INSERT INTO workspace_members(workspace_id, account_id, role, state, version, updated_at)
        VALUES (target_workspace_id, samurai_current_account_id(), invitation.workspace_role, 'active', 1, NOW())
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET
          role = CASE WHEN samurai_role_rank(EXCLUDED.role) > samurai_role_rank(workspace_members.role) THEN EXCLUDED.role ELSE workspace_members.role END,
          state = 'active', revoked_at = NULL, version = workspace_members.version + 1, updated_at = NOW();
        IF invitation.room_id IS NOT NULL THEN
          INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version, updated_at)
          VALUES (target_workspace_id, invitation.room_id, samurai_current_account_id(), COALESCE(invitation.room_role, invitation.workspace_role), 'active', 1, NOW())
          ON CONFLICT (workspace_id, room_id, account_id) DO UPDATE SET
            role = CASE WHEN samurai_role_rank(EXCLUDED.role) > samurai_role_rank(room_members.role) THEN EXCLUDED.role ELSE room_members.role END,
            state = 'active', revoked_at = NULL, version = room_members.version + 1, updated_at = NOW();
        END IF;
        UPDATE workspace_invitations
        SET accepted_by = samurai_current_account_id(), accepted_at = NOW(), version = version + 1
        WHERE workspace_id = target_workspace_id AND id = invitation.id
        RETURNING version INTO invitation_version;
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
        RETURN QUERY SELECT invitation.workspace_role, invitation.room_id, invitation.room_role, invitation_version;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_revoke_invitation(
        target_workspace_id TEXT,
        target_invitation_id TEXT,
        target_expected_version BIGINT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE current_version BIGINT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
          RAISE EXCEPTION 'workspace_permission_denied';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        SELECT version INTO current_version FROM workspace_invitations
        WHERE workspace_id = target_workspace_id AND id = target_invitation_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_invitation_not_found'; END IF;
        IF current_version <> target_expected_version THEN RAISE EXCEPTION 'workspace_invitation_version_conflict'; END IF;
        UPDATE workspace_invitations
        SET revoked_at = NOW(), version = version + 1
        WHERE workspace_id = target_workspace_id AND id = target_invitation_id
          AND revoked_at IS NULL AND accepted_at IS NULL;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_invitation_not_available'; END IF;
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_append_workspace_audit(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, JSONB) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_create_workspace_invitation(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BIGINT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_list_workspace_account_identities(TEXT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_import_workspace_account_identity(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC"
    ]
  },
  {
    version: 13,
    name: "workspace_server_member_identity_and_import_audit_guards",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_set_workspace_member(
        target_workspace_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT,
        target_expected_version BIGINT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing_member workspace_members%ROWTYPE;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
          RAISE EXCEPTION 'workspace_permission_denied';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF target_role NOT IN ('owner', 'admin', 'member', 'guest') OR target_state NOT IN ('active', 'revoked') THEN
          RAISE EXCEPTION 'workspace_membership_invalid';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = target_account_id AND status = 'active') THEN
          RAISE EXCEPTION 'account_not_found';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.owner:' || target_workspace_id, 0));
        SELECT * INTO existing_member FROM workspace_members
        WHERE workspace_id = target_workspace_id AND account_id = target_account_id FOR UPDATE;
        IF COALESCE(existing_member.version, 0) <> target_expected_version THEN
          RAISE EXCEPTION 'workspace_membership_version_conflict';
        END IF;
        IF target_role = 'owner' AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        IF FOUND AND existing_member.role = 'owner' AND existing_member.state = 'active'
          AND (target_role <> 'owner' OR target_state <> 'active') THEN
          IF NOT samurai_can_workspace(target_workspace_id, 'owner') THEN RAISE EXCEPTION 'workspace_owner_permission_required'; END IF;
          IF (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = target_workspace_id AND role = 'owner' AND state = 'active') <= 1 THEN
            RAISE EXCEPTION 'workspace_last_owner_cannot_be_revoked';
          END IF;
        END IF;
        INSERT INTO workspace_members(workspace_id, account_id, role, state, version, revoked_at, updated_at)
        VALUES (target_workspace_id, target_account_id, target_role, target_state, 1,
          CASE WHEN target_state = 'revoked' THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET
          role = EXCLUDED.role, state = EXCLUDED.state, version = workspace_members.version + 1,
          revoked_at = EXCLUDED.revoked_at, updated_at = NOW();
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_set_room_member(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT,
        target_expected_version BIGINT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing_member room_members%ROWTYPE;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_room(target_workspace_id, target_room_id, 'manage') THEN
          RAISE EXCEPTION 'room_permission_denied';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF target_role NOT IN ('owner', 'admin', 'member', 'guest') OR target_state NOT IN ('active', 'revoked') THEN
          RAISE EXCEPTION 'room_membership_invalid';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM workspace_members
          WHERE workspace_id = target_workspace_id AND account_id = target_account_id AND state = 'active'
        ) THEN RAISE EXCEPTION 'workspace_membership_required'; END IF;
        SELECT * INTO existing_member FROM room_members
        WHERE workspace_id = target_workspace_id AND room_id = target_room_id AND account_id = target_account_id FOR UPDATE;
        IF COALESCE(existing_member.version, 0) <> target_expected_version THEN
          RAISE EXCEPTION 'room_membership_version_conflict';
        END IF;
        IF target_role = 'owner' AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        IF FOUND AND existing_member.role = 'owner' AND existing_member.state = 'active'
          AND (target_role <> 'owner' OR target_state <> 'active')
          AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version, revoked_at, updated_at)
        VALUES (target_workspace_id, target_room_id, target_account_id, target_role, target_state, 1,
          CASE WHEN target_state = 'revoked' THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (workspace_id, room_id, account_id) DO UPDATE SET
          role = EXCLUDED.role, state = EXCLUDED.state, version = room_members.version + 1,
          revoked_at = EXCLUDED.revoked_at, updated_at = NOW();
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_import_workspace_audit(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_actor_account_id TEXT,
        target_action TEXT,
        target_outcome TEXT,
        target_operation_id TEXT,
        target_subject_kind TEXT,
        target_subject_id TEXT,
        target_before_version BIGINT,
        target_after_version BIGINT,
        target_details JSONB,
        target_created_at TIMESTAMPTZ
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id)
          OR target_outcome NOT IN ('completed', 'rejected', 'failed') THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        INSERT INTO workspace_audit_entries(
          workspace_id, room_id, actor_account_id, action, outcome, operation_id, subject_kind, subject_id,
          before_version, after_version, details, created_at
        ) VALUES (
          target_workspace_id, target_room_id, target_actor_account_id, target_action, target_outcome,
          target_operation_id, target_subject_kind, target_subject_id, target_before_version, target_after_version,
          COALESCE(target_details, '{}'::JSONB), target_created_at
        );
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_import_workspace_audit(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, JSONB, TIMESTAMPTZ) FROM PUBLIC"
    ]
  },
  {
    version: 14,
    name: "workspace_server_audit_after_access_change",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_append_workspace_audit(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_action TEXT,
        target_outcome TEXT,
        target_operation_id TEXT,
        target_subject_kind TEXT,
        target_subject_id TEXT,
        target_before_version BIGINT,
        target_after_version BIGINT,
        target_details JSONB
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR (
            NOT samurai_is_import_session(target_workspace_id)
            AND NOT EXISTS (
              SELECT 1 FROM workspace_members
              WHERE workspace_id = target_workspace_id AND account_id = samurai_current_account_id()
            )
          ) THEN
          RAISE EXCEPTION 'workspace_audit_permission_denied';
        END IF;
        IF target_outcome NOT IN ('completed', 'rejected', 'failed') THEN RAISE EXCEPTION 'workspace_audit_invalid'; END IF;
        INSERT INTO workspace_audit_entries(
          workspace_id, room_id, actor_account_id, action, outcome, operation_id, subject_kind, subject_id,
          before_version, after_version, details
        ) VALUES (
          target_workspace_id, target_room_id, samurai_current_account_id(), target_action, target_outcome,
          target_operation_id, target_subject_kind, target_subject_id, target_before_version, target_after_version,
          COALESCE(target_details, '{}'::JSONB)
        );
      END
      $$`
    ]
  },
  {
    version: 15,
    name: "workspace_server_import_account_identity_is_non_destructive",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_import_workspace_account_identity(
        target_workspace_id TEXT,
        target_account_id TEXT,
        target_public_key TEXT,
        target_display_name TEXT,
        target_status TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing_key TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id)
          OR target_status <> 'active' THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        SELECT public_key INTO existing_key FROM accounts WHERE id = target_account_id FOR UPDATE;
        IF FOUND THEN
          IF existing_key <> target_public_key THEN RAISE EXCEPTION 'account_public_key_conflict'; END IF;
          -- Accounts are shared server-wide. A Workspace Bundle may prove an
          -- identity, but it must never change another Workspace's Account
          -- display name or disabled/active state.
          RETURN;
        END IF;
        INSERT INTO accounts(id, public_key, display_name, status)
        VALUES (target_account_id, target_public_key, target_display_name, 'active');
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_import_workspace_account_identity(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC"
    ]
  },
  {
    version: 16,
    name: "workspace_server_operation_and_file_recovery_guards",
    statements: [
      `ALTER POLICY workspace_operations_access ON workspace_operations
       WITH CHECK (
         workspace_id = samurai_current_workspace_id()
         AND actor_account_id = samurai_current_account_id()
         AND samurai_can_workspace(workspace_id, 'guest')
       )`,
      `CREATE OR REPLACE FUNCTION samurai_finalize_workspace_file_transaction(
        target_workspace_id TEXT,
        target_transaction_id TEXT
      ) RETURNS BOOLEAN
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE transaction_room_id TEXT;
      DECLARE transaction_state TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id() THEN
          RAISE EXCEPTION 'workspace_file_transaction_invalid';
        END IF;
        SELECT room_id, status INTO transaction_room_id, transaction_state
        FROM workspace_file_transactions
        WHERE workspace_id = target_workspace_id AND id = target_transaction_id
        FOR UPDATE;
        IF NOT FOUND OR NOT samurai_can_room(target_workspace_id, transaction_room_id, 'edit') THEN
          RAISE EXCEPTION 'workspace_file_transaction_not_found_or_access_denied';
        END IF;
        IF transaction_state = 'renamed' THEN RETURN TRUE; END IF;
        IF transaction_state <> 'db_committed' THEN
          RAISE EXCEPTION 'workspace_file_transaction_invalid';
        END IF;
        UPDATE workspace_file_transactions
        SET status = 'renamed', updated_at = NOW()
        WHERE workspace_id = target_workspace_id AND id = target_transaction_id AND status = 'db_committed';
        RETURN FOUND;
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_finalize_workspace_file_transaction(TEXT, TEXT) FROM PUBLIC"
    ]
  },
  {
    version: 17,
    name: "workspace_server_operation_completion_and_transfer_receipt_guards",
    statements: [
      // Keep migrations immutable: this follows the first operation guard
      // rather than rewriting it. A member may revoke their own access in an
      // operation, and that already-created operation must still be able to
      // record its completed result without giving a non-member write access.
      `CREATE OR REPLACE FUNCTION samurai_has_workspace_membership(target_workspace_id TEXT)
      RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT target_workspace_id = samurai_current_workspace_id()
          AND EXISTS (
            SELECT 1
            FROM workspace_members
            WHERE workspace_id = target_workspace_id
              AND account_id = samurai_current_account_id()
          )
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_has_workspace_membership(TEXT) FROM PUBLIC",
      `ALTER POLICY workspace_operations_access ON workspace_operations
       WITH CHECK (
         workspace_id = samurai_current_workspace_id()
         AND actor_account_id = samurai_current_account_id()
         AND samurai_has_workspace_membership(workspace_id)
       )`,
      `CREATE OR REPLACE FUNCTION samurai_record_workspace_transfer_receipt(
        target_workspace_id TEXT,
        target_transfer_id TEXT,
        target_destination_workspace_id TEXT,
        target_receipt JSONB
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE exported_hash TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        SELECT bundle_hash INTO exported_hash FROM workspace_transfers
        WHERE workspace_id = target_workspace_id AND id = target_transfer_id AND state = 'exported'
        FOR UPDATE;
        IF NOT FOUND OR exported_hash IS NULL
          OR target_receipt->>'format_version' IS DISTINCT FROM '1'
          OR target_receipt->>'transfer_id' IS DISTINCT FROM target_transfer_id
          OR target_receipt->>'source_workspace_id' IS DISTINCT FROM target_workspace_id
          OR target_receipt->>'source_integrity_hash' IS DISTINCT FROM exported_hash
          OR target_receipt->>'target_workspace_id' IS DISTINCT FROM target_destination_workspace_id
          OR target_receipt->>'target_integrity_hash' IS DISTINCT FROM exported_hash
          OR target_receipt->>'source_integrity_hash' !~ '^[a-f0-9]{64}$'
          OR target_receipt->>'target_integrity_hash' !~ '^[a-f0-9]{64}$' THEN
          RAISE EXCEPTION 'workspace_transfer_receipt_invalid';
        END IF;
        UPDATE workspace_transfers
        SET state = 'imported', target_workspace_id = target_destination_workspace_id,
            target_receipt = target_receipt, version = version + 1, updated_at = NOW()
        WHERE workspace_id = target_workspace_id AND id = target_transfer_id AND state = 'exported';
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_record_workspace_transfer_receipt(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC"
    ]
  },
  {
    version: 18,
    name: "workspace_server_operation_ledger_is_actor_immutable",
    statements: [
      // An operation ledger is a retry record, not an admin-editable object.
      // A fresh operation requires active access; an already-created operation
      // may still finish after it revokes the actor's own membership.
      "DROP POLICY workspace_operations_access ON workspace_operations",
      `CREATE POLICY workspace_operations_read ON workspace_operations FOR SELECT USING (
        workspace_id = samurai_current_workspace_id()
        AND actor_account_id = samurai_current_account_id()
      )`,
      `CREATE POLICY workspace_operations_insert ON workspace_operations FOR INSERT WITH CHECK (
        workspace_id = samurai_current_workspace_id()
        AND actor_account_id = samurai_current_account_id()
        AND samurai_can_workspace(workspace_id, 'guest')
      )`,
      `CREATE POLICY workspace_operations_update ON workspace_operations FOR UPDATE
       USING (
         workspace_id = samurai_current_workspace_id()
         AND actor_account_id = samurai_current_account_id()
       )
       WITH CHECK (
         workspace_id = samurai_current_workspace_id()
         AND actor_account_id = samurai_current_account_id()
         AND samurai_has_workspace_membership(workspace_id)
      )`
    ]
  },
  {
    version: 19,
    name: "workspace_server_transfer_export_retry_is_idempotent",
    statements: [
      // A process can finish copying a Bundle just as a retry arrives. Lock
      // the transfer row and accept only the exact previously exported Bundle
      // so retrying can never overwrite a completed transfer with new data.
      `CREATE OR REPLACE FUNCTION samurai_record_workspace_bundle(
        target_workspace_id TEXT,
        target_bundle_id TEXT,
        target_path TEXT,
        target_hash TEXT,
        target_record_counts JSONB,
        target_transfer_id TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE transfer_state TEXT;
      DECLARE transfer_path TEXT;
      DECLARE transfer_hash TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        IF target_transfer_id IS NOT NULL THEN
          SELECT state, bundle_path, bundle_hash
          INTO transfer_state, transfer_path, transfer_hash
          FROM workspace_transfers
          WHERE workspace_id = target_workspace_id AND id = target_transfer_id
          FOR UPDATE;
          IF NOT FOUND THEN RAISE EXCEPTION 'workspace_transfer_not_ready'; END IF;
          IF transfer_state = 'exported' THEN
            IF transfer_path IS NOT DISTINCT FROM target_path
              AND transfer_hash IS NOT DISTINCT FROM target_hash
              AND EXISTS (
                SELECT 1 FROM workspace_bundles
                WHERE workspace_id = target_workspace_id AND id = target_bundle_id
                  AND path = target_path AND sha256 = target_hash
              ) THEN
              RETURN;
            END IF;
            RAISE EXCEPTION 'workspace_transfer_bundle_conflict';
          END IF;
          IF transfer_state <> 'preparing' THEN RAISE EXCEPTION 'workspace_transfer_not_ready'; END IF;
        END IF;
        INSERT INTO workspace_bundles(workspace_id, id, format_version, path, sha256, record_counts, created_by)
        VALUES (target_workspace_id, target_bundle_id, 3, target_path, target_hash, target_record_counts, samurai_current_account_id())
        ON CONFLICT (workspace_id, id) DO UPDATE SET
          path = EXCLUDED.path, sha256 = EXCLUDED.sha256, record_counts = EXCLUDED.record_counts;
        IF target_transfer_id IS NOT NULL THEN
          UPDATE workspace_transfers
          SET state = 'exported', bundle_path = target_path, bundle_hash = target_hash,
              version = version + 1, updated_at = NOW()
          WHERE workspace_id = target_workspace_id AND id = target_transfer_id AND state = 'preparing';
          IF NOT FOUND THEN RAISE EXCEPTION 'workspace_transfer_not_ready'; END IF;
        END IF;
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_record_workspace_bundle(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC"
    ]
  },
  {
    version: 20,
    name: "workspace_server_audit_history_respects_room_access",
    statements: [
      // A Room audit is Knowledge/history inside that Room. Losing Room
      // access must also remove that history from RLS results; only
      // Workspace-level own actions remain visible to a non-admin member.
      "DROP POLICY workspace_audit_entries_read ON workspace_audit_entries",
      `CREATE POLICY workspace_audit_entries_read ON workspace_audit_entries FOR SELECT USING (
        workspace_id = samurai_current_workspace_id()
        AND (
          samurai_can_workspace(workspace_id, 'admin')
          OR (room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read'))
          OR (room_id IS NULL AND actor_account_id = samurai_current_account_id())
        )
      )`
    ]
  },
  {
    version: 21,
    name: "workspace_server_bundle_account_status_is_not_escalated",
    statements: [
      // Account status is server-wide. A Bundle may add a previously unknown
      // identity for historical references, but it must never turn a disabled
      // identity into an active one or change an existing server Account.
      `CREATE OR REPLACE FUNCTION samurai_import_workspace_account_identity(
        target_workspace_id TEXT,
        target_account_id TEXT,
        target_public_key TEXT,
        target_display_name TEXT,
        target_status TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing_key TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id)
          OR target_status NOT IN ('active', 'disabled') THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        SELECT public_key INTO existing_key FROM accounts WHERE id = target_account_id FOR UPDATE;
        IF FOUND THEN
          IF existing_key <> target_public_key THEN RAISE EXCEPTION 'account_public_key_conflict'; END IF;
          RETURN;
        END IF;
        INSERT INTO accounts(id, public_key, display_name, status)
        VALUES (target_account_id, target_public_key, target_display_name, target_status);
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_import_workspace_account_identity(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC"
    ]
  },
  {
    version: 22,
    name: "workspace_server_room_hierarchy_and_membership_guards",
    statements: [
      // A Workspace remains the top-level owner.  A Room may have one Room
      // parent, or no parent when it is directly below the Workspace.
      "ALTER TABLE rooms ADD COLUMN parent_room_id TEXT",
      "ALTER TABLE rooms ADD CONSTRAINT rooms_parent_room_not_self CHECK (parent_room_id IS NULL OR parent_room_id <> id)",
      "ALTER TABLE rooms ADD CONSTRAINT rooms_parent_room_same_workspace_fkey FOREIGN KEY (workspace_id, parent_room_id) REFERENCES rooms(workspace_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED",
      "CREATE INDEX rooms_workspace_parent_created_index ON rooms(workspace_id, parent_room_id, created_at)",
      // A direct Room row never revives access after the Account has left the
      // Workspace. Workspace Owner/Admin access remains the existing global
      // management exception; ordinary parent membership still does not make
      // a child Room readable.
      `CREATE OR REPLACE FUNCTION samurai_room_role(target_workspace_id TEXT, target_room_id TEXT)
      RETURNS TEXT
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
      DECLARE workspace_role_name TEXT;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM workspace_members
          WHERE workspace_id = target_workspace_id
            AND account_id = samurai_current_account_id()
            AND state = 'active'
        ) THEN
          RETURN NULL;
        END IF;
        workspace_role_name := samurai_workspace_role(target_workspace_id);
        IF samurai_role_rank(workspace_role_name) >= samurai_role_rank('admin') THEN
          RETURN workspace_role_name;
        END IF;
        RETURN (
          SELECT role
          FROM room_members
          WHERE workspace_id = target_workspace_id
            AND room_id = target_room_id
            AND account_id = samurai_current_account_id()
            AND state = 'active'
          LIMIT 1
        );
      END
      $$`,
      `ALTER POLICY room_members_read ON room_members
       USING (
         workspace_id = samurai_current_workspace_id()
         AND samurai_can_room(workspace_id, room_id, 'read')
         AND (account_id = samurai_current_account_id() OR samurai_can_room(workspace_id, room_id, 'manage'))
       )`,
      // Workspace membership changes participate in the same short lock as
      // Room hierarchy changes. Without this, a concurrent Workspace revoke
      // could interleave with a child-Room membership update.
      `CREATE OR REPLACE FUNCTION samurai_set_workspace_member(
        target_workspace_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT,
        target_expected_version BIGINT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing_member workspace_members%ROWTYPE;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.room_hierarchy:' || target_workspace_id, 0));
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
          RAISE EXCEPTION 'workspace_permission_denied';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF target_role NOT IN ('owner', 'admin', 'member', 'guest') OR target_state NOT IN ('active', 'revoked') THEN
          RAISE EXCEPTION 'workspace_membership_invalid';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.owner:' || target_workspace_id, 0));
        SELECT * INTO existing_member
        FROM workspace_members
        WHERE workspace_id = target_workspace_id AND account_id = target_account_id
        FOR UPDATE;
        IF COALESCE(existing_member.version, 0) <> target_expected_version THEN
          RAISE EXCEPTION 'workspace_membership_version_conflict';
        END IF;
        IF target_role = 'owner' AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        IF FOUND AND existing_member.role = 'owner' AND existing_member.state = 'active'
          AND (target_role <> 'owner' OR target_state <> 'active') THEN
          IF NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
            RAISE EXCEPTION 'workspace_owner_permission_required';
          END IF;
          IF (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = target_workspace_id AND role = 'owner' AND state = 'active') <= 1 THEN
            RAISE EXCEPTION 'workspace_last_owner_cannot_be_revoked';
          END IF;
        END IF;
        INSERT INTO workspace_members(workspace_id, account_id, role, state, version, revoked_at, updated_at)
        VALUES (target_workspace_id, target_account_id, target_role, target_state, 1,
          CASE WHEN target_state = 'revoked' THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET
          role = EXCLUDED.role,
          state = EXCLUDED.state,
          version = workspace_members.version + 1,
          revoked_at = EXCLUDED.revoked_at,
          updated_at = NOW();
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_create_room(
        target_workspace_id TEXT,
        new_room_id TEXT,
        new_room_name TEXT,
        target_parent_room_id TEXT,
        target_workspace_version BIGINT
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE current_workspace_version BIGINT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.room_hierarchy:' || target_workspace_id, 0));
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id() THEN
          RAISE EXCEPTION 'workspace_permission_denied';
        END IF;
        SELECT version INTO current_workspace_version FROM workspaces
        WHERE id = target_workspace_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_not_found'; END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF current_workspace_version IS DISTINCT FROM target_workspace_version THEN
          RAISE EXCEPTION 'workspace_version_conflict';
        END IF;
        IF target_parent_room_id IS NULL THEN
          IF NOT samurai_can_workspace(target_workspace_id, 'member') THEN
            RAISE EXCEPTION 'workspace_permission_denied';
          END IF;
        ELSE
          IF NOT EXISTS (
            SELECT 1 FROM rooms
            WHERE workspace_id = target_workspace_id AND id = target_parent_room_id
          ) THEN RAISE EXCEPTION 'room_parent_not_found'; END IF;
          IF NOT samurai_can_room(target_workspace_id, target_parent_room_id, 'manage') THEN
            RAISE EXCEPTION 'room_parent_permission_denied';
          END IF;
          IF EXISTS (
            WITH RECURSIVE ancestors(room_id, parent_room_id) AS (
              SELECT id, parent_room_id FROM rooms
              WHERE workspace_id = target_workspace_id AND id = target_parent_room_id
              UNION ALL
              SELECT parent.id, parent.parent_room_id FROM rooms AS parent
              JOIN ancestors ON ancestors.parent_room_id = parent.id
              WHERE parent.workspace_id = target_workspace_id
            )
            SELECT 1 FROM ancestors
            WHERE NOT EXISTS (
              SELECT 1 FROM room_members
              WHERE workspace_id = target_workspace_id
                AND room_id = ancestors.room_id
                AND account_id = samurai_current_account_id()
                AND state = 'active'
            )
          ) THEN RAISE EXCEPTION 'room_parent_membership_required'; END IF;
        END IF;
        INSERT INTO rooms(workspace_id, id, parent_room_id, name, created_by)
        VALUES (target_workspace_id, new_room_id, target_parent_room_id, new_room_name, samurai_current_account_id());
        INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version)
        VALUES (target_workspace_id, new_room_id, samurai_current_account_id(), 'owner', 'active', 1);
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
        RETURN new_room_id;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_move_room(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_parent_room_id TEXT,
        target_expected_room_version BIGINT,
        target_expected_workspace_version BIGINT
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE current_workspace_version BIGINT;
      DECLARE current_room_version BIGINT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.room_hierarchy:' || target_workspace_id, 0));
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_room(target_workspace_id, target_room_id, 'manage') THEN
          RAISE EXCEPTION 'room_permission_denied';
        END IF;
        SELECT version INTO current_workspace_version FROM workspaces
        WHERE id = target_workspace_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_not_found'; END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF current_workspace_version IS DISTINCT FROM target_expected_workspace_version THEN
          RAISE EXCEPTION 'workspace_version_conflict';
        END IF;
        SELECT version INTO current_room_version FROM rooms
        WHERE workspace_id = target_workspace_id AND id = target_room_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'room_not_found'; END IF;
        IF current_room_version IS DISTINCT FROM target_expected_room_version THEN
          RAISE EXCEPTION 'room_version_conflict';
        END IF;
        IF target_parent_room_id IS NULL THEN
          IF NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
            RAISE EXCEPTION 'workspace_admin_permission_required';
          END IF;
        ELSE
          IF target_parent_room_id = target_room_id THEN RAISE EXCEPTION 'room_hierarchy_cycle'; END IF;
          IF NOT EXISTS (
            SELECT 1 FROM rooms
            WHERE workspace_id = target_workspace_id AND id = target_parent_room_id
          ) THEN RAISE EXCEPTION 'room_parent_not_found'; END IF;
          IF NOT samurai_can_room(target_workspace_id, target_parent_room_id, 'manage') THEN
            RAISE EXCEPTION 'room_parent_permission_denied';
          END IF;
          IF EXISTS (
            WITH RECURSIVE descendants(room_id) AS (
              SELECT target_room_id
              UNION ALL
              SELECT room.id FROM rooms AS room
              JOIN descendants ON room.parent_room_id = descendants.room_id
              WHERE room.workspace_id = target_workspace_id
            )
            SELECT 1 FROM descendants WHERE room_id = target_parent_room_id
          ) THEN RAISE EXCEPTION 'room_hierarchy_cycle'; END IF;
          IF EXISTS (
            WITH RECURSIVE descendants(room_id) AS (
              SELECT target_room_id
              UNION ALL
              SELECT room.id FROM rooms AS room
              JOIN descendants ON room.parent_room_id = descendants.room_id
              WHERE room.workspace_id = target_workspace_id
            ),
            ancestors(room_id, parent_room_id) AS (
              SELECT id, parent_room_id FROM rooms
              WHERE workspace_id = target_workspace_id AND id = target_parent_room_id
              UNION ALL
              SELECT parent.id, parent.parent_room_id FROM rooms AS parent
              JOIN ancestors ON ancestors.parent_room_id = parent.id
              WHERE parent.workspace_id = target_workspace_id
            )
            SELECT 1
            FROM room_members AS child_member
            JOIN descendants ON descendants.room_id = child_member.room_id
            CROSS JOIN ancestors
            LEFT JOIN room_members AS parent_member
              ON parent_member.workspace_id = target_workspace_id
             AND parent_member.room_id = ancestors.room_id
             AND parent_member.account_id = child_member.account_id
             AND parent_member.state = 'active'
            WHERE child_member.workspace_id = target_workspace_id
              AND child_member.state = 'active'
              AND parent_member.account_id IS NULL
          ) THEN RAISE EXCEPTION 'room_move_parent_membership_required'; END IF;
        END IF;
        UPDATE rooms
        SET parent_room_id = target_parent_room_id, version = version + 1, updated_at = NOW()
        WHERE workspace_id = target_workspace_id AND id = target_room_id;
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
        RETURN (
          WITH RECURSIVE descendants(room_id) AS (
            SELECT target_room_id
            UNION ALL
            SELECT room.id FROM rooms AS room
            JOIN descendants ON room.parent_room_id = descendants.room_id
            WHERE room.workspace_id = target_workspace_id
          )
          SELECT jsonb_build_object(
            'room_id', target_room_id,
            'parent_room_id', target_parent_room_id,
            'affected_room_ids', COALESCE(jsonb_agg(room_id ORDER BY room_id), '[]'::JSONB)
          )
          FROM descendants
        );
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_preview_room_move(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_parent_room_id TEXT
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE blocking_account_ids TEXT[];
      DECLARE required_ancestor_room_ids TEXT[];
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_room(target_workspace_id, target_room_id, 'manage') THEN
          RAISE EXCEPTION 'room_permission_denied';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM rooms WHERE workspace_id = target_workspace_id AND id = target_room_id) THEN
          RAISE EXCEPTION 'room_not_found';
        END IF;
        IF target_parent_room_id IS NULL THEN
          IF NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
            RAISE EXCEPTION 'workspace_admin_permission_required';
          END IF;
          RETURN jsonb_build_object('allowed', true, 'blocking_account_ids', '[]'::JSONB, 'required_ancestor_room_ids', '[]'::JSONB);
        END IF;
        IF target_parent_room_id = target_room_id THEN
          RETURN jsonb_build_object('allowed', false, 'reason', 'room_hierarchy_cycle', 'blocking_account_ids', '[]'::JSONB, 'required_ancestor_room_ids', '[]'::JSONB);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM rooms WHERE workspace_id = target_workspace_id AND id = target_parent_room_id) THEN
          RAISE EXCEPTION 'room_parent_not_found';
        END IF;
        IF NOT samurai_can_room(target_workspace_id, target_parent_room_id, 'manage') THEN
          RAISE EXCEPTION 'room_parent_permission_denied';
        END IF;
        IF EXISTS (
          WITH RECURSIVE descendants(room_id) AS (
            SELECT target_room_id
            UNION ALL
            SELECT room.id FROM rooms AS room
            JOIN descendants ON room.parent_room_id = descendants.room_id
            WHERE room.workspace_id = target_workspace_id
          )
          SELECT 1 FROM descendants WHERE room_id = target_parent_room_id
        ) THEN
          RETURN jsonb_build_object('allowed', false, 'reason', 'room_hierarchy_cycle', 'blocking_account_ids', '[]'::JSONB, 'required_ancestor_room_ids', '[]'::JSONB);
        END IF;
        WITH RECURSIVE descendants(room_id) AS (
          SELECT target_room_id
          UNION ALL
          SELECT room.id FROM rooms AS room
          JOIN descendants ON room.parent_room_id = descendants.room_id
          WHERE room.workspace_id = target_workspace_id
        ),
        ancestors(room_id, parent_room_id) AS (
          SELECT id, parent_room_id FROM rooms
          WHERE workspace_id = target_workspace_id AND id = target_parent_room_id
          UNION ALL
          SELECT parent.id, parent.parent_room_id FROM rooms AS parent
          JOIN ancestors ON ancestors.parent_room_id = parent.id
          WHERE parent.workspace_id = target_workspace_id
        ),
        missing AS (
          SELECT DISTINCT child_member.account_id
          FROM room_members AS child_member
          JOIN descendants ON descendants.room_id = child_member.room_id
          CROSS JOIN ancestors
          LEFT JOIN room_members AS parent_member
            ON parent_member.workspace_id = target_workspace_id
           AND parent_member.room_id = ancestors.room_id
           AND parent_member.account_id = child_member.account_id
           AND parent_member.state = 'active'
          WHERE child_member.workspace_id = target_workspace_id
            AND child_member.state = 'active'
            AND parent_member.account_id IS NULL
        )
        SELECT
          COALESCE((SELECT array_agg(account_id ORDER BY account_id) FROM missing), ARRAY[]::TEXT[]),
          COALESCE((SELECT array_agg(room_id ORDER BY room_id) FROM ancestors), ARRAY[]::TEXT[])
        INTO blocking_account_ids, required_ancestor_room_ids;
        RETURN jsonb_build_object(
          'allowed', cardinality(blocking_account_ids) = 0,
          'reason', CASE WHEN cardinality(blocking_account_ids) = 0 THEN NULL ELSE 'room_move_parent_membership_required' END,
          'blocking_account_ids', to_jsonb(blocking_account_ids),
          'required_ancestor_room_ids', to_jsonb(required_ancestor_room_ids)
        );
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_set_room_member_with_impact(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT,
        target_expected_version BIGINT
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing_member room_members%ROWTYPE;
      DECLARE has_existing BOOLEAN;
      DECLARE affected_room_ids TEXT[];
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.room_hierarchy:' || target_workspace_id, 0));
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_room(target_workspace_id, target_room_id, 'manage') THEN
          RAISE EXCEPTION 'room_permission_denied';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF NOT EXISTS (SELECT 1 FROM rooms WHERE workspace_id = target_workspace_id AND id = target_room_id) THEN
          RAISE EXCEPTION 'room_not_found';
        END IF;
        IF target_role NOT IN ('owner', 'admin', 'member', 'guest') OR target_state NOT IN ('active', 'revoked') THEN
          RAISE EXCEPTION 'room_membership_invalid';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM workspace_members
          WHERE workspace_id = target_workspace_id AND account_id = target_account_id AND state = 'active'
        ) THEN RAISE EXCEPTION 'workspace_membership_required'; END IF;
        SELECT * INTO existing_member FROM room_members
        WHERE workspace_id = target_workspace_id AND room_id = target_room_id AND account_id = target_account_id
        FOR UPDATE;
        has_existing := FOUND;
        IF COALESCE(existing_member.version, 0) <> target_expected_version THEN
          RAISE EXCEPTION 'room_membership_version_conflict';
        END IF;
        IF target_role = 'owner' AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        IF has_existing AND existing_member.role = 'owner' AND existing_member.state = 'active'
          AND (target_role <> 'owner' OR target_state <> 'active')
          AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        -- A role demotion is not a removal cascade, but it still cannot leave
        -- the directly changed Room without an Owner.
        IF has_existing AND existing_member.role = 'owner' AND existing_member.state = 'active'
          AND target_state = 'active' AND target_role <> 'owner'
          AND NOT EXISTS (
            SELECT 1 FROM room_members AS another_owner
            WHERE another_owner.workspace_id = target_workspace_id
              AND another_owner.room_id = target_room_id
              AND another_owner.account_id <> target_account_id
              AND another_owner.role = 'owner'
              AND another_owner.state = 'active'
          ) THEN RAISE EXCEPTION 'room_last_owner_cannot_be_removed'; END IF;
        IF target_state = 'active' AND EXISTS (
          WITH RECURSIVE ancestors(room_id, parent_room_id) AS (
            SELECT parent.id, parent.parent_room_id
            FROM rooms AS room
            JOIN rooms AS parent
              ON parent.workspace_id = room.workspace_id AND parent.id = room.parent_room_id
            WHERE room.workspace_id = target_workspace_id AND room.id = target_room_id
            UNION ALL
            SELECT parent.id, parent.parent_room_id
            FROM rooms AS parent
            JOIN ancestors ON ancestors.parent_room_id = parent.id
            WHERE parent.workspace_id = target_workspace_id
          )
          SELECT 1 FROM ancestors
          WHERE NOT EXISTS (
            SELECT 1 FROM room_members
            WHERE workspace_id = target_workspace_id
              AND room_id = ancestors.room_id
              AND account_id = target_account_id
              AND state = 'active'
          )
        ) THEN RAISE EXCEPTION 'room_parent_membership_required'; END IF;
        IF target_state = 'revoked' THEN
          IF EXISTS (
            WITH RECURSIVE descendants(room_id) AS (
              SELECT target_room_id
              UNION ALL
              SELECT room.id FROM rooms AS room
              JOIN descendants ON room.parent_room_id = descendants.room_id
              WHERE room.workspace_id = target_workspace_id
            )
            SELECT 1 FROM room_members AS member
            JOIN descendants ON descendants.room_id = member.room_id
            WHERE member.workspace_id = target_workspace_id
              AND member.account_id = target_account_id
              AND member.state = 'active'
              AND member.role = 'owner'
          ) AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
            RAISE EXCEPTION 'workspace_owner_permission_required';
          END IF;
          IF EXISTS (
            WITH RECURSIVE descendants(room_id) AS (
              SELECT target_room_id
              UNION ALL
              SELECT room.id FROM rooms AS room
              JOIN descendants ON room.parent_room_id = descendants.room_id
              WHERE room.workspace_id = target_workspace_id
            )
            SELECT 1 FROM room_members AS member
            JOIN descendants ON descendants.room_id = member.room_id
            WHERE member.workspace_id = target_workspace_id
              AND member.account_id = target_account_id
              AND member.state = 'active'
              AND member.role = 'owner'
              AND NOT EXISTS (
                SELECT 1 FROM room_members AS another_owner
                WHERE another_owner.workspace_id = member.workspace_id
                  AND another_owner.room_id = member.room_id
                  AND another_owner.account_id <> target_account_id
                  AND another_owner.role = 'owner'
                  AND another_owner.state = 'active'
              )
          ) THEN RAISE EXCEPTION 'room_last_owner_cannot_be_removed'; END IF;
          WITH RECURSIVE descendants(room_id) AS (
            SELECT target_room_id
            UNION ALL
            SELECT room.id FROM rooms AS room
            JOIN descendants ON room.parent_room_id = descendants.room_id
            WHERE room.workspace_id = target_workspace_id
          )
          SELECT COALESCE(array_agg(member.room_id ORDER BY member.room_id), ARRAY[target_room_id])
          INTO affected_room_ids
          FROM room_members AS member
          JOIN descendants ON descendants.room_id = member.room_id
          WHERE member.workspace_id = target_workspace_id
            AND member.account_id = target_account_id
            AND member.state = 'active';
          WITH RECURSIVE descendants(room_id) AS (
            SELECT target_room_id
            UNION ALL
            SELECT room.id FROM rooms AS room
            JOIN descendants ON room.parent_room_id = descendants.room_id
            WHERE room.workspace_id = target_workspace_id
          )
          UPDATE room_members AS member
          SET role = CASE WHEN member.room_id = target_room_id THEN target_role ELSE member.role END,
              state = 'revoked',
              version = member.version + 1,
              revoked_at = NOW(),
              updated_at = NOW()
          FROM descendants
          WHERE member.workspace_id = target_workspace_id
            AND member.room_id = descendants.room_id
            AND member.account_id = target_account_id
            AND member.state = 'active';
          IF NOT has_existing THEN
            INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version, revoked_at, updated_at)
            VALUES (target_workspace_id, target_room_id, target_account_id, target_role, 'revoked', 1, NOW(), NOW());
          ELSIF existing_member.state = 'revoked' THEN
            UPDATE room_members
            SET role = target_role, state = 'revoked', version = version + 1, revoked_at = NOW(), updated_at = NOW()
            WHERE workspace_id = target_workspace_id AND room_id = target_room_id AND account_id = target_account_id;
          END IF;
        ELSE
          INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version, revoked_at, updated_at)
          VALUES (target_workspace_id, target_room_id, target_account_id, target_role, 'active', 1, NULL, NOW())
          ON CONFLICT (workspace_id, room_id, account_id) DO UPDATE SET
            role = EXCLUDED.role, state = 'active', version = room_members.version + 1,
            revoked_at = NULL, updated_at = NOW();
          affected_room_ids := ARRAY[target_room_id];
        END IF;
        RETURN jsonb_build_object('affected_room_ids', to_jsonb(affected_room_ids));
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_preview_room_member_change(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE affected_room_ids TEXT[];
      DECLARE blocking_owner_room_ids TEXT[];
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_room(target_workspace_id, target_room_id, 'manage') THEN
          RAISE EXCEPTION 'room_permission_denied';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM rooms
          WHERE workspace_id = target_workspace_id AND id = target_room_id
        ) THEN RAISE EXCEPTION 'room_not_found'; END IF;
        IF target_state <> 'revoked' THEN
          RETURN jsonb_build_object('affected_room_ids', to_jsonb(ARRAY[target_room_id]), 'blocking_owner_room_ids', '[]'::JSONB);
        END IF;
        WITH RECURSIVE descendants(room_id) AS (
          SELECT target_room_id
          UNION ALL
          SELECT room.id FROM rooms AS room
          JOIN descendants ON room.parent_room_id = descendants.room_id
          WHERE room.workspace_id = target_workspace_id
        ),
        active_rows AS (
          SELECT member.room_id, member.role FROM room_members AS member
          JOIN descendants ON descendants.room_id = member.room_id
          WHERE member.workspace_id = target_workspace_id
            AND member.account_id = target_account_id
            AND member.state = 'active'
        )
        SELECT
          COALESCE((SELECT array_agg(room_id ORDER BY room_id) FROM active_rows), ARRAY[target_room_id]),
          COALESCE((
            SELECT array_agg(room_id ORDER BY room_id)
            FROM active_rows AS active_owner
            WHERE active_owner.role = 'owner'
              AND NOT EXISTS (
                SELECT 1 FROM room_members AS another_owner
                WHERE another_owner.workspace_id = target_workspace_id
                  AND another_owner.room_id = active_owner.room_id
                  AND another_owner.account_id <> target_account_id
                  AND another_owner.role = 'owner'
                  AND another_owner.state = 'active'
              )
          ), ARRAY[]::TEXT[])
        INTO affected_room_ids, blocking_owner_room_ids;
        RETURN jsonb_build_object(
          'affected_room_ids', to_jsonb(affected_room_ids),
          'blocking_owner_room_ids', to_jsonb(blocking_owner_room_ids)
        );
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_import_workspace_room(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_parent_room_id TEXT,
        target_name TEXT,
        target_version BIGINT,
        target_created_by TEXT,
        target_created_at TIMESTAMPTZ,
        target_updated_at TIMESTAMPTZ
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        INSERT INTO rooms(workspace_id, id, parent_room_id, name, version, created_by, created_at, updated_at)
        VALUES (target_workspace_id, target_room_id, target_parent_room_id, target_name, target_version, target_created_by, target_created_at, target_updated_at);
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_import_workspace_room_member(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT,
        target_version BIGINT,
        target_created_at TIMESTAMPTZ,
        target_updated_at TIMESTAMPTZ,
        target_revoked_at TIMESTAMPTZ
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version, created_at, updated_at, revoked_at)
        VALUES (target_workspace_id, target_room_id, target_account_id, target_role, target_state, target_version, target_created_at, target_updated_at, target_revoked_at);
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_validate_workspace_room_hierarchy(
        target_workspace_id TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        IF EXISTS (
          WITH RECURSIVE walk(room_id, parent_room_id, path, cycle) AS (
            SELECT id, parent_room_id, ARRAY[id], false FROM rooms
            WHERE workspace_id = target_workspace_id
            UNION ALL
            SELECT parent.id, parent.parent_room_id, walk.path || parent.id, parent.id = ANY(walk.path)
            FROM rooms AS parent
            JOIN walk ON parent.id = walk.parent_room_id
            WHERE parent.workspace_id = target_workspace_id AND NOT walk.cycle
          )
          SELECT 1 FROM walk WHERE cycle
        ) THEN RAISE EXCEPTION 'room_bundle_hierarchy_cycle'; END IF;
        IF EXISTS (
          WITH RECURSIVE ancestry(descendant_room_id, ancestor_room_id) AS (
            SELECT id, parent_room_id FROM rooms
            WHERE workspace_id = target_workspace_id AND parent_room_id IS NOT NULL
            UNION ALL
            SELECT ancestry.descendant_room_id, parent.parent_room_id
            FROM ancestry
            JOIN rooms AS parent
              ON parent.workspace_id = target_workspace_id AND parent.id = ancestry.ancestor_room_id
            WHERE parent.parent_room_id IS NOT NULL
          )
          SELECT 1
          FROM room_members AS child_member
          JOIN ancestry ON ancestry.descendant_room_id = child_member.room_id
          LEFT JOIN room_members AS parent_member
            ON parent_member.workspace_id = target_workspace_id
           AND parent_member.room_id = ancestry.ancestor_room_id
           AND parent_member.account_id = child_member.account_id
           AND parent_member.state = 'active'
          WHERE child_member.workspace_id = target_workspace_id
            AND child_member.state = 'active'
            AND parent_member.account_id IS NULL
        ) THEN RAISE EXCEPTION 'room_bundle_parent_membership_invalid'; END IF;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_accept_invitation(target_workspace_id TEXT, supplied_token_hash TEXT)
      RETURNS TABLE(workspace_role TEXT, room_id TEXT, room_role TEXT, invitation_version BIGINT)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE invitation workspace_invitations%ROWTYPE;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.room_hierarchy:' || target_workspace_id, 0));
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR samurai_current_account_id() IS NULL THEN
          RAISE EXCEPTION 'workspace_invitation_invalid';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        SELECT * INTO invitation
        FROM workspace_invitations
        WHERE workspace_id = target_workspace_id
          AND token_hash = supplied_token_hash
          AND revoked_at IS NULL
          AND accepted_at IS NULL
          AND expires_at > NOW()
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_invitation_invalid'; END IF;
        INSERT INTO workspace_members(workspace_id, account_id, role, state, version, updated_at)
        VALUES (target_workspace_id, samurai_current_account_id(), invitation.workspace_role, 'active', 1, NOW())
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET
          role = CASE WHEN samurai_role_rank(EXCLUDED.role) > samurai_role_rank(workspace_members.role) THEN EXCLUDED.role ELSE workspace_members.role END,
          state = 'active', revoked_at = NULL, version = workspace_members.version + 1, updated_at = NOW();
        IF invitation.room_id IS NOT NULL THEN
          IF NOT EXISTS (
            SELECT 1 FROM rooms WHERE workspace_id = target_workspace_id AND id = invitation.room_id
          ) THEN RAISE EXCEPTION 'room_not_found'; END IF;
          IF EXISTS (
            WITH RECURSIVE ancestors(room_id, parent_room_id) AS (
              SELECT parent.id, parent.parent_room_id
              FROM rooms AS room
              JOIN rooms AS parent
                ON parent.workspace_id = room.workspace_id AND parent.id = room.parent_room_id
              WHERE room.workspace_id = target_workspace_id AND room.id = invitation.room_id
              UNION ALL
              SELECT parent.id, parent.parent_room_id
              FROM rooms AS parent
              JOIN ancestors ON ancestors.parent_room_id = parent.id
              WHERE parent.workspace_id = target_workspace_id
            )
            SELECT 1 FROM ancestors
            WHERE NOT EXISTS (
              SELECT 1 FROM room_members
              WHERE workspace_id = target_workspace_id
                AND room_id = ancestors.room_id
                AND account_id = samurai_current_account_id()
                AND state = 'active'
            )
          ) THEN RAISE EXCEPTION 'room_parent_membership_required'; END IF;
          INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version, updated_at)
          VALUES (target_workspace_id, invitation.room_id, samurai_current_account_id(), COALESCE(invitation.room_role, invitation.workspace_role), 'active', 1, NOW())
          ON CONFLICT (workspace_id, room_id, account_id) DO UPDATE SET
            role = CASE WHEN samurai_role_rank(EXCLUDED.role) > samurai_role_rank(room_members.role) THEN EXCLUDED.role ELSE room_members.role END,
            state = 'active', revoked_at = NULL, version = room_members.version + 1, updated_at = NOW();
        END IF;
        UPDATE workspace_invitations
        SET accepted_by = samurai_current_account_id(), accepted_at = NOW(), version = version + 1
        WHERE workspace_id = target_workspace_id AND id = invitation.id
        RETURNING version INTO invitation_version;
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
        RETURN QUERY SELECT invitation.workspace_role, invitation.room_id, invitation.room_role, invitation_version;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_complete_workspace_import(
        target_workspace_id TEXT,
        import_session_id TEXT,
        target_manifest_hash TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR samurai_context_value('samurai.import_id') IS DISTINCT FROM import_session_id
          OR NOT samurai_is_import_session(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        PERFORM samurai_validate_workspace_room_hierarchy(target_workspace_id);
        IF NOT EXISTS (
          SELECT 1 FROM workspace_members
          WHERE workspace_id = target_workspace_id AND role = 'owner' AND state = 'active'
        ) THEN RAISE EXCEPTION 'workspace_import_owner_missing'; END IF;
        UPDATE workspace_import_sessions
        SET state = 'completed', manifest_hash = target_manifest_hash, updated_at = NOW()
        WHERE workspace_id = target_workspace_id AND id = import_session_id AND state = 'writing';
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_import_session_invalid'; END IF;
        UPDATE workspaces SET state = 'active', version = version + 1, updated_at = NOW()
        WHERE id = target_workspace_id AND state = 'read_only';
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_import_target_invalid'; END IF;
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_create_room(TEXT, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_move_room(TEXT, TEXT, TEXT, BIGINT, BIGINT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_preview_room_move(TEXT, TEXT, TEXT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_set_room_member_with_impact(TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_preview_room_member_change(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_import_workspace_room(TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_import_workspace_room_member(TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_validate_workspace_room_hierarchy(TEXT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_set_room_member(TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC"
    ]
  },
  {
    version: 23,
    name: "workspace_server_room_hierarchy_privacy_and_realtime_integrity",
    statements: [
      // Disabled Accounts must lose the same RLS-derived Workspace and Room
      // access as a revoked membership.  Without this join, an old active
      // membership row would keep a disabled identity readable.
      `CREATE OR REPLACE FUNCTION samurai_workspace_role(target_workspace_id TEXT)
      RETURNS TEXT
      LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT member.role
        FROM workspace_members AS member
        JOIN accounts AS account
          ON account.id = member.account_id AND account.status = 'active'
        WHERE member.workspace_id = target_workspace_id
          AND member.account_id = samurai_current_account_id()
          AND member.state = 'active'
        LIMIT 1
      $$`,
      // A Workspace Owner/Admin may manage every existing Room, but a made-up
      // Room id must never look manageable merely because the caller is an
      // administrator. This also makes hidden and missing Room ids follow one
      // externally observable failure path for ordinary members.
      `CREATE OR REPLACE FUNCTION samurai_room_role(target_workspace_id TEXT, target_room_id TEXT)
      RETURNS TEXT
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
      DECLARE workspace_role_name TEXT;
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM workspace_members AS member
          JOIN accounts AS account
            ON account.id = member.account_id AND account.status = 'active'
          WHERE member.workspace_id = target_workspace_id
            AND member.account_id = samurai_current_account_id()
            AND member.state = 'active'
        ) OR NOT EXISTS (
          SELECT 1 FROM rooms
          WHERE workspace_id = target_workspace_id AND id = target_room_id
        ) THEN
          RETURN NULL;
        END IF;
        workspace_role_name := samurai_workspace_role(target_workspace_id);
        IF samurai_role_rank(workspace_role_name) >= samurai_role_rank('admin') THEN
          RETURN workspace_role_name;
        END IF;
        RETURN (
          SELECT role
          FROM room_members
          WHERE workspace_id = target_workspace_id
            AND room_id = target_room_id
            AND account_id = samurai_current_account_id()
            AND state = 'active'
          LIMIT 1
        );
      END
      $$`,
      // This is the single validation source for preview and mutation. The
      // mutation calls it again under the hierarchy lock, so a successful
      // preview is useful UI guidance but never an authorization grant.
      `CREATE OR REPLACE FUNCTION samurai_room_member_change_impact(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing_member room_members%ROWTYPE;
      DECLARE has_existing BOOLEAN;
      DECLARE blocking_owner_room_ids TEXT[];
      DECLARE affected_room_ids TEXT[];
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_room(target_workspace_id, target_room_id, 'manage') THEN
          RAISE EXCEPTION 'room_not_available';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF target_role NOT IN ('owner', 'admin', 'member', 'guest')
          OR target_state NOT IN ('active', 'revoked') THEN
          RAISE EXCEPTION 'room_membership_invalid';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM accounts WHERE id = target_account_id
        ) THEN RAISE EXCEPTION 'workspace_account_not_active'; END IF;
        IF target_state = 'active' AND NOT EXISTS (
          SELECT 1 FROM accounts
          WHERE id = target_account_id AND status = 'active'
        ) THEN RAISE EXCEPTION 'workspace_account_not_active'; END IF;
        IF target_state = 'active' AND NOT EXISTS (
          SELECT 1 FROM workspace_members
          WHERE workspace_id = target_workspace_id
            AND account_id = target_account_id
            AND state = 'active'
        ) THEN RAISE EXCEPTION 'workspace_membership_required'; END IF;
        SELECT * INTO existing_member
        FROM room_members
        WHERE workspace_id = target_workspace_id
          AND room_id = target_room_id
          AND account_id = target_account_id;
        has_existing := FOUND;
        IF target_role = 'owner'
          AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        IF has_existing AND existing_member.role = 'owner' AND existing_member.state = 'active'
          AND (target_role <> 'owner' OR target_state <> 'active')
          AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        IF target_state = 'active' AND EXISTS (
          WITH RECURSIVE ancestors(room_id, parent_room_id) AS (
            SELECT parent.id, parent.parent_room_id
            FROM rooms AS room
            JOIN rooms AS parent
              ON parent.workspace_id = room.workspace_id AND parent.id = room.parent_room_id
            WHERE room.workspace_id = target_workspace_id AND room.id = target_room_id
            UNION ALL
            SELECT parent.id, parent.parent_room_id
            FROM rooms AS parent
            JOIN ancestors ON ancestors.parent_room_id = parent.id
            WHERE parent.workspace_id = target_workspace_id
          )
          SELECT 1 FROM ancestors
          WHERE NOT EXISTS (
            SELECT 1 FROM room_members
            WHERE workspace_id = target_workspace_id
              AND room_id = ancestors.room_id
              AND account_id = target_account_id
              AND state = 'active'
          )
        ) THEN RAISE EXCEPTION 'room_parent_membership_required'; END IF;
        IF target_state = 'revoked' AND EXISTS (
          WITH RECURSIVE descendants(room_id) AS (
            SELECT target_room_id
            UNION ALL
            SELECT room.id FROM rooms AS room
            JOIN descendants ON room.parent_room_id = descendants.room_id
            WHERE room.workspace_id = target_workspace_id
          )
          SELECT 1 FROM room_members AS member
          JOIN descendants ON descendants.room_id = member.room_id
          WHERE member.workspace_id = target_workspace_id
            AND member.account_id = target_account_id
            AND member.state = 'active'
            AND member.role = 'owner'
        ) AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        IF target_state = 'revoked' THEN
          WITH RECURSIVE descendants(room_id) AS (
            SELECT target_room_id
            UNION ALL
            SELECT room.id FROM rooms AS room
            JOIN descendants ON room.parent_room_id = descendants.room_id
            WHERE room.workspace_id = target_workspace_id
          )
          SELECT COALESCE(array_agg(member.room_id ORDER BY member.room_id), ARRAY[]::TEXT[])
          INTO blocking_owner_room_ids
          FROM room_members AS member
          JOIN descendants ON descendants.room_id = member.room_id
          WHERE member.workspace_id = target_workspace_id
            AND member.account_id = target_account_id
            AND member.state = 'active'
            AND member.role = 'owner'
            AND NOT EXISTS (
              SELECT 1 FROM room_members AS another_owner
              WHERE another_owner.workspace_id = member.workspace_id
                AND another_owner.room_id = member.room_id
                AND another_owner.account_id <> target_account_id
                AND another_owner.role = 'owner'
                AND another_owner.state = 'active'
            );
          WITH RECURSIVE descendants(room_id) AS (
            SELECT target_room_id
            UNION ALL
            SELECT room.id FROM rooms AS room
            JOIN descendants ON room.parent_room_id = descendants.room_id
            WHERE room.workspace_id = target_workspace_id
          )
          SELECT COALESCE(array_agg(member.room_id ORDER BY member.room_id), ARRAY[target_room_id])
          INTO affected_room_ids
          FROM room_members AS member
          JOIN descendants ON descendants.room_id = member.room_id
          WHERE member.workspace_id = target_workspace_id
            AND member.account_id = target_account_id
            AND member.state = 'active';
        ELSIF has_existing AND existing_member.role = 'owner' AND existing_member.state = 'active'
          AND target_role <> 'owner'
          AND NOT EXISTS (
            SELECT 1 FROM room_members AS another_owner
            WHERE another_owner.workspace_id = target_workspace_id
              AND another_owner.room_id = target_room_id
              AND another_owner.account_id <> target_account_id
              AND another_owner.role = 'owner'
              AND another_owner.state = 'active'
          ) THEN
          blocking_owner_room_ids := ARRAY[target_room_id];
          affected_room_ids := ARRAY[target_room_id];
        ELSE
          blocking_owner_room_ids := ARRAY[]::TEXT[];
          affected_room_ids := ARRAY[target_room_id];
        END IF;
        RETURN jsonb_build_object(
          'allowed', cardinality(blocking_owner_room_ids) = 0,
          'reason', CASE WHEN cardinality(blocking_owner_room_ids) = 0 THEN NULL ELSE 'room_last_owner_cannot_be_removed' END,
          'affected_room_ids', to_jsonb(affected_room_ids),
          'blocking_owner_room_ids', to_jsonb(blocking_owner_room_ids)
        );
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_preview_room_member_change(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE impact JSONB;
      DECLARE affected_room_ids TEXT[];
      DECLARE blocking_owner_room_ids TEXT[];
      DECLARE visible_affected_room_ids TEXT[];
      DECLARE visible_blocking_owner_room_ids TEXT[];
      BEGIN
        impact := samurai_room_member_change_impact(
          target_workspace_id, target_room_id, target_account_id, target_role, target_state
        );
        SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[])
        INTO affected_room_ids
        FROM jsonb_array_elements_text(impact->'affected_room_ids') AS item(value);
        SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[])
        INTO blocking_owner_room_ids
        FROM jsonb_array_elements_text(impact->'blocking_owner_room_ids') AS item(value);
        SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::TEXT[])
        INTO visible_affected_room_ids
        FROM rooms
        WHERE workspace_id = target_workspace_id
          AND id = ANY(affected_room_ids)
          AND samurai_can_room(target_workspace_id, id, 'manage');
        SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::TEXT[])
        INTO visible_blocking_owner_room_ids
        FROM rooms
        WHERE workspace_id = target_workspace_id
          AND id = ANY(blocking_owner_room_ids)
          AND samurai_can_room(target_workspace_id, id, 'manage');
        RETURN jsonb_build_object(
          'allowed', COALESCE((impact->>'allowed')::BOOLEAN, false),
          'reason', impact->'reason',
          'affected_room_ids', to_jsonb(visible_affected_room_ids),
          'blocking_owner_room_ids', to_jsonb(visible_blocking_owner_room_ids)
        );
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_set_room_member_with_impact(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT,
        target_expected_version BIGINT,
        target_operation_id TEXT
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing_member room_members%ROWTYPE;
      DECLARE impact JSONB;
      DECLARE affected_room_ids TEXT[];
      DECLARE affected_room_id TEXT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.room_hierarchy:' || target_workspace_id, 0));
        impact := samurai_room_member_change_impact(
          target_workspace_id, target_room_id, target_account_id, target_role, target_state
        );
        IF COALESCE((impact->>'allowed')::BOOLEAN, false) IS NOT TRUE THEN
          RAISE EXCEPTION 'room_last_owner_cannot_be_removed';
        END IF;
        SELECT * INTO existing_member
        FROM room_members
        WHERE workspace_id = target_workspace_id
          AND room_id = target_room_id
          AND account_id = target_account_id
        FOR UPDATE;
        IF COALESCE(existing_member.version, 0) <> target_expected_version THEN
          RAISE EXCEPTION 'room_membership_version_conflict';
        END IF;
        SELECT COALESCE(array_agg(value), ARRAY[target_room_id])
        INTO affected_room_ids
        FROM jsonb_array_elements_text(impact->'affected_room_ids') AS item(value);
        IF target_state = 'revoked' THEN
          WITH RECURSIVE descendants(room_id) AS (
            SELECT target_room_id
            UNION ALL
            SELECT room.id FROM rooms AS room
            JOIN descendants ON room.parent_room_id = descendants.room_id
            WHERE room.workspace_id = target_workspace_id
          )
          UPDATE room_members AS member
          SET role = CASE WHEN member.room_id = target_room_id THEN target_role ELSE member.role END,
              state = 'revoked',
              version = member.version + 1,
              revoked_at = NOW(),
              updated_at = NOW()
          FROM descendants
          WHERE member.workspace_id = target_workspace_id
            AND member.room_id = descendants.room_id
            AND member.account_id = target_account_id
            AND member.state = 'active';
          IF NOT FOUND THEN
            INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version, revoked_at, updated_at)
            VALUES (target_workspace_id, target_room_id, target_account_id, target_role, 'revoked', 1, NOW(), NOW())
            ON CONFLICT (workspace_id, room_id, account_id) DO UPDATE SET
              role = EXCLUDED.role,
              state = 'revoked',
              version = room_members.version + 1,
              revoked_at = NOW(),
              updated_at = NOW();
          END IF;
        ELSE
          INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version, revoked_at, updated_at)
          VALUES (target_workspace_id, target_room_id, target_account_id, target_role, 'active', 1, NULL, NOW())
          ON CONFLICT (workspace_id, room_id, account_id) DO UPDATE SET
            role = EXCLUDED.role,
            state = 'active',
            version = room_members.version + 1,
            revoked_at = NULL,
            updated_at = NOW();
        END IF;
        FOREACH affected_room_id IN ARRAY affected_room_ids LOOP
          INSERT INTO workspace_events(workspace_id, room_id, kind, operation_id, payload)
          VALUES (
            target_workspace_id,
            affected_room_id,
            'room.member.changed',
            target_operation_id,
            jsonb_build_object('changed_room_id', target_room_id)
          );
        END LOOP;
        RETURN jsonb_build_object('affected_room_ids', to_jsonb(affected_room_ids));
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_create_room(
        target_workspace_id TEXT,
        new_room_id TEXT,
        new_room_name TEXT,
        target_parent_room_id TEXT,
        target_workspace_version BIGINT,
        target_operation_id TEXT
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE current_workspace_version BIGINT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.room_hierarchy:' || target_workspace_id, 0));
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id() THEN
          RAISE EXCEPTION 'workspace_permission_denied';
        END IF;
        SELECT version INTO current_workspace_version
        FROM workspaces WHERE id = target_workspace_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_not_found'; END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF current_workspace_version IS DISTINCT FROM target_workspace_version THEN
          RAISE EXCEPTION 'workspace_version_conflict';
        END IF;
        IF target_parent_room_id IS NULL THEN
          IF NOT samurai_can_workspace(target_workspace_id, 'member') THEN
            RAISE EXCEPTION 'workspace_permission_denied';
          END IF;
        ELSE
          IF NOT samurai_can_room(target_workspace_id, target_parent_room_id, 'manage') THEN
            RAISE EXCEPTION 'room_parent_not_available';
          END IF;
          IF EXISTS (
            WITH RECURSIVE ancestors(room_id, parent_room_id) AS (
              SELECT id, parent_room_id FROM rooms
              WHERE workspace_id = target_workspace_id AND id = target_parent_room_id
              UNION ALL
              SELECT parent.id, parent.parent_room_id FROM rooms AS parent
              JOIN ancestors ON ancestors.parent_room_id = parent.id
              WHERE parent.workspace_id = target_workspace_id
            )
            SELECT 1 FROM ancestors
            WHERE NOT EXISTS (
              SELECT 1 FROM room_members
              WHERE workspace_id = target_workspace_id
                AND room_id = ancestors.room_id
                AND account_id = samurai_current_account_id()
                AND state = 'active'
            )
          ) THEN RAISE EXCEPTION 'room_parent_membership_required'; END IF;
        END IF;
        INSERT INTO rooms(workspace_id, id, parent_room_id, name, created_by)
        VALUES (target_workspace_id, new_room_id, target_parent_room_id, new_room_name, samurai_current_account_id());
        INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version)
        VALUES (target_workspace_id, new_room_id, samurai_current_account_id(), 'owner', 'active', 1);
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
        INSERT INTO workspace_events(workspace_id, room_id, kind, operation_id, payload)
        VALUES (target_workspace_id, new_room_id, 'room.created', target_operation_id, jsonb_build_object('changed_room_id', new_room_id));
        RETURN jsonb_build_object('room_id', new_room_id);
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_move_room(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_parent_room_id TEXT,
        target_expected_room_version BIGINT,
        target_expected_workspace_version BIGINT,
        target_operation_id TEXT
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE current_workspace_version BIGINT;
      DECLARE current_room_version BIGINT;
      DECLARE affected_room_ids TEXT[];
      DECLARE affected_room_id TEXT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.room_hierarchy:' || target_workspace_id, 0));
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_room(target_workspace_id, target_room_id, 'manage') THEN
          RAISE EXCEPTION 'room_not_available';
        END IF;
        SELECT version INTO current_workspace_version
        FROM workspaces WHERE id = target_workspace_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_not_found'; END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF current_workspace_version IS DISTINCT FROM target_expected_workspace_version THEN
          RAISE EXCEPTION 'workspace_version_conflict';
        END IF;
        SELECT version INTO current_room_version
        FROM rooms
        WHERE workspace_id = target_workspace_id AND id = target_room_id
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'room_not_available'; END IF;
        IF current_room_version IS DISTINCT FROM target_expected_room_version THEN
          RAISE EXCEPTION 'room_version_conflict';
        END IF;
        IF target_parent_room_id IS NULL THEN
          IF NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
            RAISE EXCEPTION 'workspace_admin_permission_required';
          END IF;
        ELSE
          IF target_parent_room_id = target_room_id THEN RAISE EXCEPTION 'room_hierarchy_cycle'; END IF;
          IF NOT samurai_can_room(target_workspace_id, target_parent_room_id, 'manage') THEN
            RAISE EXCEPTION 'room_parent_not_available';
          END IF;
          IF EXISTS (
            WITH RECURSIVE descendants(room_id) AS (
              SELECT target_room_id
              UNION ALL
              SELECT room.id FROM rooms AS room
              JOIN descendants ON room.parent_room_id = descendants.room_id
              WHERE room.workspace_id = target_workspace_id
            )
            SELECT 1 FROM descendants WHERE room_id = target_parent_room_id
          ) THEN RAISE EXCEPTION 'room_hierarchy_cycle'; END IF;
          IF EXISTS (
            WITH RECURSIVE descendants(room_id) AS (
              SELECT target_room_id
              UNION ALL
              SELECT room.id FROM rooms AS room
              JOIN descendants ON room.parent_room_id = descendants.room_id
              WHERE room.workspace_id = target_workspace_id
            ),
            ancestors(room_id, parent_room_id) AS (
              SELECT id, parent_room_id FROM rooms
              WHERE workspace_id = target_workspace_id AND id = target_parent_room_id
              UNION ALL
              SELECT parent.id, parent.parent_room_id FROM rooms AS parent
              JOIN ancestors ON ancestors.parent_room_id = parent.id
              WHERE parent.workspace_id = target_workspace_id
            )
            SELECT 1
            FROM room_members AS child_member
            JOIN descendants ON descendants.room_id = child_member.room_id
            CROSS JOIN ancestors
            LEFT JOIN room_members AS parent_member
              ON parent_member.workspace_id = target_workspace_id
             AND parent_member.room_id = ancestors.room_id
             AND parent_member.account_id = child_member.account_id
             AND parent_member.state = 'active'
            WHERE child_member.workspace_id = target_workspace_id
              AND child_member.state = 'active'
              AND parent_member.account_id IS NULL
          ) THEN RAISE EXCEPTION 'room_move_parent_membership_required'; END IF;
        END IF;
        WITH RECURSIVE descendants(room_id) AS (
          SELECT target_room_id
          UNION ALL
          SELECT room.id FROM rooms AS room
          JOIN descendants ON room.parent_room_id = descendants.room_id
          WHERE room.workspace_id = target_workspace_id
        )
        SELECT COALESCE(array_agg(room_id ORDER BY room_id), ARRAY[target_room_id])
        INTO affected_room_ids FROM descendants;
        UPDATE rooms
        SET parent_room_id = target_parent_room_id, version = version + 1, updated_at = NOW()
        WHERE workspace_id = target_workspace_id AND id = target_room_id;
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
        FOREACH affected_room_id IN ARRAY affected_room_ids LOOP
          INSERT INTO workspace_events(workspace_id, room_id, kind, operation_id, payload)
          VALUES (
            target_workspace_id,
            affected_room_id,
            'room.moved',
            target_operation_id,
            jsonb_build_object('changed_room_id', target_room_id)
          );
        END LOOP;
        RETURN jsonb_build_object(
          'room_id', target_room_id,
          'parent_room_id', target_parent_room_id,
          'affected_room_ids', to_jsonb(affected_room_ids)
        );
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_preview_room_move(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_parent_room_id TEXT
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE raw_blocking_account_ids TEXT[];
      DECLARE visible_blocking_account_ids TEXT[];
      DECLARE required_ancestor_room_ids TEXT[];
      DECLARE visible_required_ancestor_room_ids TEXT[];
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_room(target_workspace_id, target_room_id, 'manage') THEN
          RAISE EXCEPTION 'room_not_available';
        END IF;
        IF target_parent_room_id IS NULL THEN
          IF NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
            RAISE EXCEPTION 'workspace_admin_permission_required';
          END IF;
          RETURN jsonb_build_object('allowed', true, 'blocking_account_ids', '[]'::JSONB, 'required_ancestor_room_ids', '[]'::JSONB);
        END IF;
        IF target_parent_room_id = target_room_id THEN
          RETURN jsonb_build_object('allowed', false, 'reason', 'room_hierarchy_cycle', 'blocking_account_ids', '[]'::JSONB, 'required_ancestor_room_ids', '[]'::JSONB);
        END IF;
        IF NOT samurai_can_room(target_workspace_id, target_parent_room_id, 'manage') THEN
          RAISE EXCEPTION 'room_parent_not_available';
        END IF;
        IF EXISTS (
          WITH RECURSIVE descendants(room_id) AS (
            SELECT target_room_id
            UNION ALL
            SELECT room.id FROM rooms AS room
            JOIN descendants ON room.parent_room_id = descendants.room_id
            WHERE room.workspace_id = target_workspace_id
          )
          SELECT 1 FROM descendants WHERE room_id = target_parent_room_id
        ) THEN
          RETURN jsonb_build_object('allowed', false, 'reason', 'room_hierarchy_cycle', 'blocking_account_ids', '[]'::JSONB, 'required_ancestor_room_ids', '[]'::JSONB);
        END IF;
        WITH RECURSIVE descendants(room_id) AS (
          SELECT target_room_id
          UNION ALL
          SELECT room.id FROM rooms AS room
          JOIN descendants ON room.parent_room_id = descendants.room_id
          WHERE room.workspace_id = target_workspace_id
        ),
        ancestors(room_id, parent_room_id) AS (
          SELECT id, parent_room_id FROM rooms
          WHERE workspace_id = target_workspace_id AND id = target_parent_room_id
          UNION ALL
          SELECT parent.id, parent.parent_room_id FROM rooms AS parent
          JOIN ancestors ON ancestors.parent_room_id = parent.id
          WHERE parent.workspace_id = target_workspace_id
        ),
        missing AS (
          SELECT DISTINCT child_member.room_id, child_member.account_id
          FROM room_members AS child_member
          JOIN descendants ON descendants.room_id = child_member.room_id
          CROSS JOIN ancestors
          LEFT JOIN room_members AS parent_member
            ON parent_member.workspace_id = target_workspace_id
           AND parent_member.room_id = ancestors.room_id
           AND parent_member.account_id = child_member.account_id
           AND parent_member.state = 'active'
          WHERE child_member.workspace_id = target_workspace_id
            AND child_member.state = 'active'
            AND parent_member.account_id IS NULL
        )
        SELECT
          COALESCE((SELECT array_agg(DISTINCT account_id ORDER BY account_id) FROM missing), ARRAY[]::TEXT[]),
          COALESCE((SELECT array_agg(room_id ORDER BY room_id) FROM ancestors), ARRAY[]::TEXT[]),
          COALESCE((
            SELECT array_agg(DISTINCT account_id ORDER BY account_id)
            FROM missing
            WHERE samurai_can_room(target_workspace_id, room_id, 'manage')
          ), ARRAY[]::TEXT[])
        INTO raw_blocking_account_ids, required_ancestor_room_ids, visible_blocking_account_ids;
        SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::TEXT[])
        INTO visible_required_ancestor_room_ids
        FROM rooms
        WHERE workspace_id = target_workspace_id
          AND id = ANY(required_ancestor_room_ids)
          AND samurai_can_room(target_workspace_id, id, 'manage');
        RETURN jsonb_build_object(
          'allowed', cardinality(raw_blocking_account_ids) = 0,
          'reason', CASE WHEN cardinality(raw_blocking_account_ids) = 0 THEN NULL ELSE 'room_move_parent_membership_required' END,
          'blocking_account_ids', to_jsonb(visible_blocking_account_ids),
          'required_ancestor_room_ids', to_jsonb(visible_required_ancestor_room_ids)
        );
      END
      $$`,
      // Workspace revocation is also a Room membership revocation. Keeping
      // stale direct Room rows would otherwise let access silently reappear
      // when the Workspace membership is made active again later.
      `CREATE OR REPLACE FUNCTION samurai_set_workspace_member(
        target_workspace_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT,
        target_expected_version BIGINT,
        target_operation_id TEXT
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing_member workspace_members%ROWTYPE;
      DECLARE affected_room_ids TEXT[];
      DECLARE affected_room_id TEXT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.room_hierarchy:' || target_workspace_id, 0));
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
          RAISE EXCEPTION 'workspace_permission_denied';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF target_role NOT IN ('owner', 'admin', 'member', 'guest')
          OR target_state NOT IN ('active', 'revoked') THEN
          RAISE EXCEPTION 'workspace_membership_invalid';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM accounts WHERE id = target_account_id
        ) THEN RAISE EXCEPTION 'workspace_account_not_active'; END IF;
        IF target_state = 'active' AND NOT EXISTS (
          SELECT 1 FROM accounts
          WHERE id = target_account_id AND status = 'active'
        ) THEN RAISE EXCEPTION 'workspace_account_not_active'; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.owner:' || target_workspace_id, 0));
        SELECT * INTO existing_member
        FROM workspace_members
        WHERE workspace_id = target_workspace_id AND account_id = target_account_id
        FOR UPDATE;
        IF COALESCE(existing_member.version, 0) <> target_expected_version THEN
          RAISE EXCEPTION 'workspace_membership_version_conflict';
        END IF;
        IF target_role = 'owner' AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        IF FOUND AND existing_member.role = 'owner' AND existing_member.state = 'active'
          AND (target_role <> 'owner' OR target_state <> 'active') THEN
          IF NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
            RAISE EXCEPTION 'workspace_owner_permission_required';
          END IF;
          IF (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = target_workspace_id AND role = 'owner' AND state = 'active') <= 1 THEN
            RAISE EXCEPTION 'workspace_last_owner_cannot_be_revoked';
          END IF;
        END IF;
        IF target_state = 'revoked' AND EXISTS (
          SELECT 1
          FROM room_members AS member
          WHERE member.workspace_id = target_workspace_id
            AND member.account_id = target_account_id
            AND member.state = 'active'
            AND member.role = 'owner'
            AND NOT EXISTS (
              SELECT 1 FROM room_members AS another_owner
              WHERE another_owner.workspace_id = member.workspace_id
                AND another_owner.room_id = member.room_id
                AND another_owner.account_id <> target_account_id
                AND another_owner.role = 'owner'
                AND another_owner.state = 'active'
            )
        ) THEN RAISE EXCEPTION 'room_last_owner_cannot_be_removed'; END IF;
        IF target_state = 'revoked' THEN
          SELECT COALESCE(array_agg(room_id ORDER BY room_id), ARRAY[]::TEXT[])
          INTO affected_room_ids
          FROM room_members
          WHERE workspace_id = target_workspace_id
            AND account_id = target_account_id
            AND state = 'active';
          UPDATE room_members
          SET state = 'revoked', version = version + 1, revoked_at = NOW(), updated_at = NOW()
          WHERE workspace_id = target_workspace_id
            AND account_id = target_account_id
            AND state = 'active';
        ELSE
          affected_room_ids := ARRAY[]::TEXT[];
        END IF;
        INSERT INTO workspace_members(workspace_id, account_id, role, state, version, revoked_at, updated_at)
        VALUES (target_workspace_id, target_account_id, target_role, target_state, 1,
          CASE WHEN target_state = 'revoked' THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET
          role = EXCLUDED.role,
          state = EXCLUDED.state,
          version = workspace_members.version + 1,
          revoked_at = EXCLUDED.revoked_at,
          updated_at = NOW();
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
        FOREACH affected_room_id IN ARRAY affected_room_ids LOOP
          INSERT INTO workspace_events(workspace_id, room_id, kind, operation_id, payload)
          VALUES (
            target_workspace_id,
            affected_room_id,
            'room.member.changed',
            target_operation_id,
            jsonb_build_object('changed_room_id', affected_room_id)
          );
        END LOOP;
        RETURN jsonb_build_object('affected_room_ids', to_jsonb(affected_room_ids));
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_validate_workspace_room_hierarchy(
        target_workspace_id TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        IF EXISTS (
          WITH RECURSIVE walk(room_id, parent_room_id, path, cycle) AS (
            SELECT id, parent_room_id, ARRAY[id], false FROM rooms
            WHERE workspace_id = target_workspace_id
            UNION ALL
            SELECT parent.id, parent.parent_room_id, walk.path || parent.id, parent.id = ANY(walk.path)
            FROM rooms AS parent
            JOIN walk ON parent.id = walk.parent_room_id
            WHERE parent.workspace_id = target_workspace_id AND NOT walk.cycle
          )
          SELECT 1 FROM walk WHERE cycle
        ) THEN RAISE EXCEPTION 'room_bundle_hierarchy_cycle'; END IF;
        IF EXISTS (
          SELECT 1 FROM room_members AS member
          LEFT JOIN workspace_members AS workspace_member
            ON workspace_member.workspace_id = member.workspace_id
           AND workspace_member.account_id = member.account_id
           AND workspace_member.state = 'active'
          LEFT JOIN accounts AS account
            ON account.id = member.account_id AND account.status = 'active'
          WHERE member.workspace_id = target_workspace_id
            AND member.state = 'active'
            AND (workspace_member.account_id IS NULL OR account.id IS NULL)
        ) THEN RAISE EXCEPTION 'room_bundle_workspace_membership_invalid'; END IF;
        IF EXISTS (
          WITH RECURSIVE ancestry(descendant_room_id, ancestor_room_id) AS (
            SELECT id, parent_room_id FROM rooms
            WHERE workspace_id = target_workspace_id AND parent_room_id IS NOT NULL
            UNION ALL
            SELECT ancestry.descendant_room_id, parent.parent_room_id
            FROM ancestry
            JOIN rooms AS parent
              ON parent.workspace_id = target_workspace_id AND parent.id = ancestry.ancestor_room_id
            WHERE parent.parent_room_id IS NOT NULL
          )
          SELECT 1
          FROM room_members AS child_member
          JOIN ancestry ON ancestry.descendant_room_id = child_member.room_id
          LEFT JOIN room_members AS parent_member
            ON parent_member.workspace_id = target_workspace_id
           AND parent_member.room_id = ancestry.ancestor_room_id
           AND parent_member.account_id = child_member.account_id
           AND parent_member.state = 'active'
          WHERE child_member.workspace_id = target_workspace_id
            AND child_member.state = 'active'
            AND parent_member.account_id IS NULL
        ) THEN RAISE EXCEPTION 'room_bundle_parent_membership_invalid'; END IF;
        IF EXISTS (
          SELECT 1 FROM rooms AS room
          WHERE room.workspace_id = target_workspace_id
            AND NOT EXISTS (
              SELECT 1 FROM room_members AS member
              JOIN workspace_members AS workspace_member
                ON workspace_member.workspace_id = member.workspace_id
               AND workspace_member.account_id = member.account_id
               AND workspace_member.state = 'active'
              JOIN accounts AS account
                ON account.id = member.account_id AND account.status = 'active'
              WHERE member.workspace_id = room.workspace_id
                AND member.room_id = room.id
                AND member.role = 'owner'
                AND member.state = 'active'
            )
        ) THEN RAISE EXCEPTION 'room_bundle_owner_missing'; END IF;
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_room_member_change_impact(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_create_room(TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_move_room(TEXT, TEXT, TEXT, BIGINT, BIGINT, TEXT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_set_workspace_member(TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_set_room_member_with_impact(TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC"
    ]
  },
  {
    version: 24,
    name: "workspace_server_room_hierarchy_invitation_and_import_guards",
    statements: [
      // Import is the only non-interactive path allowed to materialize a
      // Workspace membership. Keep it behind the same short-lived import
      // capability as Rooms and Room memberships; the runtime role has no
      // direct INSERT/UPDATE/DELETE permission on membership tables.
      `CREATE OR REPLACE FUNCTION samurai_import_workspace_member(
        target_workspace_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT,
        target_version BIGINT,
        target_created_at TIMESTAMPTZ,
        target_updated_at TIMESTAMPTZ,
        target_revoked_at TIMESTAMPTZ
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        IF target_role NOT IN ('owner', 'admin', 'member', 'guest')
          OR target_state NOT IN ('active', 'revoked')
          OR target_version IS NULL OR target_version < 1 THEN
          RAISE EXCEPTION 'workspace_import_membership_invalid';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = target_account_id) THEN
          RAISE EXCEPTION 'workspace_import_identity_missing';
        END IF;
        IF target_state = 'active' AND NOT EXISTS (
          SELECT 1 FROM accounts WHERE id = target_account_id AND status = 'active'
        ) THEN RAISE EXCEPTION 'workspace_import_membership_invalid'; END IF;
        INSERT INTO workspace_members(
          workspace_id, account_id, role, state, version, created_at, updated_at, revoked_at
        ) VALUES (
          target_workspace_id, target_account_id, target_role, target_state, target_version,
          target_created_at, target_updated_at, target_revoked_at
        );
      END
      $$`,
      // An invitation is also a membership-change path. It must not revive a
      // disabled Account, skip any parent Room membership, or bypass durable
      // Room-member events. The request operation id ties that event to the
      // same externally retried acceptance command.
      `CREATE OR REPLACE FUNCTION samurai_accept_invitation(
        target_workspace_id TEXT,
        supplied_token_hash TEXT,
        target_operation_id TEXT
      ) RETURNS TABLE(workspace_role TEXT, room_id TEXT, room_role TEXT, invitation_version BIGINT)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE invitation workspace_invitations%ROWTYPE;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.room_hierarchy:' || target_workspace_id, 0));
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR samurai_current_account_id() IS NULL
          OR target_operation_id IS NULL OR btrim(target_operation_id) = ''
          OR NOT EXISTS (
            SELECT 1 FROM accounts
            WHERE id = samurai_current_account_id() AND status = 'active'
          ) THEN
          RAISE EXCEPTION 'workspace_invitation_invalid';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        SELECT * INTO invitation
        FROM workspace_invitations
        WHERE workspace_id = target_workspace_id
          AND token_hash = supplied_token_hash
          AND revoked_at IS NULL
          AND accepted_at IS NULL
          AND expires_at > NOW()
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_invitation_invalid'; END IF;
        INSERT INTO workspace_members(workspace_id, account_id, role, state, version, updated_at)
        VALUES (target_workspace_id, samurai_current_account_id(), invitation.workspace_role, 'active', 1, NOW())
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET
          role = CASE WHEN samurai_role_rank(EXCLUDED.role) > samurai_role_rank(workspace_members.role) THEN EXCLUDED.role ELSE workspace_members.role END,
          state = 'active', revoked_at = NULL, version = workspace_members.version + 1, updated_at = NOW();
        IF invitation.room_id IS NOT NULL THEN
          IF NOT EXISTS (
            SELECT 1 FROM rooms WHERE workspace_id = target_workspace_id AND id = invitation.room_id
          ) THEN RAISE EXCEPTION 'room_not_available'; END IF;
          IF EXISTS (
            WITH RECURSIVE ancestors(room_id, parent_room_id) AS (
              SELECT parent.id, parent.parent_room_id
              FROM rooms AS room
              JOIN rooms AS parent
                ON parent.workspace_id = room.workspace_id AND parent.id = room.parent_room_id
              WHERE room.workspace_id = target_workspace_id AND room.id = invitation.room_id
              UNION ALL
              SELECT parent.id, parent.parent_room_id
              FROM rooms AS parent
              JOIN ancestors ON ancestors.parent_room_id = parent.id
              WHERE parent.workspace_id = target_workspace_id
            )
            SELECT 1 FROM ancestors
            WHERE NOT EXISTS (
              SELECT 1 FROM room_members
              WHERE workspace_id = target_workspace_id
                AND room_id = ancestors.room_id
                AND account_id = samurai_current_account_id()
                AND state = 'active'
            )
          ) THEN RAISE EXCEPTION 'room_parent_membership_required'; END IF;
          INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version, updated_at)
          VALUES (target_workspace_id, invitation.room_id, samurai_current_account_id(), COALESCE(invitation.room_role, invitation.workspace_role), 'active', 1, NOW())
          ON CONFLICT (workspace_id, room_id, account_id) DO UPDATE SET
            role = CASE WHEN samurai_role_rank(EXCLUDED.role) > samurai_role_rank(room_members.role) THEN EXCLUDED.role ELSE room_members.role END,
            state = 'active', revoked_at = NULL, version = room_members.version + 1, updated_at = NOW();
          INSERT INTO workspace_events(workspace_id, room_id, kind, operation_id, payload)
          VALUES (
            target_workspace_id, invitation.room_id, 'room.member.changed', target_operation_id,
            jsonb_build_object('changed_room_id', invitation.room_id)
          );
        END IF;
        UPDATE workspace_invitations
        SET accepted_by = samurai_current_account_id(), accepted_at = NOW(), version = version + 1
        WHERE workspace_id = target_workspace_id AND id = invitation.id
        RETURNING version INTO invitation_version;
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
        RETURN QUERY SELECT invitation.workspace_role, invitation.room_id, invitation.room_role, invitation_version;
      END
      $$`,
      // The old two-argument function cannot carry the operation id needed
      // for a replay-safe Room event. Fail closed instead of retaining a
      // compatibility path that silently bypasses the new guarantees.
      `CREATE OR REPLACE FUNCTION samurai_accept_invitation(target_workspace_id TEXT, supplied_token_hash TEXT)
      RETURNS TABLE(workspace_role TEXT, room_id TEXT, room_role TEXT, invitation_version BIGINT)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        RAISE EXCEPTION 'workspace_invitation_operation_id_required';
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_import_workspace_member(TEXT, TEXT, TEXT, TEXT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_accept_invitation(TEXT, TEXT, TEXT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_accept_invitation(TEXT, TEXT) FROM PUBLIC"
    ]
  },
  {
    version: 25,
    name: "workspace_server_room_hierarchy_reactivation_does_not_restore_room_access",
    statements: [
      // Server 02 data can contain a historical direct Room row after its
      // Workspace membership was revoked. It was not readable while the
      // Workspace row was revoked, but simply reactivating that Workspace
      // row must never make the old Room access reappear.
      `CREATE OR REPLACE FUNCTION samurai_clear_stale_room_memberships_on_workspace_activation(
        target_workspace_id TEXT,
        target_account_id TEXT
      ) RETURNS TEXT[]
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE affected_room_ids TEXT[];
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT EXISTS (
            SELECT 1 FROM accounts
            WHERE id = target_account_id AND status = 'active'
          ) THEN
          RAISE EXCEPTION 'workspace_membership_invalid';
        END IF;
        -- A legacy stale owner cannot be silently discarded if it would leave
        -- a Room without any effective direct Owner. An existing Workspace
        -- Owner/Admin can first appoint another direct Room Owner, then retry.
        IF EXISTS (
          SELECT 1
          FROM room_members AS member
          WHERE member.workspace_id = target_workspace_id
            AND member.account_id = target_account_id
            AND member.role = 'owner'
            AND member.state = 'active'
            AND NOT EXISTS (
              SELECT 1
              FROM room_members AS another_owner
              JOIN workspace_members AS workspace_member
                ON workspace_member.workspace_id = another_owner.workspace_id
               AND workspace_member.account_id = another_owner.account_id
               AND workspace_member.state = 'active'
              JOIN accounts AS account
                ON account.id = another_owner.account_id
               AND account.status = 'active'
              WHERE another_owner.workspace_id = member.workspace_id
                AND another_owner.room_id = member.room_id
                AND another_owner.account_id <> target_account_id
                AND another_owner.role = 'owner'
                AND another_owner.state = 'active'
            )
        ) THEN
          RAISE EXCEPTION 'room_last_owner_cannot_be_removed';
        END IF;
        WITH changed AS (
          UPDATE room_members
          SET state = 'revoked', version = version + 1, revoked_at = NOW(), updated_at = NOW()
          WHERE workspace_id = target_workspace_id
            AND account_id = target_account_id
            AND state = 'active'
          RETURNING room_id
        )
        SELECT COALESCE(array_agg(room_id ORDER BY room_id), ARRAY[]::TEXT[])
        INTO affected_room_ids
        FROM changed;
        RETURN affected_room_ids;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_set_workspace_member(
        target_workspace_id TEXT,
        target_account_id TEXT,
        target_role TEXT,
        target_state TEXT,
        target_expected_version BIGINT,
        target_operation_id TEXT
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing_member workspace_members%ROWTYPE;
      DECLARE has_existing_member BOOLEAN;
      DECLARE affected_room_ids TEXT[];
      DECLARE affected_room_id TEXT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.room_hierarchy:' || target_workspace_id, 0));
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
          RAISE EXCEPTION 'workspace_permission_denied';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF target_role NOT IN ('owner', 'admin', 'member', 'guest')
          OR target_state NOT IN ('active', 'revoked') THEN
          RAISE EXCEPTION 'workspace_membership_invalid';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = target_account_id) THEN
          RAISE EXCEPTION 'workspace_account_not_active';
        END IF;
        IF target_state = 'active' AND NOT EXISTS (
          SELECT 1 FROM accounts WHERE id = target_account_id AND status = 'active'
        ) THEN
          RAISE EXCEPTION 'workspace_account_not_active';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.owner:' || target_workspace_id, 0));
        SELECT * INTO existing_member
        FROM workspace_members
        WHERE workspace_id = target_workspace_id AND account_id = target_account_id
        FOR UPDATE;
        has_existing_member := FOUND;
        IF COALESCE(existing_member.version, 0) <> target_expected_version THEN
          RAISE EXCEPTION 'workspace_membership_version_conflict';
        END IF;
        IF target_role = 'owner' AND NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_owner_permission_required';
        END IF;
        IF has_existing_member AND existing_member.role = 'owner' AND existing_member.state = 'active'
          AND (target_role <> 'owner' OR target_state <> 'active') THEN
          IF NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
            RAISE EXCEPTION 'workspace_owner_permission_required';
          END IF;
          IF (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = target_workspace_id AND role = 'owner' AND state = 'active') <= 1 THEN
            RAISE EXCEPTION 'workspace_last_owner_cannot_be_revoked';
          END IF;
        END IF;
        IF target_state = 'revoked' AND EXISTS (
          SELECT 1
          FROM room_members AS member
          WHERE member.workspace_id = target_workspace_id
            AND member.account_id = target_account_id
            AND member.state = 'active'
            AND member.role = 'owner'
            AND NOT EXISTS (
              SELECT 1 FROM room_members AS another_owner
              WHERE another_owner.workspace_id = member.workspace_id
                AND another_owner.room_id = member.room_id
                AND another_owner.account_id <> target_account_id
                AND another_owner.role = 'owner'
                AND another_owner.state = 'active'
            )
        ) THEN RAISE EXCEPTION 'room_last_owner_cannot_be_removed'; END IF;
        IF target_state = 'active' AND (NOT has_existing_member OR existing_member.state <> 'active') THEN
          affected_room_ids := samurai_clear_stale_room_memberships_on_workspace_activation(
            target_workspace_id, target_account_id
          );
        ELSIF target_state = 'revoked' THEN
          SELECT COALESCE(array_agg(room_id ORDER BY room_id), ARRAY[]::TEXT[])
          INTO affected_room_ids
          FROM room_members
          WHERE workspace_id = target_workspace_id
            AND account_id = target_account_id
            AND state = 'active';
          UPDATE room_members
          SET state = 'revoked', version = version + 1, revoked_at = NOW(), updated_at = NOW()
          WHERE workspace_id = target_workspace_id
            AND account_id = target_account_id
            AND state = 'active';
        ELSE
          affected_room_ids := ARRAY[]::TEXT[];
        END IF;
        INSERT INTO workspace_members(workspace_id, account_id, role, state, version, revoked_at, updated_at)
        VALUES (target_workspace_id, target_account_id, target_role, target_state, 1,
          CASE WHEN target_state = 'revoked' THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET
          role = EXCLUDED.role,
          state = EXCLUDED.state,
          version = workspace_members.version + 1,
          revoked_at = EXCLUDED.revoked_at,
          updated_at = NOW();
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
        FOREACH affected_room_id IN ARRAY affected_room_ids LOOP
          INSERT INTO workspace_events(workspace_id, room_id, kind, operation_id, payload)
          VALUES (
            target_workspace_id,
            affected_room_id,
            'room.member.changed',
            target_operation_id,
            jsonb_build_object('changed_room_id', affected_room_id)
          );
        END LOOP;
        RETURN jsonb_build_object('affected_room_ids', to_jsonb(affected_room_ids));
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_accept_invitation(
        target_workspace_id TEXT,
        supplied_token_hash TEXT,
        target_operation_id TEXT
      ) RETURNS TABLE(workspace_role TEXT, room_id TEXT, room_role TEXT, invitation_version BIGINT)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE invitation workspace_invitations%ROWTYPE;
      DECLARE existing_workspace_member workspace_members%ROWTYPE;
      DECLARE has_existing_workspace_member BOOLEAN;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.room_hierarchy:' || target_workspace_id, 0));
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR samurai_current_account_id() IS NULL
          OR target_operation_id IS NULL OR btrim(target_operation_id) = ''
          OR NOT EXISTS (
            SELECT 1 FROM accounts
            WHERE id = samurai_current_account_id() AND status = 'active'
          ) THEN
          RAISE EXCEPTION 'workspace_invitation_invalid';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        SELECT * INTO invitation
        FROM workspace_invitations
        WHERE workspace_id = target_workspace_id
          AND token_hash = supplied_token_hash
          AND revoked_at IS NULL
          AND accepted_at IS NULL
          AND expires_at > NOW()
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_invitation_invalid'; END IF;
        SELECT * INTO existing_workspace_member
        FROM workspace_members
        WHERE workspace_id = target_workspace_id
          AND account_id = samurai_current_account_id()
        FOR UPDATE;
        has_existing_workspace_member := FOUND;
        IF NOT has_existing_workspace_member OR existing_workspace_member.state <> 'active' THEN
          PERFORM samurai_clear_stale_room_memberships_on_workspace_activation(
            target_workspace_id, samurai_current_account_id()
          );
        END IF;
        INSERT INTO workspace_members(workspace_id, account_id, role, state, version, updated_at)
        VALUES (target_workspace_id, samurai_current_account_id(), invitation.workspace_role, 'active', 1, NOW())
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET
          role = CASE WHEN samurai_role_rank(EXCLUDED.role) > samurai_role_rank(workspace_members.role) THEN EXCLUDED.role ELSE workspace_members.role END,
          state = 'active', revoked_at = NULL, version = workspace_members.version + 1, updated_at = NOW();
        IF invitation.room_id IS NOT NULL THEN
          IF NOT EXISTS (
            SELECT 1 FROM rooms WHERE workspace_id = target_workspace_id AND id = invitation.room_id
          ) THEN RAISE EXCEPTION 'room_not_available'; END IF;
          IF EXISTS (
            WITH RECURSIVE ancestors(room_id, parent_room_id) AS (
              SELECT parent.id, parent.parent_room_id
              FROM rooms AS room
              JOIN rooms AS parent
                ON parent.workspace_id = room.workspace_id AND parent.id = room.parent_room_id
              WHERE room.workspace_id = target_workspace_id AND room.id = invitation.room_id
              UNION ALL
              SELECT parent.id, parent.parent_room_id
              FROM rooms AS parent
              JOIN ancestors ON ancestors.parent_room_id = parent.id
              WHERE parent.workspace_id = target_workspace_id
            )
            SELECT 1 FROM ancestors
            WHERE NOT EXISTS (
              SELECT 1 FROM room_members
              WHERE workspace_id = target_workspace_id
                AND room_id = ancestors.room_id
                AND account_id = samurai_current_account_id()
                AND state = 'active'
            )
          ) THEN RAISE EXCEPTION 'room_parent_membership_required'; END IF;
          INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version, updated_at)
          VALUES (target_workspace_id, invitation.room_id, samurai_current_account_id(), COALESCE(invitation.room_role, invitation.workspace_role), 'active', 1, NOW())
          ON CONFLICT (workspace_id, room_id, account_id) DO UPDATE SET
            role = CASE WHEN samurai_role_rank(EXCLUDED.role) > samurai_role_rank(room_members.role) THEN EXCLUDED.role ELSE room_members.role END,
            state = 'active', revoked_at = NULL, version = room_members.version + 1, updated_at = NOW();
          INSERT INTO workspace_events(workspace_id, room_id, kind, operation_id, payload)
          VALUES (
            target_workspace_id, invitation.room_id, 'room.member.changed', target_operation_id,
            jsonb_build_object('changed_room_id', invitation.room_id)
          );
        END IF;
        UPDATE workspace_invitations
        SET accepted_by = samurai_current_account_id(), accepted_at = NOW(), version = version + 1
        WHERE workspace_id = target_workspace_id AND id = invitation.id
        RETURNING version INTO invitation_version;
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
        RETURN QUERY SELECT invitation.workspace_role, invitation.room_id, invitation.room_role, invitation_version;
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_clear_stale_room_memberships_on_workspace_activation(TEXT, TEXT) FROM PUBLIC"
    ]
  },
  {
    version: 26,
    name: "workspace_server_knowledge_learning_loop",
    statements: [
      // Knowledge is intentionally separate from the generic record table.
      // This makes scope, history, evidence, and the AI write boundary
      // enforceable instead of relying on convention in a JSON payload.
      `CREATE TABLE workspace_learning_activities (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        room_id TEXT NOT NULL,
        id TEXT NOT NULL,
        group_key TEXT NOT NULL,
        principal_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        source_kind TEXT NOT NULL,
        source_id TEXT,
        correction_of_activity_id TEXT,
        instruction_summary TEXT NOT NULL CHECK (btrim(instruction_summary) <> ''),
        result_summary TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'cancelled', 'outcome_unknown')),
        verification_state TEXT NOT NULL CHECK (verification_state IN ('confirmed', 'failed', 'not_run', 'unknown')),
        failure_state TEXT NOT NULL CHECK (failure_state IN ('none', 'resolved', 'unresolved')),
        explicit_remember BOOLEAN NOT NULL DEFAULT FALSE,
        payload JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, correction_of_activity_id)
          REFERENCES workspace_learning_activities(workspace_id, id) ON DELETE RESTRICT
          DEFERRABLE INITIALLY DEFERRED
      )`,
      "CREATE INDEX workspace_learning_activities_group_index ON workspace_learning_activities(workspace_id, room_id, group_key, finalized_at DESC)",
      "CREATE INDEX workspace_learning_activities_correction_index ON workspace_learning_activities(workspace_id, correction_of_activity_id) WHERE correction_of_activity_id IS NOT NULL",
      `CREATE TABLE workspace_learning_resources (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace', 'room')),
        room_id TEXT,
        resource_kind TEXT NOT NULL CHECK (resource_kind IN ('knowledge', 'memory', 'skill', 'workspace_rule')),
        state TEXT NOT NULL CHECK (state IN ('active', 'archived', 'conflict')) DEFAULT 'active',
        is_absolute_rule BOOLEAN NOT NULL DEFAULT FALSE,
        ai_update_locked BOOLEAN NOT NULL DEFAULT FALSE,
        title TEXT NOT NULL CHECK (btrim(title) <> ''),
        content TEXT NOT NULL CHECK (btrim(content) <> ''),
        payload JSONB NOT NULL DEFAULT '{}'::JSONB,
        version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        updated_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        archived_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        CHECK ((scope_kind = 'workspace' AND room_id IS NULL) OR (scope_kind = 'room' AND room_id IS NOT NULL)),
        CHECK ((resource_kind = 'workspace_rule') = is_absolute_rule),
        CHECK (resource_kind <> 'workspace_rule' OR scope_kind = 'workspace'),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      "CREATE INDEX workspace_learning_resources_scope_index ON workspace_learning_resources(workspace_id, scope_kind, room_id, state, updated_at DESC)",
      "CREATE INDEX workspace_learning_resources_search_index ON workspace_learning_resources USING GIN ((title || ' ' || content) gin_trgm_ops)",
      `CREATE TABLE workspace_learning_resource_versions (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        version BIGINT NOT NULL CHECK (version > 0),
        change_kind TEXT NOT NULL CHECK (change_kind IN ('created', 'updated', 'evidence_appended', 'conflict_recorded', 'archived', 'restored', 'copied', 'moved', 'promoted', 'fixed', 'unfixed')),
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace', 'room')),
        room_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('active', 'archived', 'conflict')),
        ai_update_locked BOOLEAN NOT NULL DEFAULT FALSE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::JSONB,
        content_hash TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
        actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, resource_id, version),
        CHECK ((scope_kind = 'workspace' AND room_id IS NULL) OR (scope_kind = 'room' AND room_id IS NOT NULL)),
        FOREIGN KEY (workspace_id, resource_id) REFERENCES workspace_learning_resources(workspace_id, id) ON DELETE RESTRICT
      )`,
      "CREATE INDEX workspace_learning_versions_resource_index ON workspace_learning_resource_versions(workspace_id, resource_id, version DESC)",
      `CREATE TABLE workspace_learning_evidence (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_version BIGINT NOT NULL CHECK (resource_version > 0),
        activity_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('activity', 'human_correction', 'explicit_remember', 'use_outcome')),
        summary TEXT NOT NULL CHECK (btrim(summary) <> ''),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, resource_id, resource_version, activity_id, kind),
        FOREIGN KEY (workspace_id, resource_id) REFERENCES workspace_learning_resources(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, resource_id, resource_version)
          REFERENCES workspace_learning_resource_versions(workspace_id, resource_id, version) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, activity_id) REFERENCES workspace_learning_activities(workspace_id, id) ON DELETE RESTRICT
      )`,
      "CREATE INDEX workspace_learning_evidence_resource_index ON workspace_learning_evidence(workspace_id, resource_id, resource_version)",
      `CREATE TABLE workspace_learning_resource_links (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        from_resource_id TEXT NOT NULL,
        to_resource_id TEXT NOT NULL,
        relation TEXT NOT NULL CHECK (relation IN ('conflicts', 'copied_from', 'moved_from', 'promoted_from', 'derived_from')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, from_resource_id, to_resource_id, relation),
        CHECK (from_resource_id <> to_resource_id),
        FOREIGN KEY (workspace_id, from_resource_id) REFERENCES workspace_learning_resources(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, to_resource_id) REFERENCES workspace_learning_resources(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_learning_settings (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace', 'room')),
        room_id TEXT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        engine_id TEXT,
        model TEXT,
        secret_ref TEXT,
        currency_limit NUMERIC,
        token_limit BIGINT,
        currency_used NUMERIC NOT NULL DEFAULT 0 CHECK (currency_used >= 0),
        tokens_used BIGINT NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
        version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
        updated_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        CHECK ((scope_kind = 'workspace' AND room_id IS NULL) OR (scope_kind = 'room' AND room_id IS NOT NULL)),
        CHECK ((scope_kind = 'workspace' AND id = 'workspace') OR (scope_kind = 'room' AND id = ('room:' || room_id))),
        CHECK (currency_limit IS NULL OR currency_limit >= 0),
        CHECK (token_limit IS NULL OR token_limit >= 0),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE UNIQUE INDEX workspace_learning_workspace_settings_singleton
       ON workspace_learning_settings(workspace_id) WHERE scope_kind = 'workspace'`,
      `CREATE UNIQUE INDEX workspace_learning_room_settings_singleton
       ON workspace_learning_settings(workspace_id, room_id) WHERE scope_kind = 'room'`,
      `CREATE TABLE workspace_learning_jobs (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        room_id TEXT NOT NULL,
        id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('review', 'curator')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'blocked')),
        priority TEXT NOT NULL CHECK (priority IN ('normal', 'high')) DEFAULT 'normal',
        group_key TEXT NOT NULL,
        high_watermark_activity_id TEXT NOT NULL,
        next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        heartbeat_at TIMESTAMPTZ,
        blocked_reason TEXT,
        engine_id TEXT,
        model TEXT,
        created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        updated_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, high_watermark_activity_id) REFERENCES workspace_learning_activities(workspace_id, id) ON DELETE RESTRICT,
        CHECK ((status = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL)),
        CHECK ((status <> 'blocked') OR blocked_reason IS NOT NULL)
      )`,
      "CREATE INDEX workspace_learning_jobs_due_index ON workspace_learning_jobs(workspace_id, room_id, status, next_run_at, priority)",
      `CREATE UNIQUE INDEX workspace_learning_queued_group_index
       ON workspace_learning_jobs(workspace_id, room_id, kind, group_key) WHERE status = 'queued'`,
      `CREATE TABLE workspace_learning_job_attempts (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        worker_id TEXT NOT NULL,
        engine_id TEXT,
        model TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'blocked')),
        input_hash TEXT NOT NULL,
        output_hash TEXT,
        output JSONB,
        error_code TEXT,
        currency_used NUMERIC NOT NULL DEFAULT 0 CHECK (currency_used >= 0),
        tokens_used BIGINT NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, job_id, attempt_no),
        FOREIGN KEY (workspace_id, job_id) REFERENCES workspace_learning_jobs(workspace_id, id) ON DELETE RESTRICT
      )`,
      "CREATE INDEX workspace_learning_attempts_job_index ON workspace_learning_job_attempts(workspace_id, job_id, attempt_no DESC)",
      `CREATE TABLE workspace_learning_resource_uses (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_version BIGINT NOT NULL CHECK (resource_version > 0),
        activity_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('confirmed_success', 'confirmed_failure', 'unknown')),
        summary TEXT NOT NULL CHECK (btrim(summary) <> ''),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, resource_id, resource_version, activity_id),
        FOREIGN KEY (workspace_id, resource_id) REFERENCES workspace_learning_resources(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, resource_id, resource_version)
          REFERENCES workspace_learning_resource_versions(workspace_id, resource_id, version) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, activity_id) REFERENCES workspace_learning_activities(workspace_id, id) ON DELETE RESTRICT
      )`,
      "ALTER TABLE workspace_learning_activities ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_learning_resources ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_learning_resource_versions ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_learning_evidence ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_learning_resource_links ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_learning_settings ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_learning_jobs ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_learning_job_attempts ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_learning_resource_uses ENABLE ROW LEVEL SECURITY",
      `CREATE POLICY workspace_learning_activities_read ON workspace_learning_activities FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')
      )`,
      `CREATE POLICY workspace_learning_activities_insert ON workspace_learning_activities FOR INSERT WITH CHECK (
        workspace_id = samurai_current_workspace_id()
        AND (
          samurai_is_import_session(workspace_id)
          OR (
            principal_account_id = samurai_current_account_id()
            AND samurai_can_room(workspace_id, room_id, 'execute')
            AND samurai_workspace_is_writable(workspace_id)
          )
        )
      )`,
      `CREATE POLICY workspace_learning_resources_read ON workspace_learning_resources FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND (
          (scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'guest'))
          OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read'))
        )
      )`,
      `CREATE POLICY workspace_learning_resources_insert ON workspace_learning_resources FOR INSERT
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (
         samurai_is_import_session(workspace_id)
         OR (samurai_workspace_is_writable(workspace_id) AND (
           (scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin'))
           OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'edit'))
         ))
       ))`,
      `CREATE POLICY workspace_learning_resources_update ON workspace_learning_resources FOR UPDATE
       USING (workspace_id = samurai_current_workspace_id() AND (
         (scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin'))
         OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'edit'))
       ))
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (
         samurai_is_import_session(workspace_id)
         OR (samurai_workspace_is_writable(workspace_id) AND (
           (scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin'))
           OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'edit'))
         ))
       ))`,
      `CREATE POLICY workspace_learning_versions_read ON workspace_learning_resource_versions FOR SELECT
       USING (workspace_id = samurai_current_workspace_id() AND EXISTS (
         SELECT 1 FROM workspace_learning_resources resource
         WHERE resource.workspace_id = workspace_learning_resource_versions.workspace_id
           AND resource.id = workspace_learning_resource_versions.resource_id
           AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest'))
             OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read')))
       ))
      `,
      `CREATE POLICY workspace_learning_versions_insert ON workspace_learning_resource_versions FOR INSERT
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (
         samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND EXISTS (
           SELECT 1 FROM workspace_learning_resources resource
           WHERE resource.workspace_id = workspace_learning_resource_versions.workspace_id
             AND resource.id = workspace_learning_resource_versions.resource_id
             AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'admin'))
               OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'edit')))
         ))
       ))`,
      `CREATE POLICY workspace_learning_evidence_read ON workspace_learning_evidence FOR SELECT
       USING (workspace_id = samurai_current_workspace_id() AND EXISTS (
         SELECT 1 FROM workspace_learning_resources resource
         WHERE resource.workspace_id = workspace_learning_evidence.workspace_id
           AND resource.id = workspace_learning_evidence.resource_id
           AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest'))
             OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read')))
       ))
      `,
      `CREATE POLICY workspace_learning_evidence_insert ON workspace_learning_evidence FOR INSERT
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (
         samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND EXISTS (
           SELECT 1 FROM workspace_learning_resources resource
           WHERE resource.workspace_id = workspace_learning_evidence.workspace_id
             AND resource.id = workspace_learning_evidence.resource_id
             AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'admin'))
               OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'edit')))
         ))
       ))`,
      `CREATE POLICY workspace_learning_links_read ON workspace_learning_resource_links FOR SELECT
       USING (workspace_id = samurai_current_workspace_id() AND EXISTS (
         SELECT 1 FROM workspace_learning_resources source
         JOIN workspace_learning_resources target
           ON target.workspace_id = source.workspace_id AND target.id = workspace_learning_resource_links.to_resource_id
         WHERE source.workspace_id = workspace_learning_resource_links.workspace_id
           AND source.id = workspace_learning_resource_links.from_resource_id
           AND ((source.scope_kind = 'workspace' AND samurai_can_workspace(source.workspace_id, 'guest'))
             OR (source.scope_kind = 'room' AND source.room_id IS NOT NULL AND samurai_can_room(source.workspace_id, source.room_id, 'read')))
           AND ((target.scope_kind = 'workspace' AND samurai_can_workspace(target.workspace_id, 'guest'))
             OR (target.scope_kind = 'room' AND target.room_id IS NOT NULL AND samurai_can_room(target.workspace_id, target.room_id, 'read')))
       ))
      `,
      `CREATE POLICY workspace_learning_links_insert ON workspace_learning_resource_links FOR INSERT
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (
         samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND EXISTS (
           SELECT 1 FROM workspace_learning_resources source
           JOIN workspace_learning_resources target
             ON target.workspace_id = source.workspace_id AND target.id = workspace_learning_resource_links.to_resource_id
           WHERE source.workspace_id = workspace_learning_resource_links.workspace_id
             AND source.id = workspace_learning_resource_links.from_resource_id
             AND ((source.scope_kind = 'workspace' AND samurai_can_workspace(source.workspace_id, 'admin'))
               OR (source.scope_kind = 'room' AND source.room_id IS NOT NULL AND samurai_can_room(source.workspace_id, source.room_id, 'edit')))
             AND ((target.scope_kind = 'workspace' AND samurai_can_workspace(target.workspace_id, 'admin'))
               OR (target.scope_kind = 'room' AND target.room_id IS NOT NULL AND samurai_can_room(target.workspace_id, target.room_id, 'edit')))
         ))
       ))`,
      `CREATE POLICY workspace_learning_settings_read ON workspace_learning_settings FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND (
          (scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'guest'))
          OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read'))
        )
      )`,
      `CREATE POLICY workspace_learning_settings_write ON workspace_learning_settings FOR ALL
       USING (workspace_id = samurai_current_workspace_id() AND (
         (scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin'))
         OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'manage'))
       ))
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (
         samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND (
           (scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin'))
           OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'manage'))
         ))
       ))`,
      `CREATE POLICY workspace_learning_jobs_read ON workspace_learning_jobs FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')
      )`,
      `CREATE POLICY workspace_learning_jobs_write ON workspace_learning_jobs FOR ALL
       USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'execute'))
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (
         samurai_is_import_session(workspace_id) OR (samurai_can_room(workspace_id, room_id, 'execute') AND samurai_workspace_is_writable(workspace_id))
       ))`,
      `CREATE POLICY workspace_learning_attempts_access ON workspace_learning_job_attempts FOR ALL
       USING (workspace_id = samurai_current_workspace_id() AND EXISTS (
         SELECT 1 FROM workspace_learning_jobs job
         WHERE job.workspace_id = workspace_learning_job_attempts.workspace_id
           AND job.id = workspace_learning_job_attempts.job_id
           AND samurai_can_room(job.workspace_id, job.room_id, 'read')
       ))
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (
         samurai_is_import_session(workspace_id) OR EXISTS (
           SELECT 1 FROM workspace_learning_jobs job
           WHERE job.workspace_id = workspace_learning_job_attempts.workspace_id
             AND job.id = workspace_learning_job_attempts.job_id
             AND samurai_can_room(job.workspace_id, job.room_id, 'execute')
         )
       ))`,
      `CREATE POLICY workspace_learning_resource_uses_read ON workspace_learning_resource_uses FOR SELECT
       USING (workspace_id = samurai_current_workspace_id() AND EXISTS (
         SELECT 1 FROM workspace_learning_resources resource
         WHERE resource.workspace_id = workspace_learning_resource_uses.workspace_id
           AND resource.id = workspace_learning_resource_uses.resource_id
           AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest'))
             OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read')))
       ))
      `,
      `CREATE POLICY workspace_learning_resource_uses_insert ON workspace_learning_resource_uses FOR INSERT
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (
         samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND EXISTS (
           SELECT 1 FROM workspace_learning_resources resource
           WHERE resource.workspace_id = workspace_learning_resource_uses.workspace_id
             AND resource.id = workspace_learning_resource_uses.resource_id
             AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'admin'))
               OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'edit')))
         ))
       ))`
    ]
  },
  {
    version: 27,
    name: "workspace_server_learning_integrity_hardening",
    statements: [
      // Preserve automatic Knowledge provenance and make its provisional
      // state explicit. Existing v26 rows remain valid without backfill.
      "ALTER TABLE workspace_learning_resources DROP CONSTRAINT workspace_learning_resources_state_check",
      "ALTER TABLE workspace_learning_resources ADD COLUMN confidence NUMERIC, ADD COLUMN source_job_id TEXT, ADD COLUMN source_attempt_id TEXT",
      "ALTER TABLE workspace_learning_resources ADD CONSTRAINT workspace_learning_resources_state_check CHECK (state IN ('active', 'provisional', 'archived', 'conflict'))",
      "ALTER TABLE workspace_learning_resources ADD CONSTRAINT workspace_learning_resources_confidence_check CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))",
      "ALTER TABLE workspace_learning_resources ADD CONSTRAINT workspace_learning_resources_source_pair_check CHECK ((source_job_id IS NULL) = (source_attempt_id IS NULL))",
      "ALTER TABLE workspace_learning_resources ADD CONSTRAINT workspace_learning_resources_provisional_source_check CHECK (state <> 'provisional' OR (confidence IS NOT NULL AND source_job_id IS NOT NULL AND source_attempt_id IS NOT NULL))",
      "ALTER TABLE workspace_learning_resources ADD CONSTRAINT workspace_learning_resources_source_job_fkey FOREIGN KEY (workspace_id, source_job_id) REFERENCES workspace_learning_jobs(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
      "ALTER TABLE workspace_learning_resources ADD CONSTRAINT workspace_learning_resources_source_attempt_fkey FOREIGN KEY (workspace_id, source_attempt_id) REFERENCES workspace_learning_job_attempts(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
      "ALTER TABLE workspace_learning_resource_versions DROP CONSTRAINT workspace_learning_resource_versions_state_check",
      "ALTER TABLE workspace_learning_resource_versions ADD COLUMN confidence NUMERIC, ADD COLUMN source_job_id TEXT, ADD COLUMN source_attempt_id TEXT",
      "ALTER TABLE workspace_learning_resource_versions ADD CONSTRAINT workspace_learning_resource_versions_state_check CHECK (state IN ('active', 'provisional', 'archived', 'conflict'))",
      "ALTER TABLE workspace_learning_resource_versions ADD CONSTRAINT workspace_learning_resource_versions_confidence_check CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))",
      "ALTER TABLE workspace_learning_resource_versions ADD CONSTRAINT workspace_learning_resource_versions_source_pair_check CHECK ((source_job_id IS NULL) = (source_attempt_id IS NULL))",
      "ALTER TABLE workspace_learning_resource_versions ADD CONSTRAINT workspace_learning_resource_versions_provisional_source_check CHECK (state <> 'provisional' OR (confidence IS NOT NULL AND source_job_id IS NOT NULL AND source_attempt_id IS NOT NULL))",
      "ALTER TABLE workspace_learning_resource_versions ADD CONSTRAINT workspace_learning_resource_versions_source_job_fkey FOREIGN KEY (workspace_id, source_job_id) REFERENCES workspace_learning_jobs(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
      "ALTER TABLE workspace_learning_resource_versions ADD CONSTRAINT workspace_learning_resource_versions_source_attempt_fkey FOREIGN KEY (workspace_id, source_attempt_id) REFERENCES workspace_learning_job_attempts(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
      "CREATE UNIQUE INDEX workspace_learning_attempt_id_job_unique ON workspace_learning_job_attempts(workspace_id, id, job_id)",
      "ALTER TABLE workspace_learning_resources ADD CONSTRAINT workspace_learning_resources_source_attempt_job_fkey FOREIGN KEY (workspace_id, source_attempt_id, source_job_id) REFERENCES workspace_learning_job_attempts(workspace_id, id, job_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
      "ALTER TABLE workspace_learning_resource_versions ADD CONSTRAINT workspace_learning_resource_versions_source_attempt_job_fkey FOREIGN KEY (workspace_id, source_attempt_id, source_job_id) REFERENCES workspace_learning_job_attempts(workspace_id, id, job_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
      // Direct human edits are evidence without inventing a Room Activity for
      // Workspace-scoped Knowledge.
      "ALTER TABLE workspace_learning_evidence ALTER COLUMN activity_id DROP NOT NULL",
      "ALTER TABLE workspace_learning_evidence DROP CONSTRAINT workspace_learning_evidence_kind_check",
      "ALTER TABLE workspace_learning_evidence ADD CONSTRAINT workspace_learning_evidence_kind_check CHECK (kind IN ('activity', 'human_correction', 'explicit_remember', 'use_outcome', 'human_edit'))",
      "ALTER TABLE workspace_learning_evidence ADD CONSTRAINT workspace_learning_evidence_activity_shape_check CHECK ((kind = 'human_edit') = (activity_id IS NULL))",
      // A later confirmation supersedes an unknown observation; neither row
      // is overwritten. Drop the former single-row uniqueness dynamically so
      // upgrades also work if PostgreSQL chose a different constraint name.
      `DO $$ DECLARE constraint_name TEXT; BEGIN
         SELECT conname INTO constraint_name FROM pg_constraint
         WHERE conrelid = 'workspace_learning_resource_uses'::regclass
           AND contype = 'u' AND pg_get_constraintdef(oid) LIKE '%(workspace_id, resource_id, resource_version, activity_id)%';
         IF constraint_name IS NOT NULL THEN EXECUTE format('ALTER TABLE workspace_learning_resource_uses DROP CONSTRAINT %I', constraint_name); END IF;
       END $$`,
      "ALTER TABLE workspace_learning_resource_uses ADD COLUMN supersedes_use_id TEXT",
      "ALTER TABLE workspace_learning_resource_uses ADD CONSTRAINT workspace_learning_resource_uses_supersedes_fkey FOREIGN KEY (workspace_id, supersedes_use_id) REFERENCES workspace_learning_resource_uses(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
      "CREATE UNIQUE INDEX workspace_learning_resource_use_initial_unique ON workspace_learning_resource_uses(workspace_id, resource_id, resource_version, activity_id) WHERE supersedes_use_id IS NULL",
      "CREATE UNIQUE INDEX workspace_learning_resource_use_correction_unique ON workspace_learning_resource_uses(workspace_id, supersedes_use_id) WHERE supersedes_use_id IS NOT NULL",
      // Reserve the declared maximum before invoking a cassette. This avoids
      // two concurrent workers both spending the same remaining budget.
      "ALTER TABLE workspace_learning_settings ADD COLUMN currency_reserved NUMERIC NOT NULL DEFAULT 0 CHECK (currency_reserved >= 0), ADD COLUMN tokens_reserved BIGINT NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0)",
      "ALTER TABLE workspace_learning_job_attempts ADD COLUMN reserved_currency NUMERIC NOT NULL DEFAULT 0 CHECK (reserved_currency >= 0), ADD COLUMN reserved_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0)",
      // A Room executor may settle an already-configured review, but must not
      // receive general Settings write access. Keep this one accounting update
      // atomic with the same Room/Workspace/RLS boundary as the Job itself.
      `CREATE OR REPLACE FUNCTION samurai_adjust_workspace_learning_usage(
        target_workspace_id TEXT,
        target_room_id TEXT,
        reserved_currency_delta NUMERIC,
        reserved_tokens_delta BIGINT,
        used_currency_delta NUMERIC,
        used_tokens_delta BIGINT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE setting_row workspace_learning_settings%ROWTYPE;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_workspace_is_writable(target_workspace_id)
          OR NOT samurai_can_room(target_workspace_id, target_room_id, 'execute') THEN
          RAISE EXCEPTION 'workspace_learning_usage_permission_denied';
        END IF;
        IF reserved_currency_delta IS NULL OR reserved_tokens_delta IS NULL
          OR used_currency_delta IS NULL OR used_tokens_delta IS NULL
          OR used_currency_delta < 0 OR used_tokens_delta < 0 THEN
          RAISE EXCEPTION 'workspace_learning_usage_delta_invalid';
        END IF;
        FOR setting_row IN
          SELECT * FROM workspace_learning_settings
          WHERE workspace_id = target_workspace_id
            AND (scope_kind = 'workspace' OR (scope_kind = 'room' AND room_id = target_room_id))
          ORDER BY CASE scope_kind WHEN 'workspace' THEN 0 ELSE 1 END
          FOR UPDATE
        LOOP
          IF setting_row.currency_reserved + reserved_currency_delta < 0
            OR setting_row.tokens_reserved + reserved_tokens_delta < 0 THEN
            RAISE EXCEPTION 'workspace_learning_reservation_underflow';
          END IF;
          IF setting_row.currency_limit IS NOT NULL
            AND setting_row.currency_used + used_currency_delta + setting_row.currency_reserved + reserved_currency_delta > setting_row.currency_limit THEN
            RAISE EXCEPTION 'workspace_learning_currency_budget_exhausted';
          END IF;
          IF setting_row.token_limit IS NOT NULL
            AND setting_row.tokens_used + used_tokens_delta + setting_row.tokens_reserved + reserved_tokens_delta > setting_row.token_limit THEN
            RAISE EXCEPTION 'workspace_learning_token_budget_exhausted';
          END IF;
          UPDATE workspace_learning_settings
          SET currency_reserved = currency_reserved + reserved_currency_delta,
              tokens_reserved = tokens_reserved + reserved_tokens_delta,
              currency_used = currency_used + used_currency_delta,
              tokens_used = tokens_used + used_tokens_delta,
              version = version + 1,
              updated_at = NOW()
          WHERE workspace_id = target_workspace_id AND id = setting_row.id;
        END LOOP;
      END
      $$`,
      "REVOKE ALL ON FUNCTION samurai_adjust_workspace_learning_usage(TEXT, TEXT, NUMERIC, BIGINT, NUMERIC, BIGINT) FROM PUBLIC",
      `CREATE OR REPLACE FUNCTION samurai_lock_workspace_learning_settings(
        target_workspace_id TEXT,
        target_room_id TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_workspace_is_writable(target_workspace_id)
          OR NOT samurai_can_room(target_workspace_id, target_room_id, 'execute') THEN
          RAISE EXCEPTION 'workspace_learning_settings_lock_permission_denied';
        END IF;
        PERFORM id FROM workspace_learning_settings
        WHERE workspace_id = target_workspace_id
          AND (scope_kind = 'workspace' OR (scope_kind = 'room' AND room_id = target_room_id))
        ORDER BY CASE scope_kind WHEN 'workspace' THEN 0 ELSE 1 END
        FOR UPDATE;
      END
      $$`,
      "REVOKE ALL ON FUNCTION samurai_lock_workspace_learning_settings(TEXT, TEXT) FROM PUBLIC",
      // Evidence and use rows may only reveal an Activity when the caller can
      // read that Activity's Room. A Workspace-scoped Resource alone is not
      // enough to disclose private Room evidence.
      "DROP POLICY workspace_learning_evidence_read ON workspace_learning_evidence",
      "DROP POLICY workspace_learning_evidence_insert ON workspace_learning_evidence",
      `CREATE POLICY workspace_learning_evidence_read ON workspace_learning_evidence FOR SELECT
       USING (workspace_id = samurai_current_workspace_id() AND EXISTS (
         SELECT 1 FROM workspace_learning_resources resource
         WHERE resource.workspace_id = workspace_learning_evidence.workspace_id AND resource.id = workspace_learning_evidence.resource_id
           AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest'))
             OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read')))
           AND (workspace_learning_evidence.activity_id IS NULL OR EXISTS (
             SELECT 1 FROM workspace_learning_activities activity
             WHERE activity.workspace_id = workspace_learning_evidence.workspace_id AND activity.id = workspace_learning_evidence.activity_id
               AND samurai_can_room(activity.workspace_id, activity.room_id, 'read')
               AND (resource.scope_kind = 'workspace' OR resource.room_id = activity.room_id)
           ))
       ))`,
      `CREATE POLICY workspace_learning_evidence_insert ON workspace_learning_evidence FOR INSERT
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (
         samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND EXISTS (
           SELECT 1 FROM workspace_learning_resources resource
           WHERE resource.workspace_id = workspace_learning_evidence.workspace_id AND resource.id = workspace_learning_evidence.resource_id
             AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'admin'))
               OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'edit')))
             AND ((workspace_learning_evidence.kind = 'human_edit' AND workspace_learning_evidence.activity_id IS NULL) OR EXISTS (
               SELECT 1 FROM workspace_learning_activities activity
               WHERE activity.workspace_id = workspace_learning_evidence.workspace_id AND activity.id = workspace_learning_evidence.activity_id
                 AND samurai_can_room(activity.workspace_id, activity.room_id, 'execute')
                 AND (resource.scope_kind = 'workspace' OR resource.room_id = activity.room_id)
             ))
         ))
       ))`,
      "DROP POLICY workspace_learning_resource_uses_read ON workspace_learning_resource_uses",
      "DROP POLICY workspace_learning_resource_uses_insert ON workspace_learning_resource_uses",
      `CREATE POLICY workspace_learning_resource_uses_read ON workspace_learning_resource_uses FOR SELECT
       USING (workspace_id = samurai_current_workspace_id() AND EXISTS (
         SELECT 1 FROM workspace_learning_resources resource
         JOIN workspace_learning_activities activity ON activity.workspace_id = workspace_learning_resource_uses.workspace_id AND activity.id = workspace_learning_resource_uses.activity_id
         WHERE resource.workspace_id = workspace_learning_resource_uses.workspace_id AND resource.id = workspace_learning_resource_uses.resource_id
           AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest'))
             OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read')))
           AND samurai_can_room(activity.workspace_id, activity.room_id, 'read')
           AND (resource.scope_kind = 'workspace' OR resource.room_id = activity.room_id)
       ))`,
      `CREATE POLICY workspace_learning_resource_uses_insert ON workspace_learning_resource_uses FOR INSERT
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (
         samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND EXISTS (
           SELECT 1 FROM workspace_learning_resources resource
           JOIN workspace_learning_activities activity ON activity.workspace_id = workspace_learning_resource_uses.workspace_id AND activity.id = workspace_learning_resource_uses.activity_id
           WHERE resource.workspace_id = workspace_learning_resource_uses.workspace_id AND resource.id = workspace_learning_resource_uses.resource_id
             AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest'))
               OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'edit')))
             AND samurai_can_room(activity.workspace_id, activity.room_id, 'execute')
             AND (resource.scope_kind = 'workspace' OR resource.room_id = activity.room_id)
         ))
       ))`,
      // Settings are mutable configuration, but a Room override can be
      // intentionally removed only while the Workspace is writable. Do not
      // let the broad v26 FOR ALL policy make a read-only Workspace mutable.
      "DROP POLICY workspace_learning_settings_write ON workspace_learning_settings",
      `CREATE POLICY workspace_learning_settings_insert ON workspace_learning_settings FOR INSERT
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (
         samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND (
           (scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin'))
           OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'manage'))
         ))
       ))`,
      `CREATE POLICY workspace_learning_settings_update ON workspace_learning_settings FOR UPDATE
       USING (workspace_id = samurai_current_workspace_id() AND samurai_workspace_is_writable(workspace_id) AND (
         (scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin'))
         OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'manage'))
       ))
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (
         samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND (
           (scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin'))
           OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'manage'))
         ))
       ))`,
      `CREATE POLICY workspace_learning_settings_delete ON workspace_learning_settings FOR DELETE
       USING (workspace_id = samurai_current_workspace_id() AND samurai_workspace_is_writable(workspace_id) AND (
         (scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin'))
         OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'manage'))
       ))`,
      // Jobs and attempts are append/update state machines. Runtime callers
      // never delete their history.
      "DROP POLICY workspace_learning_jobs_write ON workspace_learning_jobs",
      `CREATE POLICY workspace_learning_jobs_insert ON workspace_learning_jobs FOR INSERT
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND samurai_can_room(workspace_id, room_id, 'execute'))))`,
      `CREATE POLICY workspace_learning_jobs_update ON workspace_learning_jobs FOR UPDATE
       USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'execute'))
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND samurai_can_room(workspace_id, room_id, 'execute'))))`,
      "DROP POLICY workspace_learning_attempts_access ON workspace_learning_job_attempts",
      `CREATE POLICY workspace_learning_attempts_read ON workspace_learning_job_attempts FOR SELECT
       USING (workspace_id = samurai_current_workspace_id() AND EXISTS (
         SELECT 1 FROM workspace_learning_jobs job WHERE job.workspace_id = workspace_learning_job_attempts.workspace_id AND job.id = workspace_learning_job_attempts.job_id AND samurai_can_room(job.workspace_id, job.room_id, 'read')
       ))`,
      `CREATE POLICY workspace_learning_attempts_insert ON workspace_learning_job_attempts FOR INSERT
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR EXISTS (
         SELECT 1 FROM workspace_learning_jobs job WHERE job.workspace_id = workspace_learning_job_attempts.workspace_id AND job.id = workspace_learning_job_attempts.job_id AND samurai_workspace_is_writable(job.workspace_id) AND samurai_can_room(job.workspace_id, job.room_id, 'execute')
       )))`,
      `CREATE POLICY workspace_learning_attempts_update ON workspace_learning_job_attempts FOR UPDATE
       USING (workspace_id = samurai_current_workspace_id() AND EXISTS (
         SELECT 1 FROM workspace_learning_jobs job WHERE job.workspace_id = workspace_learning_job_attempts.workspace_id AND job.id = workspace_learning_job_attempts.job_id AND samurai_can_room(job.workspace_id, job.room_id, 'execute')
       ))
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR EXISTS (
         SELECT 1 FROM workspace_learning_jobs job WHERE job.workspace_id = workspace_learning_job_attempts.workspace_id AND job.id = workspace_learning_job_attempts.job_id AND samurai_workspace_is_writable(job.workspace_id) AND samurai_can_room(job.workspace_id, job.room_id, 'execute')
       )))`,
      // Import abort must delete the new dependent tables before Rooms.
      `CREATE OR REPLACE FUNCTION samurai_abort_workspace_import(
        target_workspace_id TEXT,
        import_session_id TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        DELETE FROM workspace_learning_resource_uses WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_resource_links WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_evidence WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_resource_versions WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_resources WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_job_attempts WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_jobs WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_activities WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_settings WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_audit_entries WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_bundles WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_transfers WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_invitations WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_jobs WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_events WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_operations WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_file_transactions WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_files WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_records WHERE workspace_id = target_workspace_id;
        DELETE FROM room_members WHERE workspace_id = target_workspace_id;
        DELETE FROM rooms WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_members WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_import_sessions WHERE workspace_id = target_workspace_id AND id = import_session_id;
        DELETE FROM workspaces WHERE id = target_workspace_id AND state = 'read_only';
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_import_target_invalid'; END IF;
      END
      $$`
    ]
  },
  {
    version: 28,
    name: "workspace_server_completion_resource_file_policy_episode",
    statements: [
      // Server 04 completion keeps a new model beside the v26/v27 tables so
      // legacy rows can be migrated without a destructive in-place rewrite.
      // New resource bodies are represented only by a file pointer + hash.
      `CREATE TABLE workspace_completion_configurations (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        scope_key TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace', 'room')),
        room_id TEXT,
        version BIGINT NOT NULL CHECK (version > 0),
        values JSONB NOT NULL,
        updated_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, scope_key, version),
        CHECK ((scope_kind = 'workspace' AND scope_key = 'workspace' AND room_id IS NULL)
          OR (scope_kind = 'room' AND scope_key = room_id AND room_id IS NOT NULL)),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_completion_activities (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        room_id TEXT NOT NULL,
        id TEXT NOT NULL,
        principal_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        source_app TEXT NOT NULL CHECK (btrim(source_app) <> ''),
        source_id TEXT,
        external_episode_key TEXT,
        correction_of_activity_id TEXT,
        operation_id TEXT,
        instruction_summary TEXT NOT NULL CHECK (btrim(instruction_summary) <> ''),
        result_summary TEXT,
        changed_resources JSONB NOT NULL DEFAULT '[]'::JSONB,
        verification_outcome TEXT NOT NULL CHECK (verification_outcome IN ('confirmed', 'failed', 'not_run', 'unknown')),
        failure_state TEXT NOT NULL CHECK (failure_state IN ('none', 'resolved', 'unresolved')),
        outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'cancelled', 'unknown')),
        explicit_remember BOOLEAN NOT NULL DEFAULT FALSE,
        payload JSONB NOT NULL DEFAULT '{}'::JSONB,
        session_ref JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, correction_of_activity_id) REFERENCES workspace_completion_activities(workspace_id, id) ON DELETE RESTRICT,
        CHECK (jsonb_typeof(changed_resources) = 'array')
      )`,
      "CREATE INDEX workspace_completion_activities_room_index ON workspace_completion_activities(workspace_id, room_id, finalized_at, id)",
      `CREATE TABLE workspace_completion_episodes (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        room_id TEXT NOT NULL,
        id TEXT NOT NULL,
        goal TEXT NOT NULL CHECK (btrim(goal) <> ''),
        source_app TEXT,
        external_episode_key TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'unknown')) DEFAULT 'unknown',
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        session_ref JSONB,
        version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        updated_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        UNIQUE NULLS NOT DISTINCT (workspace_id, room_id, external_episode_key),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_completion_episode_activities (
        workspace_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        activity_id TEXT NOT NULL,
        relation TEXT NOT NULL CHECK (relation IN ('external_episode', 'goal_operation', 'correction', 'resource_use', 'legacy_group', 'single_activity')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, episode_id, activity_id),
        FOREIGN KEY (workspace_id, episode_id) REFERENCES workspace_completion_episodes(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, activity_id) REFERENCES workspace_completion_activities(workspace_id, id) ON DELETE RESTRICT
      )`,
      "CREATE INDEX workspace_completion_episode_activities_activity_index ON workspace_completion_episode_activities(workspace_id, activity_id)",
      `CREATE TABLE workspace_completion_resources (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace', 'room')),
        room_id TEXT,
        resource_kind TEXT NOT NULL CHECK (resource_kind IN ('knowledge', 'skill', 'policy')),
        knowledge_kind TEXT CHECK (knowledge_kind IN ('fact', 'decision', 'explanation', 'experience_rule')),
        title TEXT NOT NULL CHECK (btrim(title) <> ''),
        evidence_state TEXT NOT NULL CHECK (evidence_state IN ('provisional', 'confirmed', 'contradicted', 'review_required')),
        lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'stale', 'archived')),
        ai_protection TEXT NOT NULL CHECK (ai_protection IN ('editable', 'fixed')),
        creation_source TEXT NOT NULL CHECK (creation_source IN ('human', 'ai', 'import', 'machine_verified', 'physical_file_import')),
        ai_managed BOOLEAN NOT NULL DEFAULT FALSE,
        version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
        current_confirmed_version BIGINT,
        current_provisional_version BIGINT,
        candidate_version BIGINT,
        archived_at TIMESTAMPTZ,
        created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        updated_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        CHECK ((scope_kind = 'workspace' AND room_id IS NULL) OR (scope_kind = 'room' AND room_id IS NOT NULL)),
        CHECK ((resource_kind = 'knowledge') = (knowledge_kind IS NOT NULL)),
        CHECK ((lifecycle_state = 'archived') = (archived_at IS NOT NULL)),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      "CREATE INDEX workspace_completion_resources_scope_index ON workspace_completion_resources(workspace_id, scope_kind, room_id, lifecycle_state, updated_at DESC)",
      `CREATE TABLE workspace_completion_resource_versions (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        version BIGINT NOT NULL CHECK (version > 0),
        parent_version BIGINT,
        file_path TEXT NOT NULL CHECK (btrim(file_path) <> ''),
        content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
        content_size BIGINT NOT NULL CHECK (content_size >= 0),
        evidence_state TEXT NOT NULL CHECK (evidence_state IN ('provisional', 'confirmed', 'contradicted', 'review_required')),
        lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'stale', 'archived')),
        ai_protection TEXT NOT NULL CHECK (ai_protection IN ('editable', 'fixed')),
        creation_source TEXT NOT NULL CHECK (creation_source IN ('human', 'ai', 'import', 'machine_verified', 'physical_file_import')),
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
        actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, resource_id, version),
        FOREIGN KEY (workspace_id, resource_id) REFERENCES workspace_completion_resources(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, resource_id, parent_version) REFERENCES workspace_completion_resource_versions(workspace_id, resource_id, version) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
      )`,
      "CREATE INDEX workspace_completion_versions_resource_index ON workspace_completion_resource_versions(workspace_id, resource_id, version DESC)",
      "ALTER TABLE workspace_completion_resources ADD CONSTRAINT workspace_completion_resources_confirmed_version_fkey FOREIGN KEY (workspace_id, id, current_confirmed_version) REFERENCES workspace_completion_resource_versions(workspace_id, resource_id, version) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
      "ALTER TABLE workspace_completion_resources ADD CONSTRAINT workspace_completion_resources_provisional_version_fkey FOREIGN KEY (workspace_id, id, current_provisional_version) REFERENCES workspace_completion_resource_versions(workspace_id, resource_id, version) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
      "ALTER TABLE workspace_completion_resources ADD CONSTRAINT workspace_completion_resources_candidate_version_fkey FOREIGN KEY (workspace_id, id, candidate_version) REFERENCES workspace_completion_resource_versions(workspace_id, resource_id, version) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
      `CREATE TABLE workspace_completion_evidence (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_version BIGINT NOT NULL,
        activity_id TEXT,
        episode_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('activity', 'human_edit', 'explicit_remember', 'use_outcome', 'machine_attestation', 'physical_file_import')),
        summary TEXT NOT NULL CHECK (btrim(summary) <> ''),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, resource_id, resource_version) REFERENCES workspace_completion_resource_versions(workspace_id, resource_id, version) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, activity_id) REFERENCES workspace_completion_activities(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, episode_id) REFERENCES workspace_completion_episodes(workspace_id, id) ON DELETE RESTRICT,
        CHECK ((kind = 'human_edit') = (activity_id IS NULL))
      )`,
      "CREATE INDEX workspace_completion_evidence_resource_index ON workspace_completion_evidence(workspace_id, resource_id, resource_version)",
      `CREATE TABLE workspace_completion_resource_links (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        from_resource_id TEXT NOT NULL,
        to_resource_id TEXT NOT NULL,
        relation TEXT NOT NULL CHECK (relation IN ('conflicts', 'copied_from', 'moved_from', 'promoted_from', 'derived_from', 'supersedes')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, from_resource_id, to_resource_id, relation),
        CHECK (from_resource_id <> to_resource_id),
        FOREIGN KEY (workspace_id, from_resource_id) REFERENCES workspace_completion_resources(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, to_resource_id) REFERENCES workspace_completion_resources(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_completion_policy_rules (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_version BIGINT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('activity.ingest', 'resource.create', 'resource.update', 'resource.archive', 'resource.copy', 'resource.move', 'resource.promote', 'file.import', 'curator.apply', 'external.send', 'policy.apply', 'membership.change')),
        effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny', 'require')),
        principal_account_id TEXT,
        connection_id TEXT,
        conditions JSONB NOT NULL DEFAULT '{}'::JSONB,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        human_signature TEXT NOT NULL CHECK (btrim(human_signature) <> ''),
        signed_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, resource_id, resource_version) REFERENCES workspace_completion_resource_versions(workspace_id, resource_id, version) ON DELETE RESTRICT,
        CHECK (jsonb_typeof(conditions) = 'object')
      )`,
      "CREATE INDEX workspace_completion_policy_rules_lookup_index ON workspace_completion_policy_rules(workspace_id, resource_id, resource_version, operation) WHERE enabled",
      `CREATE TABLE workspace_completion_policy_change_requests (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        room_id TEXT NOT NULL,
        id TEXT NOT NULL,
        requested_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        source_job_id TEXT,
        summary TEXT NOT NULL CHECK (btrim(summary) <> ''),
        proposed_rules JSONB NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('requested', 'applied', 'rejected')) DEFAULT 'requested',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT,
        CHECK (jsonb_typeof(proposed_rules) = 'array')
      )`,
      `CREATE TABLE workspace_completion_uses (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_version BIGINT NOT NULL,
        activity_id TEXT,
        episode_id TEXT,
        event TEXT NOT NULL CHECK (event IN ('selected', 'body_loaded', 'support_loaded', 'actually_used', 'outcome', 'correction')),
        outcome TEXT CHECK (outcome IN ('confirmed_success', 'confirmed_failure', 'unknown')),
        supersedes_use_id TEXT,
        summary TEXT NOT NULL CHECK (btrim(summary) <> ''),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, resource_id, resource_version) REFERENCES workspace_completion_resource_versions(workspace_id, resource_id, version) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, activity_id) REFERENCES workspace_completion_activities(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, episode_id) REFERENCES workspace_completion_episodes(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, supersedes_use_id) REFERENCES workspace_completion_uses(workspace_id, id) ON DELETE RESTRICT,
        CHECK ((event = 'outcome') = (outcome IS NOT NULL))
      )`,
      "CREATE UNIQUE INDEX workspace_completion_uses_correction_unique ON workspace_completion_uses(workspace_id, supersedes_use_id) WHERE supersedes_use_id IS NOT NULL",
      `CREATE TABLE workspace_completion_evaluations (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_version BIGINT NOT NULL,
        episode_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('confirmed_success', 'confirmed_failure', 'unknown')),
        source_activity_id TEXT,
        correction_of_evaluation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, resource_id, resource_version, episode_id),
        FOREIGN KEY (workspace_id, resource_id, resource_version) REFERENCES workspace_completion_resource_versions(workspace_id, resource_id, version) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, episode_id) REFERENCES workspace_completion_episodes(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, source_activity_id) REFERENCES workspace_completion_activities(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, correction_of_evaluation_id) REFERENCES workspace_completion_evaluations(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_completion_jobs (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        room_id TEXT NOT NULL,
        id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('review', 'evaluation', 'curator')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'blocked')),
        idempotency_key TEXT NOT NULL,
        group_key TEXT,
        high_watermark TEXT,
        input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
        configuration_version BIGINT NOT NULL CHECK (configuration_version > 0),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        heartbeat_at TIMESTAMPTZ,
        blocked_reason TEXT,
        created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        updated_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, idempotency_key),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT,
        CHECK ((status = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL)),
        CHECK ((status <> 'blocked') OR blocked_reason IS NOT NULL)
      )`,
      "CREATE INDEX workspace_completion_jobs_due_index ON workspace_completion_jobs(workspace_id, room_id, status, updated_at)",
      `CREATE TABLE workspace_completion_job_attempts (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        worker_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'blocked', 'repairable_validation')),
        input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
        output_hash TEXT,
        error_code TEXT,
        configuration_version BIGINT NOT NULL CHECK (configuration_version > 0),
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, job_id, attempt_no),
        FOREIGN KEY (workspace_id, job_id) REFERENCES workspace_completion_jobs(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_completion_curator_state (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        room_id TEXT NOT NULL,
        paused BOOLEAN NOT NULL DEFAULT FALSE,
        semantic_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        seeded_at TIMESTAMPTZ,
        last_light_run_at TIMESTAMPTZ,
        last_semantic_run_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, room_id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_completion_curator_snapshots (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        snapshot JSONB NOT NULL,
        created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_completion_file_batches (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('db_committed', 'renamed', 'rolled_back')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_completion_file_batch_entries (
        workspace_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        size BIGINT NOT NULL CHECK (size >= 0),
        PRIMARY KEY (workspace_id, batch_id, path),
        FOREIGN KEY (workspace_id, batch_id) REFERENCES workspace_completion_file_batches(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_completion_search_projection (
        workspace_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_version BIGINT NOT NULL,
        search_text TEXT NOT NULL,
        rebuilt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, resource_id, resource_version),
        FOREIGN KEY (workspace_id, resource_id, resource_version) REFERENCES workspace_completion_resource_versions(workspace_id, resource_id, version) ON DELETE RESTRICT
      )`,
      "CREATE INDEX workspace_completion_search_trigram_index ON workspace_completion_search_projection USING GIN (search_text gin_trgm_ops)",
      `CREATE TABLE workspace_completion_migration_receipts (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        source_format TEXT NOT NULL,
        target_format TEXT NOT NULL,
        counts JSONB NOT NULL,
        integrity_hash TEXT NOT NULL CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),
        status TEXT NOT NULL CHECK (status IN ('prepared', 'verified', 'switched', 'rolled_back', 'failed')),
        created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id)
      )`,
      "ALTER TABLE workspace_completion_configurations ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_activities ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_episodes ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_episode_activities ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_resources ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_resource_versions ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_evidence ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_resource_links ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_policy_rules ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_policy_change_requests ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_uses ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_evaluations ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_jobs ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_job_attempts ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_curator_state ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_curator_snapshots ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_file_batches ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_file_batch_entries ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_search_projection ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_migration_receipts ENABLE ROW LEVEL SECURITY",
      `CREATE POLICY workspace_completion_configurations_read ON workspace_completion_configurations FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND ((scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'guest')) OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read')))
      )`,
      `CREATE POLICY workspace_completion_configurations_write ON workspace_completion_configurations FOR ALL USING (
        workspace_id = samurai_current_workspace_id() AND ((scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin')) OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'manage')))
      ) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND ((scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin')) OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'manage'))))))`,
      `CREATE POLICY workspace_completion_activities_read ON workspace_completion_activities FOR SELECT USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read'))`,
      `CREATE POLICY workspace_completion_activities_write ON workspace_completion_activities FOR ALL USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'execute')) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND principal_account_id = samurai_current_account_id() AND samurai_can_room(workspace_id, room_id, 'execute'))))`,
      `CREATE POLICY workspace_completion_episodes_access ON workspace_completion_episodes FOR ALL USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND samurai_can_room(workspace_id, room_id, 'execute'))))`,
      `CREATE POLICY workspace_completion_episode_activities_access ON workspace_completion_episode_activities FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_episodes episode WHERE episode.workspace_id = workspace_completion_episode_activities.workspace_id AND episode.id = workspace_completion_episode_activities.episode_id AND samurai_can_room(episode.workspace_id, episode.room_id, 'read'))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR EXISTS (SELECT 1 FROM workspace_completion_episodes episode WHERE episode.workspace_id = workspace_completion_episode_activities.workspace_id AND episode.id = workspace_completion_episode_activities.episode_id AND samurai_can_room(episode.workspace_id, episode.room_id, 'execute'))))`,
      `CREATE POLICY workspace_completion_resources_access ON workspace_completion_resources FOR ALL USING (workspace_id = samurai_current_workspace_id() AND ((scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'guest')) OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read')))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND ((scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin')) OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'edit'))))))`,
      `CREATE POLICY workspace_completion_versions_access ON workspace_completion_resource_versions FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_resources resource WHERE resource.workspace_id = workspace_completion_resource_versions.workspace_id AND resource.id = workspace_completion_resource_versions.resource_id AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest')) OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read'))))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR EXISTS (SELECT 1 FROM workspace_completion_resources resource WHERE resource.workspace_id = workspace_completion_resource_versions.workspace_id AND resource.id = workspace_completion_resource_versions.resource_id AND samurai_workspace_is_writable(resource.workspace_id) AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'admin')) OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'edit'))))))`,
      `CREATE POLICY workspace_completion_evidence_access ON workspace_completion_evidence FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_resources resource WHERE resource.workspace_id = workspace_completion_evidence.workspace_id AND resource.id = workspace_completion_evidence.resource_id AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest')) OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read'))))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR EXISTS (SELECT 1 FROM workspace_completion_resources resource WHERE resource.workspace_id = workspace_completion_evidence.workspace_id AND resource.id = workspace_completion_evidence.resource_id AND samurai_workspace_is_writable(resource.workspace_id) AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'admin')) OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'edit'))))))`,
      `CREATE POLICY workspace_completion_links_access ON workspace_completion_resource_links FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_resources source JOIN workspace_completion_resources target ON target.workspace_id = source.workspace_id AND target.id = workspace_completion_resource_links.to_resource_id WHERE source.workspace_id = workspace_completion_resource_links.workspace_id AND source.id = workspace_completion_resource_links.from_resource_id AND ((source.scope_kind = 'workspace' AND samurai_can_workspace(source.workspace_id, 'guest')) OR (source.scope_kind = 'room' AND source.room_id IS NOT NULL AND samurai_can_room(source.workspace_id, source.room_id, 'read'))) AND ((target.scope_kind = 'workspace' AND samurai_can_workspace(target.workspace_id, 'guest')) OR (target.scope_kind = 'room' AND target.room_id IS NOT NULL AND samurai_can_room(target.workspace_id, target.room_id, 'read'))))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND samurai_workspace_is_writable(workspace_id))`,
      `CREATE POLICY workspace_completion_policy_rules_access ON workspace_completion_policy_rules FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_resources resource WHERE resource.workspace_id = workspace_completion_policy_rules.workspace_id AND resource.id = workspace_completion_policy_rules.resource_id AND resource.resource_kind = 'policy' AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest')) OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read'))))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND samurai_workspace_is_writable(workspace_id) AND EXISTS (SELECT 1 FROM workspace_completion_resources resource WHERE resource.workspace_id = workspace_completion_policy_rules.workspace_id AND resource.id = workspace_completion_policy_rules.resource_id AND resource.resource_kind = 'policy' AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'admin')) OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'manage')))))`,
      `CREATE POLICY workspace_completion_policy_requests_access ON workspace_completion_policy_change_requests FOR ALL USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND samurai_can_room(workspace_id, room_id, 'execute'))))`,
      `CREATE POLICY workspace_completion_uses_access ON workspace_completion_uses FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_resources resource WHERE resource.workspace_id = workspace_completion_uses.workspace_id AND resource.id = workspace_completion_uses.resource_id AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest')) OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read'))))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND samurai_workspace_is_writable(workspace_id))`,
      `CREATE POLICY workspace_completion_evaluations_access ON workspace_completion_evaluations FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_resources resource WHERE resource.workspace_id = workspace_completion_evaluations.workspace_id AND resource.id = workspace_completion_evaluations.resource_id AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest')) OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read'))))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND samurai_workspace_is_writable(workspace_id))`,
      `CREATE POLICY workspace_completion_jobs_access ON workspace_completion_jobs FOR ALL USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND samurai_can_room(workspace_id, room_id, 'execute'))))`,
      `CREATE POLICY workspace_completion_attempts_access ON workspace_completion_job_attempts FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_jobs job WHERE job.workspace_id = workspace_completion_job_attempts.workspace_id AND job.id = workspace_completion_job_attempts.job_id AND samurai_can_room(job.workspace_id, job.room_id, 'read'))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR EXISTS (SELECT 1 FROM workspace_completion_jobs job WHERE job.workspace_id = workspace_completion_job_attempts.workspace_id AND job.id = workspace_completion_job_attempts.job_id AND samurai_workspace_is_writable(job.workspace_id) AND samurai_can_room(job.workspace_id, job.room_id, 'execute'))))`,
      `CREATE POLICY workspace_completion_curator_state_access ON workspace_completion_curator_state FOR ALL USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND samurai_can_room(workspace_id, room_id, 'manage'))))`,
      `CREATE POLICY workspace_completion_curator_snapshots_access ON workspace_completion_curator_snapshots FOR ALL USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND samurai_can_room(workspace_id, room_id, 'execute'))))`,
      `CREATE POLICY workspace_completion_file_batches_access ON workspace_completion_file_batches FOR ALL USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND samurai_can_room(workspace_id, room_id, 'execute'))))`,
      `CREATE POLICY workspace_completion_file_batch_entries_access ON workspace_completion_file_batch_entries FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_file_batches batch WHERE batch.workspace_id = workspace_completion_file_batch_entries.workspace_id AND batch.id = workspace_completion_file_batch_entries.batch_id AND samurai_can_room(batch.workspace_id, batch.room_id, 'read'))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR EXISTS (SELECT 1 FROM workspace_completion_file_batches batch WHERE batch.workspace_id = workspace_completion_file_batch_entries.workspace_id AND batch.id = workspace_completion_file_batch_entries.batch_id AND samurai_can_room(batch.workspace_id, batch.room_id, 'execute'))))`,
      `CREATE POLICY workspace_completion_search_access ON workspace_completion_search_projection FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_resources resource WHERE resource.workspace_id = workspace_completion_search_projection.workspace_id AND resource.id = workspace_completion_search_projection.resource_id AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest')) OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read'))))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND samurai_workspace_is_writable(workspace_id))`,
      `CREATE POLICY workspace_completion_migration_receipts_access ON workspace_completion_migration_receipts FOR ALL USING (workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'owner')) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND samurai_can_workspace(workspace_id, 'owner'))))`,
      // Old Memory/workspace_rule rows can be imported for migration, but a
      // running Server cannot create or update either legacy kind again.
      `CREATE OR REPLACE FUNCTION samurai_reject_legacy_learning_kinds() RETURNS TRIGGER
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF NEW.resource_kind IN ('memory', 'workspace_rule') AND NOT samurai_is_import_session(NEW.workspace_id) THEN
          RAISE EXCEPTION 'workspace_legacy_learning_write_retired';
        END IF;
        RETURN NEW;
      END
      $$`,
      "DROP TRIGGER IF EXISTS workspace_learning_reject_legacy_kinds ON workspace_learning_resources",
      "CREATE TRIGGER workspace_learning_reject_legacy_kinds BEFORE INSERT OR UPDATE ON workspace_learning_resources FOR EACH ROW EXECUTE FUNCTION samurai_reject_legacy_learning_kinds()",
      // Import abort has to delete all new dependent rows before Rooms.
      `CREATE OR REPLACE FUNCTION samurai_abort_workspace_import(
        target_workspace_id TEXT,
        import_session_id TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        DELETE FROM workspace_completion_file_batch_entries WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_file_batches WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_search_projection WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_policy_rules WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_policy_change_requests WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_uses WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_evaluations WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_evidence WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_resource_links WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_resource_versions WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_resources WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_episode_activities WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_activities WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_episodes WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_job_attempts WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_jobs WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_curator_snapshots WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_curator_state WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_configurations WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_migration_receipts WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_resource_uses WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_resource_links WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_evidence WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_resource_versions WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_resources WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_job_attempts WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_jobs WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_activities WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_settings WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_audit_entries WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_bundles WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_transfers WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_invitations WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_jobs WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_events WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_operations WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_file_transactions WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_files WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_records WHERE workspace_id = target_workspace_id;
        DELETE FROM room_members WHERE workspace_id = target_workspace_id;
        DELETE FROM rooms WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_members WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_import_sessions WHERE workspace_id = target_workspace_id AND id = import_session_id;
        DELETE FROM workspaces WHERE id = target_workspace_id AND state = 'read_only';
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_import_target_invalid'; END IF;
      END
      $$`
    ]
  },
  {
    // This follow-up stays additive so an operator who already applied v28
    // can safely acquire the visibility and append-only guarantees.
    version: 29,
    name: "workspace_server_completion_batch_visibility_append_only",
    statements: [
      "ALTER TABLE workspace_completion_resource_versions ADD COLUMN file_batch_id TEXT",
      "ALTER TABLE workspace_completion_resource_versions ADD CONSTRAINT workspace_completion_versions_file_batch_fkey FOREIGN KEY (workspace_id, file_batch_id) REFERENCES workspace_completion_file_batches(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
      "CREATE INDEX workspace_completion_versions_batch_index ON workspace_completion_resource_versions(workspace_id, file_batch_id) WHERE file_batch_id IS NOT NULL",
      // An Evaluation is append-only.  One base result and any number of
      // later corrections may coexist; callers select the newest chain head.
      `DO $$
      DECLARE constraint_name TEXT;
      BEGIN
        SELECT conname INTO constraint_name
        FROM pg_constraint
        WHERE conrelid = 'workspace_completion_evaluations'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) LIKE '%workspace_id, resource_id, resource_version, episode_id%';
        IF constraint_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE workspace_completion_evaluations DROP CONSTRAINT %I', constraint_name);
        END IF;
      END
      $$`,
      "CREATE UNIQUE INDEX workspace_completion_evaluation_base_unique ON workspace_completion_evaluations(workspace_id, resource_id, resource_version, episode_id) WHERE correction_of_evaluation_id IS NULL",
      `CREATE OR REPLACE FUNCTION samurai_guard_completion_version_update() RETURNS TRIGGER
      LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.workspace_id, NEW.id, NEW.resource_id, NEW.version, NEW.parent_version,
          NEW.content_hash, NEW.content_size, NEW.evidence_state, NEW.lifecycle_state,
          NEW.ai_protection, NEW.creation_source, NEW.metadata, NEW.reason,
          NEW.actor_account_id, NEW.created_at, NEW.file_batch_id)
          IS DISTINCT FROM ROW(OLD.workspace_id, OLD.id, OLD.resource_id, OLD.version, OLD.parent_version,
          OLD.content_hash, OLD.content_size, OLD.evidence_state, OLD.lifecycle_state,
          OLD.ai_protection, OLD.creation_source, OLD.metadata, OLD.reason,
          OLD.actor_account_id, OLD.created_at, OLD.file_batch_id) THEN
          RAISE EXCEPTION 'workspace_completion_version_immutable';
        END IF;
        RETURN NEW;
      END
      $$`,
      "CREATE TRIGGER workspace_completion_versions_immutable BEFORE UPDATE ON workspace_completion_resource_versions FOR EACH ROW EXECUTE FUNCTION samurai_guard_completion_version_update()",
      "ALTER TABLE workspace_completion_activities FORCE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_resource_versions FORCE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_evidence FORCE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_resource_links FORCE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_uses FORCE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_evaluations FORCE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_job_attempts FORCE ROW LEVEL SECURITY"
    ]
  },
  {
    version: 30,
    name: "workspace_server_completion_profile_soul_file_metadata",
    statements: [
      `CREATE TABLE workspace_completion_workspace_documents (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('profile', 'soul')),
        file_path TEXT NOT NULL CHECK (file_path IN ('profile/PROFILE.md', 'profile/SOUL.md')),
        content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
        content_size BIGINT NOT NULL CHECK (content_size >= 0),
        version BIGINT NOT NULL CHECK (version > 0),
        file_batch_id TEXT NOT NULL,
        updated_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, kind),
        FOREIGN KEY (workspace_id, file_batch_id) REFERENCES workspace_completion_file_batches(workspace_id, id) ON DELETE RESTRICT
      )`,
      "ALTER TABLE workspace_completion_workspace_documents ENABLE ROW LEVEL SECURITY",
      `CREATE POLICY workspace_completion_workspace_documents_read ON workspace_completion_workspace_documents FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'guest')
      )`,
      `CREATE POLICY workspace_completion_workspace_documents_write ON workspace_completion_workspace_documents FOR ALL USING (
        workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'admin')
      ) WITH CHECK (
        workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND samurai_can_workspace(workspace_id, 'admin')))
      )`
    ]
  },
  {
    version: 31,
    name: "workspace_server_completion_evidence_and_import_recovery",
    statements: [
      // Machine attestations, physical imports, and Curator evidence have no
      // fabricated Activity. Activity-derived evidence still requires one.
      `DO $$
      DECLARE constraint_name TEXT;
      BEGIN
        SELECT conname INTO constraint_name
        FROM pg_constraint
        WHERE conrelid = 'workspace_completion_evidence'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%human_edit%activity_id%';
        IF constraint_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE workspace_completion_evidence DROP CONSTRAINT %I', constraint_name);
        END IF;
      END
      $$`,
      "ALTER TABLE workspace_completion_evidence ADD CONSTRAINT workspace_completion_evidence_activity_required CHECK ((kind NOT IN ('activity', 'explicit_remember', 'use_outcome')) OR activity_id IS NOT NULL)",
      // Import abort deletes batches before its old tables. Make the small
      // PROFILE/SOUL metadata follow that batch deletion safely.
      `DO $$
      DECLARE constraint_name TEXT;
      BEGIN
        FOR constraint_name IN
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'workspace_completion_workspace_documents'::regclass AND contype = 'f'
        LOOP
          EXECUTE format('ALTER TABLE workspace_completion_workspace_documents DROP CONSTRAINT %I', constraint_name);
        END LOOP;
      END
      $$`,
      "ALTER TABLE workspace_completion_workspace_documents ADD CONSTRAINT workspace_completion_documents_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE",
      "ALTER TABLE workspace_completion_workspace_documents ADD CONSTRAINT workspace_completion_documents_batch_fkey FOREIGN KEY (workspace_id, file_batch_id) REFERENCES workspace_completion_file_batches(workspace_id, id) ON DELETE CASCADE"
    ]
  },
  {
    version: 32,
    name: "workspace_server_completion_skill_package_files",
    statements: [
      // SKILL.md has a ResourceVersion pointer.  These rows make the rest of
      // the package equally file-backed, hash-checked, and batch-visible.
      `CREATE TABLE workspace_completion_skill_files (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_version BIGINT NOT NULL,
        relative_path TEXT NOT NULL CHECK (relative_path ~ '^(references|scripts|templates|examples)/.+'),
        file_path TEXT NOT NULL CHECK (btrim(file_path) <> ''),
        content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
        content_size BIGINT NOT NULL CHECK (content_size >= 0),
        file_batch_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, resource_id, resource_version, relative_path),
        FOREIGN KEY (workspace_id, resource_id, resource_version)
          REFERENCES workspace_completion_resource_versions(workspace_id, resource_id, version) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, file_batch_id)
          REFERENCES workspace_completion_file_batches(workspace_id, id) ON DELETE CASCADE
      )`,
      "CREATE INDEX workspace_completion_skill_files_version_index ON workspace_completion_skill_files(workspace_id, resource_id, resource_version, relative_path)",
      `CREATE OR REPLACE FUNCTION samurai_guard_completion_skill_file_update() RETURNS TRIGGER
      LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.workspace_id, NEW.id, NEW.resource_id, NEW.resource_version, NEW.relative_path,
          NEW.content_hash, NEW.content_size, NEW.file_batch_id, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.workspace_id, OLD.id, OLD.resource_id, OLD.resource_version, OLD.relative_path,
          OLD.content_hash, OLD.content_size, OLD.file_batch_id, OLD.created_at) THEN
          RAISE EXCEPTION 'workspace_completion_skill_file_immutable';
        END IF;
        RETURN NEW;
      END
      $$`,
      "CREATE TRIGGER workspace_completion_skill_files_immutable BEFORE UPDATE ON workspace_completion_skill_files FOR EACH ROW EXECUTE FUNCTION samurai_guard_completion_skill_file_update()",
      "ALTER TABLE workspace_completion_skill_files ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_skill_files FORCE ROW LEVEL SECURITY",
      `CREATE POLICY workspace_completion_skill_files_access ON workspace_completion_skill_files FOR ALL USING (
        workspace_id = samurai_current_workspace_id() AND EXISTS (
          SELECT 1 FROM workspace_completion_resources resource
          WHERE resource.workspace_id = workspace_completion_skill_files.workspace_id
            AND resource.id = workspace_completion_skill_files.resource_id
            AND resource.resource_kind = 'skill'
            AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest'))
              OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read')))
        )
      ) WITH CHECK (
        workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR EXISTS (
          SELECT 1 FROM workspace_completion_resources resource
          WHERE resource.workspace_id = workspace_completion_skill_files.workspace_id
            AND resource.id = workspace_completion_skill_files.resource_id
            AND resource.resource_kind = 'skill'
            AND samurai_workspace_is_writable(resource.workspace_id)
            AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'admin'))
              OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'edit')))
        ))
      )`
    ]
  },
  {
    // Raw backend exchange data is not a Knowledge body.  It is retained for
    // a bounded period, and can be tombstoned without deleting the durable
    // Job/Attempt/error evidence that operators need for recovery.
    version: 33,
    name: "workspace_server_completion_retention_and_redaction",
    statements: [
      `CREATE TABLE workspace_completion_job_raw_outputs (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('request', 'response')),
        content TEXT,
        content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
        created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        redacted_at TIMESTAMPTZ,
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, attempt_id, direction),
        FOREIGN KEY (workspace_id, job_id) REFERENCES workspace_completion_jobs(workspace_id, id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, attempt_id) REFERENCES workspace_completion_job_attempts(workspace_id, id) ON DELETE CASCADE,
        CHECK ((content IS NULL) = (redacted_at IS NOT NULL))
      )`,
      "CREATE INDEX workspace_completion_job_raw_outputs_retention_index ON workspace_completion_job_raw_outputs(workspace_id, created_at) WHERE redacted_at IS NULL",
      `CREATE TABLE workspace_completion_redactions (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        reason_hash TEXT NOT NULL CHECK (reason_hash ~ '^[0-9a-f]{64}$'),
        requested_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, resource_id),
        FOREIGN KEY (workspace_id, resource_id) REFERENCES workspace_completion_resources(workspace_id, id) ON DELETE CASCADE
      )`,
      "ALTER TABLE workspace_completion_job_raw_outputs ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_job_raw_outputs FORCE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_redactions ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_redactions FORCE ROW LEVEL SECURITY",
      `CREATE POLICY workspace_completion_job_raw_outputs_access ON workspace_completion_job_raw_outputs FOR ALL USING (
        workspace_id = samurai_current_workspace_id() AND EXISTS (
          SELECT 1 FROM workspace_completion_jobs job
          WHERE job.workspace_id = workspace_completion_job_raw_outputs.workspace_id
            AND job.id = workspace_completion_job_raw_outputs.job_id
            AND samurai_can_room(job.workspace_id, job.room_id, 'execute')
        )
      ) WITH CHECK (
        workspace_id = samurai_current_workspace_id() AND EXISTS (
          SELECT 1 FROM workspace_completion_jobs job
          WHERE job.workspace_id = workspace_completion_job_raw_outputs.workspace_id
            AND job.id = workspace_completion_job_raw_outputs.job_id
            AND samurai_workspace_is_writable(job.workspace_id)
            AND samurai_can_room(job.workspace_id, job.room_id, 'execute')
        )
      )`,
      `CREATE POLICY workspace_completion_redactions_access ON workspace_completion_redactions FOR ALL USING (
        workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'owner')
      ) WITH CHECK (
        workspace_id = samurai_current_workspace_id() AND samurai_workspace_is_writable(workspace_id)
          AND samurai_can_workspace(workspace_id, 'owner')
      )`,
      // Version rows are normally append-only. The tightly scoped session
      // flag is only set by the owner-only redaction service below, and lets
      // it replace a secret body with a hash-checked tombstone in-place.
      `CREATE OR REPLACE FUNCTION samurai_guard_completion_version_update() RETURNS TRIGGER
      LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('samurai_completion_redaction', true) = 'on' THEN
          IF ROW(NEW.workspace_id, NEW.id, NEW.resource_id, NEW.version, NEW.parent_version,
            NEW.evidence_state, NEW.lifecycle_state, NEW.ai_protection, NEW.creation_source,
            NEW.reason, NEW.actor_account_id, NEW.created_at, NEW.file_batch_id)
            IS DISTINCT FROM ROW(OLD.workspace_id, OLD.id, OLD.resource_id, OLD.version, OLD.parent_version,
            OLD.evidence_state, OLD.lifecycle_state, OLD.ai_protection, OLD.creation_source,
            OLD.reason, OLD.actor_account_id, OLD.created_at, OLD.file_batch_id) THEN
            RAISE EXCEPTION 'workspace_completion_version_immutable';
          END IF;
          RETURN NEW;
        END IF;
        IF ROW(NEW.workspace_id, NEW.id, NEW.resource_id, NEW.version, NEW.parent_version,
          NEW.content_hash, NEW.content_size, NEW.evidence_state, NEW.lifecycle_state,
          NEW.ai_protection, NEW.creation_source, NEW.metadata, NEW.reason,
          NEW.actor_account_id, NEW.created_at, NEW.file_batch_id)
          IS DISTINCT FROM ROW(OLD.workspace_id, OLD.id, OLD.resource_id, OLD.version, OLD.parent_version,
          OLD.content_hash, OLD.content_size, OLD.evidence_state, OLD.lifecycle_state,
          OLD.ai_protection, OLD.creation_source, OLD.metadata, OLD.reason,
          OLD.actor_account_id, OLD.created_at, OLD.file_batch_id) THEN
          RAISE EXCEPTION 'workspace_completion_version_immutable';
        END IF;
        RETURN NEW;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_guard_completion_skill_file_update() RETURNS TRIGGER
      LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('samurai_completion_redaction', true) = 'on' THEN
          IF ROW(NEW.workspace_id, NEW.id, NEW.resource_id, NEW.resource_version, NEW.relative_path,
            NEW.file_batch_id, NEW.created_at)
            IS DISTINCT FROM ROW(OLD.workspace_id, OLD.id, OLD.resource_id, OLD.resource_version, OLD.relative_path,
            OLD.file_batch_id, OLD.created_at) THEN
            RAISE EXCEPTION 'workspace_completion_skill_file_immutable';
          END IF;
          RETURN NEW;
        END IF;
        IF ROW(NEW.workspace_id, NEW.id, NEW.resource_id, NEW.resource_version, NEW.relative_path,
          NEW.content_hash, NEW.content_size, NEW.file_batch_id, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.workspace_id, OLD.id, OLD.resource_id, OLD.resource_version, OLD.relative_path,
          OLD.content_hash, OLD.content_size, OLD.file_batch_id, OLD.created_at) THEN
          RAISE EXCEPTION 'workspace_completion_skill_file_immutable';
        END IF;
        RETURN NEW;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_redact_completion_resource(
        target_workspace_id TEXT,
        target_resource_id TEXT,
        redaction_id TEXT,
        target_reason_hash TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE target_room_id TEXT;
      BEGIN
        IF samurai_current_workspace_id() IS DISTINCT FROM target_workspace_id
          OR NOT samurai_workspace_is_writable(target_workspace_id)
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_completion_redaction_owner_required';
        END IF;
        SELECT room_id INTO target_room_id
        FROM workspace_completion_resources
        WHERE workspace_id = target_workspace_id AND id = target_resource_id
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_completion_resource_not_found'; END IF;
        UPDATE workspace_completion_resources
        SET title = '[REDACTED]', lifecycle_state = 'archived', archived_at = NOW(),
            updated_by = samurai_current_account_id(), updated_at = NOW()
        WHERE workspace_id = target_workspace_id AND id = target_resource_id;
        UPDATE workspace_completion_evidence SET summary = '[REDACTED]'
        WHERE workspace_id = target_workspace_id AND resource_id = target_resource_id;
        UPDATE workspace_completion_uses SET summary = '[REDACTED]'
        WHERE workspace_id = target_workspace_id AND resource_id = target_resource_id;
        DELETE FROM workspace_completion_search_projection
        WHERE workspace_id = target_workspace_id AND resource_id = target_resource_id;
        IF target_room_id IS NOT NULL THEN
          DELETE FROM workspace_completion_curator_snapshots
          WHERE workspace_id = target_workspace_id AND room_id = target_room_id;
        END IF;
        INSERT INTO workspace_completion_redactions(workspace_id, id, resource_id, reason_hash, requested_by)
        VALUES (target_workspace_id, redaction_id, target_resource_id, target_reason_hash, samurai_current_account_id())
        ON CONFLICT (workspace_id, resource_id) DO NOTHING;
      END
      $$`
    ]
  },
  {
    // A maintenance identity is an ordinary, separately registered Account
    // with member-level Room access in exactly one Workspace. The Completion
    // scheduler checks this marker before any Session-less job operation; it
    // never borrows an owner's identity.
    version: 34,
    name: "workspace_server_completion_maintenance_identity",
    statements: [
      `CREATE TABLE workspace_completion_maintenance_identities (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT,
        created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      "ALTER TABLE workspace_completion_maintenance_identities ENABLE ROW LEVEL SECURITY",
      `CREATE POLICY workspace_completion_maintenance_identities_owner_access
       ON workspace_completion_maintenance_identities FOR ALL
       USING (workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'owner'))
       WITH CHECK (workspace_id = samurai_current_workspace_id() AND samurai_workspace_is_writable(workspace_id) AND samurai_can_workspace(workspace_id, 'owner'))`,
      `CREATE OR REPLACE FUNCTION samurai_configure_completion_maintenance_identity(
        target_workspace_id TEXT,
        target_account_id TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing_account_id TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_workspace_is_writable(target_workspace_id)
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_completion_maintenance_owner_required';
        END IF;
        IF target_account_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
          RAISE EXCEPTION 'workspace_completion_maintenance_account_invalid';
        END IF;
        PERFORM 1 FROM accounts WHERE id = target_account_id AND status = 'active';
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_completion_maintenance_account_not_found'; END IF;
        PERFORM 1 FROM workspace_completion_maintenance_identities
        WHERE account_id = target_account_id AND workspace_id <> target_workspace_id;
        IF FOUND THEN RAISE EXCEPTION 'workspace_completion_maintenance_account_already_scoped'; END IF;
        SELECT account_id INTO existing_account_id FROM workspace_completion_maintenance_identities
        WHERE workspace_id = target_workspace_id FOR UPDATE;
        IF FOUND AND existing_account_id <> target_account_id THEN
          RAISE EXCEPTION 'workspace_completion_maintenance_identity_already_configured';
        END IF;
        IF EXISTS(
          SELECT 1 FROM workspace_members
          WHERE workspace_id = target_workspace_id AND account_id = target_account_id
            AND (state <> 'active' OR role <> 'member')
        ) THEN RAISE EXCEPTION 'workspace_completion_maintenance_membership_conflict'; END IF;
        IF EXISTS(
          SELECT 1 FROM room_members
          WHERE workspace_id = target_workspace_id AND account_id = target_account_id
            AND (state <> 'active' OR role <> 'member')
        ) THEN RAISE EXCEPTION 'workspace_completion_maintenance_membership_conflict'; END IF;
        INSERT INTO workspace_members(workspace_id, account_id, role, state)
        VALUES (target_workspace_id, target_account_id, 'member', 'active')
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET state = 'active', revoked_at = NULL, updated_at = NOW();
        INSERT INTO room_members(workspace_id, room_id, account_id, role, state)
        SELECT target_workspace_id, id, target_account_id, 'member', 'active'
        FROM rooms WHERE workspace_id = target_workspace_id
        ON CONFLICT (workspace_id, room_id, account_id) DO UPDATE SET state = 'active', revoked_at = NULL, updated_at = NOW();
        INSERT INTO workspace_completion_maintenance_identities(workspace_id, account_id, created_by)
        VALUES (target_workspace_id, target_account_id, samurai_current_account_id())
        ON CONFLICT (workspace_id) DO NOTHING;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_is_completion_maintenance_identity(target_workspace_id TEXT)
      RETURNS BOOLEAN
      LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT EXISTS(
          SELECT 1 FROM workspace_completion_maintenance_identities
          WHERE workspace_id = target_workspace_id AND account_id = samurai_current_account_id()
        )
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_grant_completion_maintenance_room_member() RETURNS TRIGGER
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE maintenance_account_id TEXT;
      BEGIN
        SELECT account_id INTO maintenance_account_id
        FROM workspace_completion_maintenance_identities WHERE workspace_id = NEW.workspace_id;
        IF maintenance_account_id IS NOT NULL THEN
          INSERT INTO room_members(workspace_id, room_id, account_id, role, state)
          VALUES (NEW.workspace_id, NEW.id, maintenance_account_id, 'member', 'active')
          ON CONFLICT (workspace_id, room_id, account_id) DO NOTHING;
        END IF;
        RETURN NEW;
      END
      $$`,
      "CREATE TRIGGER workspace_completion_maintenance_room_member AFTER INSERT ON rooms FOR EACH ROW EXECUTE FUNCTION samurai_grant_completion_maintenance_room_member()"
    ]
  },
  {
    // A legacy backfill writes file and DB records in several recoverable
    // batches. If verification fails before the switch receipt, remove only
    // those marked import records; the old learning rows remain untouched.
    version: 35,
    name: "workspace_server_completion_legacy_migration_rollback",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_rollback_completion_legacy_migration(
        target_workspace_id TEXT,
        target_integrity_hash TEXT
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE target_resource_ids TEXT[] := ARRAY[]::TEXT[];
      DECLARE target_batch_ids TEXT[] := ARRAY[]::TEXT[];
      DECLARE orphaned_files JSONB := '[]'::JSONB;
      DECLARE removed_resources INTEGER := 0;
      DECLARE removed_activities INTEGER := 0;
      DECLARE removed_jobs INTEGER := 0;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_workspace_is_writable(target_workspace_id)
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_completion_migration_owner_required';
        END IF;
        IF target_integrity_hash !~ '^[a-f0-9]{64}$' THEN
          RAISE EXCEPTION 'workspace_completion_migration_integrity_hash_invalid';
        END IF;
        IF EXISTS(
          SELECT 1 FROM workspace_completion_migration_receipts
          WHERE workspace_id = target_workspace_id
            AND source_format = 'legacy_learning'
            AND status = 'switched'
        ) THEN
          RAISE EXCEPTION 'workspace_completion_migration_already_switched';
        END IF;
        PERFORM set_config('samurai_completion_redaction', 'on', true);
        SET CONSTRAINTS ALL DEFERRED;
        SELECT
          COALESCE(array_agg(DISTINCT resource_id), ARRAY[]::TEXT[]),
          COALESCE(array_agg(DISTINCT file_batch_id) FILTER (WHERE file_batch_id IS NOT NULL), ARRAY[]::TEXT[])
        INTO target_resource_ids, target_batch_ids
        FROM workspace_completion_resource_versions
        WHERE workspace_id = target_workspace_id
          AND metadata ? 'legacy_source';
        IF cardinality(target_batch_ids) > 0 THEN
          SELECT COALESCE(jsonb_agg(jsonb_build_object('path', entry.path, 'sha256', entry.sha256) ORDER BY entry.path), '[]'::JSONB)
          INTO orphaned_files
          FROM workspace_completion_file_batch_entries entry
          WHERE entry.workspace_id = target_workspace_id
            AND entry.batch_id = ANY(target_batch_ids)
            AND NOT EXISTS(
              SELECT 1 FROM workspace_completion_resource_versions version_row
              WHERE version_row.workspace_id = entry.workspace_id
                AND version_row.file_batch_id = entry.batch_id
                AND NOT (version_row.metadata ? 'legacy_source')
            )
            AND NOT EXISTS(
              SELECT 1 FROM workspace_completion_workspace_documents document
              WHERE document.workspace_id = entry.workspace_id
                AND document.file_batch_id = entry.batch_id
            );
        END IF;
        DELETE FROM workspace_completion_job_raw_outputs
        WHERE workspace_id = target_workspace_id AND job_id LIKE 'completion_legacy_job_%';
        DELETE FROM workspace_completion_job_attempts
        WHERE workspace_id = target_workspace_id AND job_id LIKE 'completion_legacy_job_%';
        DELETE FROM workspace_completion_jobs
        WHERE workspace_id = target_workspace_id AND id LIKE 'completion_legacy_job_%';
        GET DIAGNOSTICS removed_jobs = ROW_COUNT;
        DELETE FROM workspace_completion_policy_change_requests
        WHERE workspace_id = target_workspace_id AND id LIKE 'completion_legacy_policy_request_%';
        IF cardinality(target_resource_ids) > 0 THEN
          DELETE FROM workspace_completion_evaluations
          WHERE workspace_id = target_workspace_id AND resource_id = ANY(target_resource_ids);
          DELETE FROM workspace_completion_uses
          WHERE workspace_id = target_workspace_id AND resource_id = ANY(target_resource_ids);
          DELETE FROM workspace_completion_evidence
          WHERE workspace_id = target_workspace_id AND resource_id = ANY(target_resource_ids);
          DELETE FROM workspace_completion_resource_links
          WHERE workspace_id = target_workspace_id
            AND (from_resource_id = ANY(target_resource_ids) OR to_resource_id = ANY(target_resource_ids));
          DELETE FROM workspace_completion_policy_rules
          WHERE workspace_id = target_workspace_id AND resource_id = ANY(target_resource_ids);
          DELETE FROM workspace_completion_search_projection
          WHERE workspace_id = target_workspace_id AND resource_id = ANY(target_resource_ids);
          DELETE FROM workspace_completion_skill_files
          WHERE workspace_id = target_workspace_id AND resource_id = ANY(target_resource_ids);
          DELETE FROM workspace_completion_resource_versions
          WHERE workspace_id = target_workspace_id AND resource_id = ANY(target_resource_ids);
          DELETE FROM workspace_completion_resources
          WHERE workspace_id = target_workspace_id AND id = ANY(target_resource_ids);
          GET DIAGNOSTICS removed_resources = ROW_COUNT;
        END IF;
        DELETE FROM workspace_completion_episode_activities
        WHERE workspace_id = target_workspace_id
          AND (episode_id LIKE 'completion_legacy_episode_%' OR activity_id LIKE 'completion_legacy_activity_%');
        DELETE FROM workspace_completion_episodes
        WHERE workspace_id = target_workspace_id AND id LIKE 'completion_legacy_episode_%';
        DELETE FROM workspace_completion_activities
        WHERE workspace_id = target_workspace_id AND id LIKE 'completion_legacy_activity_%';
        GET DIAGNOSTICS removed_activities = ROW_COUNT;
        IF cardinality(target_batch_ids) > 0 THEN
          DELETE FROM workspace_completion_file_batch_entries entry
          WHERE entry.workspace_id = target_workspace_id
            AND entry.batch_id = ANY(target_batch_ids)
            AND NOT EXISTS(
              SELECT 1 FROM workspace_completion_resource_versions version_row
              WHERE version_row.workspace_id = entry.workspace_id AND version_row.file_batch_id = entry.batch_id
            )
            AND NOT EXISTS(
              SELECT 1 FROM workspace_completion_workspace_documents document
              WHERE document.workspace_id = entry.workspace_id AND document.file_batch_id = entry.batch_id
            );
          DELETE FROM workspace_completion_file_batches batch
          WHERE batch.workspace_id = target_workspace_id
            AND batch.id = ANY(target_batch_ids)
            AND NOT EXISTS(
              SELECT 1 FROM workspace_completion_file_batch_entries entry
              WHERE entry.workspace_id = batch.workspace_id AND entry.batch_id = batch.id
            )
            AND NOT EXISTS(
              SELECT 1 FROM workspace_completion_workspace_documents document
              WHERE document.workspace_id = batch.workspace_id AND document.file_batch_id = batch.id
            );
        END IF;
        RETURN jsonb_build_object(
          'orphaned_files', orphaned_files,
          'removed_resources', removed_resources,
          'removed_activities', removed_activities,
          'removed_jobs', removed_jobs
        );
      END
      $$`
    ]
  },
  {
    // Server 04 hardening is additive: v1-v35 remain immutable migration
    // history.  Scope, human approval, and machine attestation are all
    // durable DB contracts rather than conventions in a TypeScript caller.
    version: 36,
    name: "workspace_server_completion_scope_caller_attestation_hardening",
    statements: [
      `CREATE TABLE workspace_completion_migration_runs (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK (state IN ('preparing', 'backfilling', 'verified', 'switched', 'rolling_back', 'rolled_back', 'failed')),
        source_counts JSONB,
        source_integrity_hash TEXT,
        verification_hash TEXT,
        error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, operation_id),
        CHECK (source_integrity_hash IS NULL OR source_integrity_hash ~ '^[0-9a-f]{64}$'),
        CHECK (verification_hash IS NULL OR verification_hash ~ '^[0-9a-f]{64}$')
      )`,
      "CREATE UNIQUE INDEX workspace_completion_migration_runs_active_unique ON workspace_completion_migration_runs(workspace_id) WHERE state IN ('preparing', 'backfilling', 'verified', 'rolling_back')",
      "ALTER TABLE workspace_completion_migration_runs ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_migration_runs FORCE ROW LEVEL SECURITY",
      `CREATE POLICY workspace_completion_migration_runs_read ON workspace_completion_migration_runs FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'owner')
      )`,
      `CREATE POLICY workspace_completion_migration_runs_write_denied ON workspace_completion_migration_runs FOR ALL USING (false) WITH CHECK (false)`,
      `CREATE OR REPLACE FUNCTION samurai_completion_migration_write_allowed(target_workspace_id TEXT)
      RETURNS BOOLEAN
      LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT EXISTS(
          SELECT 1 FROM workspace_completion_migration_runs run
          WHERE run.workspace_id = target_workspace_id
            AND run.id = samurai_context_value('samurai.completion_migration_run_id')
            AND run.owner_account_id = samurai_current_account_id()
            AND run.state IN ('preparing', 'backfilling', 'verified', 'rolling_back')
        )
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_begin_completion_migration_run(
        target_workspace_id TEXT,
        target_run_id TEXT,
        target_operation_id TEXT
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE current_state TEXT;
      DECLARE existing_state TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR current_setting('samurai.caller_kind', true) IS DISTINCT FROM 'human'
          OR current_setting('samurai.caller_principal_id', true) IS DISTINCT FROM samurai_current_account_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_completion_migration_owner_human_required';
        END IF;
        SELECT state INTO existing_state FROM workspace_completion_migration_runs
        WHERE workspace_id = target_workspace_id AND id = target_run_id FOR UPDATE;
        IF FOUND THEN
          IF existing_state IN ('switched', 'rolled_back') THEN RETURN existing_state; END IF;
          UPDATE workspaces SET state = 'read_only', version = version + 1, updated_at = NOW()
          WHERE id = target_workspace_id AND state = 'active';
          RETURN existing_state;
        END IF;
        SELECT state INTO current_state FROM workspaces WHERE id = target_workspace_id FOR UPDATE;
        IF current_state <> 'active' THEN RAISE EXCEPTION 'workspace_completion_migration_workspace_not_active'; END IF;
        IF EXISTS(
          SELECT 1 FROM workspace_completion_migration_runs
          WHERE workspace_id = target_workspace_id
            AND state IN ('preparing', 'backfilling', 'verified', 'rolling_back')
        ) THEN RAISE EXCEPTION 'workspace_completion_migration_already_running'; END IF;
        INSERT INTO workspace_completion_migration_runs(workspace_id, id, operation_id, owner_account_id, state)
        VALUES (target_workspace_id, target_run_id, target_operation_id, samurai_current_account_id(), 'preparing');
        UPDATE workspaces SET state = 'read_only', version = version + 1, updated_at = NOW()
        WHERE id = target_workspace_id;
        RETURN 'preparing';
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_transition_completion_migration_run(
        target_workspace_id TEXT,
        target_run_id TEXT,
        target_state TEXT,
        target_counts JSONB,
        target_integrity_hash TEXT,
        target_verification_hash TEXT,
        target_error_code TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE previous_state TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_completion_migration_write_allowed(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_completion_migration_context_invalid';
        END IF;
        SELECT state INTO previous_state FROM workspace_completion_migration_runs
        WHERE workspace_id = target_workspace_id AND id = target_run_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_completion_migration_run_not_found'; END IF;
        IF (previous_state = 'preparing' AND target_state NOT IN ('backfilling', 'rolling_back', 'failed'))
          OR (previous_state = 'backfilling' AND target_state NOT IN ('backfilling', 'verified', 'rolling_back', 'failed'))
          OR (previous_state = 'verified' AND target_state NOT IN ('switched', 'rolling_back', 'failed'))
          OR (previous_state = 'rolling_back' AND target_state NOT IN ('rolled_back', 'failed')) THEN
          RAISE EXCEPTION 'workspace_completion_migration_transition_invalid';
        END IF;
        UPDATE workspace_completion_migration_runs
        SET state = target_state,
            source_counts = COALESCE(target_counts, source_counts),
            source_integrity_hash = COALESCE(target_integrity_hash, source_integrity_hash),
            verification_hash = COALESCE(target_verification_hash, verification_hash),
            error_code = target_error_code,
            updated_at = NOW(),
            completed_at = CASE WHEN target_state IN ('switched', 'rolled_back', 'failed') THEN NOW() ELSE NULL END
        WHERE workspace_id = target_workspace_id AND id = target_run_id;
        IF target_state IN ('switched', 'rolled_back', 'failed') THEN
          UPDATE workspaces SET state = 'active', version = version + 1, updated_at = NOW()
          WHERE id = target_workspace_id AND state = 'read_only';
        END IF;
      END
      $$`,
      // Batch scope is data, not a side effect of whichever Room happened to
      // be writable when a Workspace-wide file was staged.
      "ALTER TABLE workspace_completion_file_batches ADD COLUMN scope_kind TEXT",
      `DO $$
      BEGIN
        IF EXISTS(
          WITH references_by_scope AS (
            SELECT version_row.workspace_id, version_row.file_batch_id AS batch_id,
                   resource.scope_kind,
                   CASE WHEN resource.scope_kind = 'workspace' THEN NULL ELSE resource.room_id END AS scope_room_id,
                   CASE WHEN resource.scope_kind = 'workspace' THEN 'workspace' ELSE 'room:' || resource.room_id END AS scope_key
            FROM workspace_completion_resource_versions version_row
            JOIN workspace_completion_resources resource
              ON resource.workspace_id = version_row.workspace_id AND resource.id = version_row.resource_id
            WHERE version_row.file_batch_id IS NOT NULL
            UNION ALL
            SELECT document.workspace_id, document.file_batch_id, 'workspace', NULL, 'workspace'
            FROM workspace_completion_workspace_documents document
            UNION ALL
            SELECT skill_file.workspace_id, skill_file.file_batch_id,
                   resource.scope_kind,
                   CASE WHEN resource.scope_kind = 'workspace' THEN NULL ELSE resource.room_id END,
                   CASE WHEN resource.scope_kind = 'workspace' THEN 'workspace' ELSE 'room:' || resource.room_id END
            FROM workspace_completion_skill_files skill_file
            JOIN workspace_completion_resources resource
              ON resource.workspace_id = skill_file.workspace_id AND resource.id = skill_file.resource_id
          )
          SELECT 1 FROM references_by_scope
          GROUP BY workspace_id, batch_id HAVING COUNT(DISTINCT scope_key) > 1
        ) THEN RAISE EXCEPTION 'workspace_completion_batch_scope_ambiguous'; END IF;
      END
      $$`,
      `UPDATE workspace_completion_file_batches batch
       SET scope_kind = COALESCE(reference.scope_kind, 'room'),
           room_id = reference.scope_room_id
       FROM (
         WITH references_by_scope AS (
           SELECT version_row.workspace_id, version_row.file_batch_id AS batch_id,
                  resource.scope_kind,
                  CASE WHEN resource.scope_kind = 'workspace' THEN NULL ELSE resource.room_id END AS scope_room_id
           FROM workspace_completion_resource_versions version_row
           JOIN workspace_completion_resources resource
             ON resource.workspace_id = version_row.workspace_id AND resource.id = version_row.resource_id
           WHERE version_row.file_batch_id IS NOT NULL
           UNION ALL
           SELECT document.workspace_id, document.file_batch_id, 'workspace', NULL
           FROM workspace_completion_workspace_documents document
           UNION ALL
           SELECT skill_file.workspace_id, skill_file.file_batch_id,
                  resource.scope_kind,
                  CASE WHEN resource.scope_kind = 'workspace' THEN NULL ELSE resource.room_id END
           FROM workspace_completion_skill_files skill_file
           JOIN workspace_completion_resources resource
             ON resource.workspace_id = skill_file.workspace_id AND resource.id = skill_file.resource_id
         )
         SELECT workspace_id, batch_id, MIN(scope_kind) AS scope_kind, MIN(scope_room_id) AS scope_room_id
         FROM references_by_scope GROUP BY workspace_id, batch_id
       ) reference
       WHERE batch.workspace_id = reference.workspace_id AND batch.id = reference.batch_id`,
      "UPDATE workspace_completion_file_batches SET scope_kind = 'room' WHERE scope_kind IS NULL",
      "ALTER TABLE workspace_completion_file_batches ALTER COLUMN room_id DROP NOT NULL",
      "ALTER TABLE workspace_completion_file_batches ALTER COLUMN scope_kind SET NOT NULL",
      "ALTER TABLE workspace_completion_file_batches ADD CONSTRAINT workspace_completion_file_batches_scope_check CHECK ((scope_kind = 'workspace' AND room_id IS NULL) OR (scope_kind = 'room' AND room_id IS NOT NULL))",
      "ALTER TABLE workspace_completion_file_batches ADD CONSTRAINT workspace_completion_file_batches_scope_kind_check CHECK (scope_kind IN ('workspace', 'room'))",
      "CREATE INDEX workspace_completion_file_batches_scope_index ON workspace_completion_file_batches(workspace_id, scope_kind, room_id, status)",
      "DROP POLICY workspace_completion_file_batches_access ON workspace_completion_file_batches",
      `CREATE POLICY workspace_completion_file_batches_access ON workspace_completion_file_batches FOR ALL USING (
        workspace_id = samurai_current_workspace_id() AND (
          (scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'guest'))
          OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read'))
        )
      ) WITH CHECK (
        workspace_id = samurai_current_workspace_id() AND (
          samurai_is_import_session(workspace_id)
          OR samurai_completion_migration_write_allowed(workspace_id)
          OR (samurai_workspace_is_writable(workspace_id) AND (
            (scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin'))
            OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'execute'))
          ))
        )
      )`,
      "DROP POLICY workspace_completion_file_batch_entries_access ON workspace_completion_file_batch_entries",
      `CREATE POLICY workspace_completion_file_batch_entries_access ON workspace_completion_file_batch_entries FOR ALL USING (
        workspace_id = samurai_current_workspace_id() AND EXISTS (
          SELECT 1 FROM workspace_completion_file_batches batch
          WHERE batch.workspace_id = workspace_completion_file_batch_entries.workspace_id
            AND batch.id = workspace_completion_file_batch_entries.batch_id
            AND ((batch.scope_kind = 'workspace' AND samurai_can_workspace(batch.workspace_id, 'guest'))
              OR (batch.scope_kind = 'room' AND batch.room_id IS NOT NULL AND samurai_can_room(batch.workspace_id, batch.room_id, 'read')))
        )
      ) WITH CHECK (
        workspace_id = samurai_current_workspace_id() AND EXISTS (
          SELECT 1 FROM workspace_completion_file_batches batch
          WHERE batch.workspace_id = workspace_completion_file_batch_entries.workspace_id
            AND batch.id = workspace_completion_file_batch_entries.batch_id
            AND (samurai_is_import_session(batch.workspace_id)
              OR samurai_completion_migration_write_allowed(batch.workspace_id)
              OR (samurai_workspace_is_writable(batch.workspace_id) AND (
                (batch.scope_kind = 'workspace' AND samurai_can_workspace(batch.workspace_id, 'admin'))
                OR (batch.scope_kind = 'room' AND batch.room_id IS NOT NULL AND samurai_can_room(batch.workspace_id, batch.room_id, 'execute'))
              )))
        )
      )`,
      // A Policy version is usable only with an append-only proof from the
      // authenticated human request that created it. Old arbitrary strings
      // are retained as history but deactivated pending re-approval.
      `CREATE TABLE workspace_completion_policy_approvals (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_version BIGINT NOT NULL,
        principal_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        operation_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_timestamp TIMESTAMPTZ NOT NULL,
        canonical_payload_hash TEXT NOT NULL CHECK (canonical_payload_hash ~ '^[0-9a-f]{64}$'),
        signature TEXT NOT NULL CHECK (btrim(signature) <> ''),
        change JSONB NOT NULL,
        audit_operation_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, resource_id, resource_version),
        UNIQUE (workspace_id, request_id),
        FOREIGN KEY (workspace_id, resource_id, resource_version)
          REFERENCES workspace_completion_resource_versions(workspace_id, resource_id, version) ON DELETE RESTRICT,
        CHECK (jsonb_typeof(change) = 'object')
      )`,
      "CREATE INDEX workspace_completion_policy_approvals_lookup_index ON workspace_completion_policy_approvals(workspace_id, resource_id, resource_version)",
      "ALTER TABLE workspace_completion_policy_approvals ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_policy_approvals FORCE ROW LEVEL SECURITY",
      `CREATE POLICY workspace_completion_policy_approvals_read ON workspace_completion_policy_approvals FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND EXISTS (
          SELECT 1 FROM workspace_completion_resources resource
          WHERE resource.workspace_id = workspace_completion_policy_approvals.workspace_id
            AND resource.id = workspace_completion_policy_approvals.resource_id
            AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'admin'))
              OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'manage')))
        )
      )`,
      `CREATE POLICY workspace_completion_policy_approvals_insert ON workspace_completion_policy_approvals FOR INSERT WITH CHECK (
        workspace_id = samurai_current_workspace_id()
          AND current_setting('samurai.caller_kind', true) = 'human'
          AND current_setting('samurai.caller_principal_id', true) = samurai_current_account_id()
          AND principal_account_id = samurai_current_account_id()
          AND operation_id = current_setting('samurai.caller_operation_id', true)
          AND request_id = current_setting('samurai.caller_request_id', true)
          AND samurai_workspace_is_writable(workspace_id)
      )`,
      "UPDATE workspace_completion_policy_rules SET enabled = FALSE",
      `CREATE OR REPLACE FUNCTION samurai_guard_completion_policy_rule_approval() RETURNS TRIGGER
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF NOT EXISTS(
          SELECT 1 FROM workspace_completion_policy_approvals approval
          WHERE approval.workspace_id = NEW.workspace_id
            AND approval.resource_id = NEW.resource_id
            AND approval.resource_version = NEW.resource_version
            AND approval.principal_account_id = NEW.signed_by
            AND approval.signature = NEW.human_signature
        ) THEN RAISE EXCEPTION 'workspace_completion_policy_approval_required'; END IF;
        RETURN NEW;
      END
      $$`,
      "CREATE TRIGGER workspace_completion_policy_rules_require_approval BEFORE INSERT ON workspace_completion_policy_rules FOR EACH ROW EXECUTE FUNCTION samurai_guard_completion_policy_rule_approval()",
      // The machine record carries only structured proof metadata. It never
      // stores provider response text or credentials, and a confirmed result
      // must match the exact version/hash requested by the Port.
      `CREATE TABLE workspace_completion_attestations (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        activity_id TEXT,
        resource_id TEXT,
        resource_version BIGINT,
        source_ref TEXT NOT NULL CHECK (btrim(source_ref) <> ''),
        source_version TEXT NOT NULL CHECK (btrim(source_version) <> ''),
        expected_content_hash TEXT NOT NULL CHECK (expected_content_hash ~ '^[0-9a-f]{64}$'),
        observed_content_hash TEXT CHECK (observed_content_hash ~ '^[0-9a-f]{64}$'),
        outcome TEXT NOT NULL CHECK (outcome IN ('confirmed', 'failed', 'not_run')),
        attestor_id TEXT NOT NULL CHECK (btrim(attestor_id) <> ''),
        failure_reasons JSONB NOT NULL DEFAULT '[]'::JSONB,
        attested_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, activity_id) REFERENCES workspace_completion_activities(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, resource_id, resource_version) REFERENCES workspace_completion_resource_versions(workspace_id, resource_id, version) ON DELETE RESTRICT,
        CHECK ((activity_id IS NOT NULL) OR (resource_id IS NOT NULL AND resource_version IS NOT NULL)),
        CHECK ((resource_id IS NULL) = (resource_version IS NULL)),
        CHECK (jsonb_typeof(failure_reasons) = 'array'),
        CHECK (outcome <> 'confirmed' OR observed_content_hash = expected_content_hash)
      )`,
      "CREATE INDEX workspace_completion_attestations_target_index ON workspace_completion_attestations(workspace_id, resource_id, resource_version, attested_at DESC)",
      "ALTER TABLE workspace_completion_attestations ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_completion_attestations FORCE ROW LEVEL SECURITY",
      `CREATE POLICY workspace_completion_attestations_read ON workspace_completion_attestations FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND (
          (resource_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM workspace_completion_resources resource
            WHERE resource.workspace_id = workspace_completion_attestations.workspace_id AND resource.id = workspace_completion_attestations.resource_id
              AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest'))
                OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read')))
          ))
          OR (activity_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM workspace_completion_activities activity
            WHERE activity.workspace_id = workspace_completion_attestations.workspace_id AND activity.id = workspace_completion_attestations.activity_id
              AND samurai_can_room(activity.workspace_id, activity.room_id, 'read')
          ))
        )
      )`,
      `CREATE POLICY workspace_completion_attestations_write ON workspace_completion_attestations FOR INSERT WITH CHECK (
        workspace_id = samurai_current_workspace_id()
          AND current_setting('samurai.completion_attestation_apply', true) = 'on'
          AND samurai_workspace_is_writable(workspace_id)
      )`,
      "ALTER TABLE workspace_completion_evidence ADD COLUMN attestation_id TEXT",
      `DO $$
      DECLARE constraint_name TEXT;
      BEGIN
        FOR constraint_name IN
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'workspace_completion_evidence'::regclass
            AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%machine_attestation%'
        LOOP EXECUTE format('ALTER TABLE workspace_completion_evidence DROP CONSTRAINT %I', constraint_name); END LOOP;
      END
      $$`,
      "UPDATE workspace_completion_evidence SET kind = 'unverified_claim', summary = '[unverified machine claim] ' || summary WHERE kind = 'machine_attestation'",
      "ALTER TABLE workspace_completion_evidence ADD CONSTRAINT workspace_completion_evidence_kind_hardening CHECK (kind IN ('activity', 'human_edit', 'explicit_remember', 'use_outcome', 'machine_attestation', 'physical_file_import', 'unverified_claim'))",
      "ALTER TABLE workspace_completion_evidence ADD CONSTRAINT workspace_completion_evidence_attestation_fkey FOREIGN KEY (workspace_id, attestation_id) REFERENCES workspace_completion_attestations(workspace_id, id) ON DELETE RESTRICT",
      "ALTER TABLE workspace_completion_evidence ADD CONSTRAINT workspace_completion_evidence_attestation_shape CHECK ((kind = 'machine_attestation') = (attestation_id IS NOT NULL))",
      `CREATE OR REPLACE FUNCTION samurai_guard_completion_machine_attestation() RETURNS TRIGGER
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF NEW.kind = 'machine_attestation' THEN
          IF current_setting('samurai.completion_attestation_apply', true) IS DISTINCT FROM 'on'
            OR NOT EXISTS(
              SELECT 1 FROM workspace_completion_attestations attestation
              WHERE attestation.workspace_id = NEW.workspace_id AND attestation.id = NEW.attestation_id
                AND attestation.resource_id = NEW.resource_id AND attestation.resource_version = NEW.resource_version
                AND attestation.outcome = 'confirmed'
            ) THEN RAISE EXCEPTION 'workspace_completion_machine_attestation_required'; END IF;
        END IF;
        RETURN NEW;
      END
      $$`,
      "CREATE TRIGGER workspace_completion_evidence_machine_attestation_guard BEFORE INSERT OR UPDATE ON workspace_completion_evidence FOR EACH ROW EXECUTE FUNCTION samurai_guard_completion_machine_attestation()",
      `CREATE OR REPLACE FUNCTION samurai_guard_completion_machine_verified() RETURNS TRIGGER
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF NEW.creation_source = 'machine_verified'
          AND current_setting('samurai.completion_attestation_apply', true) IS DISTINCT FROM 'on' THEN
          RAISE EXCEPTION 'workspace_completion_machine_verified_attestation_required';
        END IF;
        RETURN NEW;
      END
      $$`,
      "CREATE TRIGGER workspace_completion_resources_machine_verified_guard BEFORE INSERT OR UPDATE ON workspace_completion_resources FOR EACH ROW EXECUTE FUNCTION samurai_guard_completion_machine_verified()"
    ]
  },
  {
    // Follow-up hardening keeps the migration capability narrow: a Run ID is
    // insufficient on its own, and only the two internal backfill/rollback
    // operations can write Completion tables while the Workspace is read-only.
    version: 37,
    name: "workspace_server_completion_migration_run_write_boundary",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_completion_migration_write_allowed(target_workspace_id TEXT)
      RETURNS BOOLEAN
      LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT current_setting('samurai.completion_migration_operation', true) IN ('completion_backfill', 'completion_rollback')
          AND EXISTS(
            SELECT 1 FROM workspace_completion_migration_runs run
            WHERE run.workspace_id = target_workspace_id
              AND run.id = samurai_context_value('samurai.completion_migration_run_id')
              AND run.owner_account_id = samurai_current_account_id()
              AND run.state IN ('preparing', 'backfilling', 'verified', 'rolling_back')
          )
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_begin_completion_migration_run(
        target_workspace_id TEXT, target_run_id TEXT, target_operation_id TEXT
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE current_state TEXT; DECLARE existing_state TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR current_setting('samurai.caller_kind', true) IS DISTINCT FROM 'human'
          OR current_setting('samurai.caller_principal_id', true) IS DISTINCT FROM samurai_current_account_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_completion_migration_owner_human_required';
        END IF;
        SELECT state INTO existing_state FROM workspace_completion_migration_runs
        WHERE workspace_id = target_workspace_id AND id = target_run_id FOR UPDATE;
        IF FOUND THEN
          IF existing_state IN ('switched', 'rolled_back') THEN RETURN existing_state; END IF;
          IF existing_state = 'failed' THEN
            UPDATE workspace_completion_migration_runs
            SET state = 'preparing', error_code = NULL, completed_at = NULL, updated_at = NOW()
            WHERE workspace_id = target_workspace_id AND id = target_run_id;
            existing_state := 'preparing';
          END IF;
          UPDATE workspaces SET state = 'read_only', version = version + 1, updated_at = NOW()
          WHERE id = target_workspace_id AND state = 'active';
          RETURN existing_state;
        END IF;
        SELECT state INTO current_state FROM workspaces WHERE id = target_workspace_id FOR UPDATE;
        IF current_state <> 'active' THEN RAISE EXCEPTION 'workspace_completion_migration_workspace_not_active'; END IF;
        IF EXISTS(SELECT 1 FROM workspace_completion_migration_runs WHERE workspace_id = target_workspace_id
          AND state IN ('preparing', 'backfilling', 'verified', 'rolling_back')) THEN
          RAISE EXCEPTION 'workspace_completion_migration_already_running';
        END IF;
        INSERT INTO workspace_completion_migration_runs(workspace_id, id, operation_id, owner_account_id, state)
        VALUES (target_workspace_id, target_run_id, target_operation_id, samurai_current_account_id(), 'preparing');
        UPDATE workspaces SET state = 'read_only', version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
        RETURN 'preparing';
      END
      $$`,
      "DROP POLICY workspace_completion_configurations_write ON workspace_completion_configurations",
      `CREATE POLICY workspace_completion_configurations_write ON workspace_completion_configurations FOR ALL USING (
        workspace_id = samurai_current_workspace_id() AND ((scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin')) OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'manage')))
      ) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR samurai_completion_migration_write_allowed(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND ((scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin')) OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'manage'))))))`,
      "DROP POLICY workspace_completion_activities_write ON workspace_completion_activities",
      `CREATE POLICY workspace_completion_activities_write ON workspace_completion_activities FOR ALL USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'execute')) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR samurai_completion_migration_write_allowed(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND principal_account_id = samurai_current_account_id() AND samurai_can_room(workspace_id, room_id, 'execute'))))`,
      "DROP POLICY workspace_completion_episodes_access ON workspace_completion_episodes",
      `CREATE POLICY workspace_completion_episodes_access ON workspace_completion_episodes FOR ALL USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR samurai_completion_migration_write_allowed(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND samurai_can_room(workspace_id, room_id, 'execute'))))`,
      "DROP POLICY workspace_completion_episode_activities_access ON workspace_completion_episode_activities",
      `CREATE POLICY workspace_completion_episode_activities_access ON workspace_completion_episode_activities FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_episodes episode WHERE episode.workspace_id = workspace_completion_episode_activities.workspace_id AND episode.id = workspace_completion_episode_activities.episode_id AND samurai_can_room(episode.workspace_id, episode.room_id, 'read'))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR samurai_completion_migration_write_allowed(workspace_id) OR EXISTS (SELECT 1 FROM workspace_completion_episodes episode WHERE episode.workspace_id = workspace_completion_episode_activities.workspace_id AND episode.id = workspace_completion_episode_activities.episode_id AND samurai_can_room(episode.workspace_id, episode.room_id, 'execute'))))`,
      "DROP POLICY workspace_completion_resources_access ON workspace_completion_resources",
      `CREATE POLICY workspace_completion_resources_access ON workspace_completion_resources FOR ALL USING (workspace_id = samurai_current_workspace_id() AND ((scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'guest')) OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read')))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR samurai_completion_migration_write_allowed(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND ((scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin')) OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'edit'))))))`,
      "DROP POLICY workspace_completion_versions_access ON workspace_completion_resource_versions",
      `CREATE POLICY workspace_completion_versions_access ON workspace_completion_resource_versions FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_resources resource WHERE resource.workspace_id = workspace_completion_resource_versions.workspace_id AND resource.id = workspace_completion_resource_versions.resource_id AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest')) OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read'))))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR samurai_completion_migration_write_allowed(workspace_id) OR EXISTS (SELECT 1 FROM workspace_completion_resources resource WHERE resource.workspace_id = workspace_completion_resource_versions.workspace_id AND resource.id = workspace_completion_resource_versions.resource_id AND samurai_workspace_is_writable(resource.workspace_id) AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'admin')) OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'edit'))))))`,
      "DROP POLICY workspace_completion_evidence_access ON workspace_completion_evidence",
      `CREATE POLICY workspace_completion_evidence_access ON workspace_completion_evidence FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_resources resource WHERE resource.workspace_id = workspace_completion_evidence.workspace_id AND resource.id = workspace_completion_evidence.resource_id AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest')) OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read'))))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR samurai_completion_migration_write_allowed(workspace_id) OR EXISTS (SELECT 1 FROM workspace_completion_resources resource WHERE resource.workspace_id = workspace_completion_evidence.workspace_id AND resource.id = workspace_completion_evidence.resource_id AND samurai_workspace_is_writable(resource.workspace_id) AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'admin')) OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'edit'))))))`,
      "DROP POLICY workspace_completion_links_access ON workspace_completion_resource_links",
      `CREATE POLICY workspace_completion_links_access ON workspace_completion_resource_links FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_resources source JOIN workspace_completion_resources target ON target.workspace_id = source.workspace_id AND target.id = workspace_completion_resource_links.to_resource_id WHERE source.workspace_id = workspace_completion_resource_links.workspace_id AND source.id = workspace_completion_resource_links.from_resource_id AND ((source.scope_kind = 'workspace' AND samurai_can_workspace(source.workspace_id, 'guest')) OR (source.scope_kind = 'room' AND source.room_id IS NOT NULL AND samurai_can_room(source.workspace_id, source.room_id, 'read'))) AND ((target.scope_kind = 'workspace' AND samurai_can_workspace(target.workspace_id, 'guest')) OR (target.scope_kind = 'room' AND target.room_id IS NOT NULL AND samurai_can_room(target.workspace_id, target.room_id, 'read'))))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_completion_migration_write_allowed(workspace_id) OR samurai_workspace_is_writable(workspace_id)))`,
      "DROP POLICY workspace_completion_policy_requests_access ON workspace_completion_policy_change_requests",
      `CREATE POLICY workspace_completion_policy_requests_access ON workspace_completion_policy_change_requests FOR ALL USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR samurai_completion_migration_write_allowed(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND samurai_can_room(workspace_id, room_id, 'execute'))))`,
      "DROP POLICY workspace_completion_uses_access ON workspace_completion_uses",
      `CREATE POLICY workspace_completion_uses_access ON workspace_completion_uses FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_resources resource WHERE resource.workspace_id = workspace_completion_uses.workspace_id AND resource.id = workspace_completion_uses.resource_id AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest')) OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read'))))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_completion_migration_write_allowed(workspace_id) OR samurai_workspace_is_writable(workspace_id)))`,
      "DROP POLICY workspace_completion_jobs_access ON workspace_completion_jobs",
      `CREATE POLICY workspace_completion_jobs_access ON workspace_completion_jobs FOR ALL USING (workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR samurai_completion_migration_write_allowed(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND samurai_can_room(workspace_id, room_id, 'execute'))))`,
      "DROP POLICY workspace_completion_attempts_access ON workspace_completion_job_attempts",
      `CREATE POLICY workspace_completion_attempts_access ON workspace_completion_job_attempts FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_jobs job WHERE job.workspace_id = workspace_completion_job_attempts.workspace_id AND job.id = workspace_completion_job_attempts.job_id AND samurai_can_room(job.workspace_id, job.room_id, 'read'))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR samurai_completion_migration_write_allowed(workspace_id) OR EXISTS (SELECT 1 FROM workspace_completion_jobs job WHERE job.workspace_id = workspace_completion_job_attempts.workspace_id AND job.id = workspace_completion_job_attempts.job_id AND samurai_workspace_is_writable(job.workspace_id) AND samurai_can_room(job.workspace_id, job.room_id, 'execute'))))`,
      "DROP POLICY workspace_completion_search_access ON workspace_completion_search_projection",
      `CREATE POLICY workspace_completion_search_access ON workspace_completion_search_projection FOR ALL USING (workspace_id = samurai_current_workspace_id() AND EXISTS (SELECT 1 FROM workspace_completion_resources resource WHERE resource.workspace_id = workspace_completion_search_projection.workspace_id AND resource.id = workspace_completion_search_projection.resource_id AND ((resource.scope_kind = 'workspace' AND samurai_can_workspace(resource.workspace_id, 'guest')) OR (resource.scope_kind = 'room' AND resource.room_id IS NOT NULL AND samurai_can_room(resource.workspace_id, resource.room_id, 'read'))))) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_completion_migration_write_allowed(workspace_id) OR samurai_workspace_is_writable(workspace_id)))`,
      "DROP POLICY workspace_completion_migration_receipts_access ON workspace_completion_migration_receipts",
      `CREATE POLICY workspace_completion_migration_receipts_access ON workspace_completion_migration_receipts FOR ALL USING (workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'owner')) WITH CHECK (workspace_id = samurai_current_workspace_id() AND (samurai_is_import_session(workspace_id) OR samurai_completion_migration_write_allowed(workspace_id) OR (samurai_workspace_is_writable(workspace_id) AND samurai_can_workspace(workspace_id, 'owner'))))`,
      "DROP POLICY workspace_completion_policy_approvals_insert ON workspace_completion_policy_approvals",
      `CREATE POLICY workspace_completion_policy_approvals_insert ON workspace_completion_policy_approvals FOR INSERT WITH CHECK (
        workspace_id = samurai_current_workspace_id() AND (
          samurai_is_import_session(workspace_id) OR (
            current_setting('samurai.caller_kind', true) = 'human'
            AND current_setting('samurai.caller_principal_id', true) = samurai_current_account_id()
            AND principal_account_id = samurai_current_account_id()
            AND operation_id = current_setting('samurai.caller_operation_id', true)
            AND request_id = current_setting('samurai.caller_request_id', true)
            AND samurai_workspace_is_writable(workspace_id)
          )
        )
      )`,
      "DROP POLICY workspace_completion_attestations_write ON workspace_completion_attestations",
      `CREATE POLICY workspace_completion_attestations_write ON workspace_completion_attestations FOR INSERT WITH CHECK (
        workspace_id = samurai_current_workspace_id() AND (
          samurai_is_import_session(workspace_id) OR (
            current_setting('samurai.completion_attestation_apply', true) = 'on'
            AND samurai_workspace_is_writable(workspace_id)
          )
        )
      )`,
      `CREATE OR REPLACE FUNCTION samurai_guard_completion_machine_attestation() RETURNS TRIGGER
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF NEW.kind = 'machine_attestation' AND NOT samurai_is_import_session(NEW.workspace_id) THEN
          IF current_setting('samurai.completion_attestation_apply', true) IS DISTINCT FROM 'on'
            OR NOT EXISTS(SELECT 1 FROM workspace_completion_attestations attestation
              WHERE attestation.workspace_id = NEW.workspace_id AND attestation.id = NEW.attestation_id
                AND attestation.resource_id = NEW.resource_id AND attestation.resource_version = NEW.resource_version
                AND attestation.outcome = 'confirmed') THEN
            RAISE EXCEPTION 'workspace_completion_machine_attestation_required';
          END IF;
        END IF;
        RETURN NEW;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_guard_completion_machine_verified() RETURNS TRIGGER
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF NEW.creation_source = 'machine_verified'
          AND NOT samurai_is_import_session(NEW.workspace_id)
          AND current_setting('samurai.completion_attestation_apply', true) IS DISTINCT FROM 'on' THEN
          RAISE EXCEPTION 'workspace_completion_machine_verified_attestation_required';
        END IF;
        RETURN NEW;
      END
      $$`,
      "ALTER FUNCTION samurai_rollback_completion_legacy_migration(TEXT, TEXT) RENAME TO samurai_rollback_completion_legacy_migration_v35",
      `CREATE FUNCTION samurai_rollback_completion_legacy_migration(target_workspace_id TEXT, target_integrity_hash TEXT)
      RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE result JSONB;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_completion_migration_write_allowed(target_workspace_id)
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_completion_migration_owner_required';
        END IF;
        -- The v35 routine checks the ordinary writable predicate. This state
        -- change is local to the same Security Definer transaction and is
        -- restored before return; no external request can write in between.
        UPDATE workspaces SET state = 'active' WHERE id = target_workspace_id AND state = 'read_only';
        result := samurai_rollback_completion_legacy_migration_v35(target_workspace_id, target_integrity_hash);
        UPDATE workspaces SET state = 'read_only' WHERE id = target_workspace_id AND state = 'active';
        RETURN result;
      EXCEPTION WHEN OTHERS THEN
        UPDATE workspaces SET state = 'read_only' WHERE id = target_workspace_id AND state = 'active';
        RAISE;
      END
      $$`
    ]
  },
  {
    // v4 records only the outer, verified destination. Embedded base-v3 is
    // portable input, never an independently exported Bundle ledger entry.
    version: 38,
    name: "workspace_server_bundle_v4_final_ledger",
    statements: [
      `DO $$
      DECLARE constraint_name TEXT;
      BEGIN
        FOR constraint_name IN
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'workspace_bundles'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%format_version = 3%'
        LOOP EXECUTE format('ALTER TABLE workspace_bundles DROP CONSTRAINT %I', constraint_name); END LOOP;
      END
      $$`,
      "ALTER TABLE workspace_bundles ADD CONSTRAINT workspace_bundles_format_version_check CHECK (format_version IN (3, 4))",
      `CREATE OR REPLACE FUNCTION samurai_record_workspace_bundle_v4(
        target_workspace_id TEXT,
        target_bundle_id TEXT,
        target_path TEXT,
        target_hash TEXT,
        target_record_counts JSONB
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing workspace_bundles%ROWTYPE;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_workspace_is_writable(target_workspace_id)
          OR NOT samurai_can_workspace(target_workspace_id, 'owner')
          OR target_hash !~ '^[0-9a-f]{64}$'
          OR jsonb_typeof(target_record_counts) <> 'object'
          OR target_path = ''
          OR target_path LIKE '%.staging-%/base-v3%'
        THEN RAISE EXCEPTION 'workspace_bundle_v4_ledger_input_invalid'; END IF;
        SELECT * INTO existing FROM workspace_bundles
        WHERE workspace_id = target_workspace_id AND id = target_bundle_id FOR UPDATE;
        IF FOUND THEN
          IF existing.format_version = 4 AND existing.path = target_path
             AND existing.sha256 = target_hash AND existing.record_counts = target_record_counts THEN RETURN; END IF;
          RAISE EXCEPTION 'workspace_bundle_v4_ledger_conflict';
        END IF;
        INSERT INTO workspace_bundles(workspace_id, id, format_version, path, sha256, record_counts, created_by)
        VALUES (target_workspace_id, target_bundle_id, 4, target_path, target_hash, target_record_counts, samurai_current_account_id());
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_record_workspace_bundle_v4(TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC"
    ]
  },
  {
    // A Run capability is not a general write bypass. Its owner, operation,
    // and current phase must all agree with the transaction-local Context.
    version: 39,
    name: "workspace_server_completion_migration_run_phase_capability",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_completion_migration_write_allowed(target_workspace_id TEXT)
      RETURNS BOOLEAN
      LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT EXISTS(
          SELECT 1 FROM workspace_completion_migration_runs run
          WHERE run.workspace_id = target_workspace_id
            AND run.id = samurai_context_value('samurai.completion_migration_run_id')
            AND run.owner_account_id = samurai_current_account_id()
            AND (
              (current_setting('samurai.completion_migration_operation', true) = 'completion_backfill'
                AND run.state IN ('preparing', 'backfilling', 'verified'))
              OR (current_setting('samurai.completion_migration_operation', true) = 'completion_rollback'
                AND run.state = 'rolling_back')
            )
        )
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_begin_completion_migration_run(
        target_workspace_id TEXT, target_run_id TEXT, target_operation_id TEXT
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE current_state TEXT; DECLARE existing_state TEXT;
      DECLARE existing_operation_id TEXT; DECLARE existing_owner_account_id TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR current_setting('samurai.caller_kind', true) IS DISTINCT FROM 'human'
          OR current_setting('samurai.caller_principal_id', true) IS DISTINCT FROM samurai_current_account_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_completion_migration_owner_human_required';
        END IF;
        SELECT state, operation_id, owner_account_id
          INTO existing_state, existing_operation_id, existing_owner_account_id
        FROM workspace_completion_migration_runs
        WHERE workspace_id = target_workspace_id AND id = target_run_id FOR UPDATE;
        IF FOUND THEN
          IF existing_operation_id IS DISTINCT FROM target_operation_id
             OR existing_owner_account_id IS DISTINCT FROM samurai_current_account_id() THEN
            RAISE EXCEPTION 'workspace_completion_migration_run_capability_invalid';
          END IF;
          IF existing_state IN ('switched', 'rolled_back') THEN RETURN existing_state; END IF;
          IF existing_state = 'failed' THEN
            UPDATE workspace_completion_migration_runs
            SET state = 'preparing', error_code = NULL, completed_at = NULL, updated_at = NOW()
            WHERE workspace_id = target_workspace_id AND id = target_run_id;
            existing_state := 'preparing';
          END IF;
          UPDATE workspaces SET state = 'read_only', version = version + 1, updated_at = NOW()
          WHERE id = target_workspace_id AND state = 'active';
          RETURN existing_state;
        END IF;
        SELECT state INTO current_state FROM workspaces WHERE id = target_workspace_id FOR UPDATE;
        IF current_state <> 'active' THEN RAISE EXCEPTION 'workspace_completion_migration_workspace_not_active'; END IF;
        IF EXISTS(SELECT 1 FROM workspace_completion_migration_runs WHERE workspace_id = target_workspace_id
          AND state IN ('preparing', 'backfilling', 'verified', 'rolling_back')) THEN
          RAISE EXCEPTION 'workspace_completion_migration_already_running';
        END IF;
        INSERT INTO workspace_completion_migration_runs(workspace_id, id, operation_id, owner_account_id, state)
        VALUES (target_workspace_id, target_run_id, target_operation_id, samurai_current_account_id(), 'preparing');
        UPDATE workspaces SET state = 'read_only', version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
        RETURN 'preparing';
      END
      $$`,
      "REVOKE INSERT, UPDATE, DELETE ON TABLE workspace_completion_migration_runs FROM PUBLIC",
      "REVOKE UPDATE, DELETE ON TABLE workspace_completion_policy_approvals, workspace_completion_attestations FROM PUBLIC"
    ]
  },
  {
    // Older v4 code could call the public v3 exporter for its embedded
    // snapshot. Repair only a row whose base-v3 hash proves the relationship
    // to an already verified outer v4 manifest; never guess from a path.
    version: 40,
    name: "workspace_server_bundle_v4_legacy_staging_ledger_repair",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_repair_workspace_bundle_v4_legacy_ledger(
        target_workspace_id TEXT,
        target_legacy_bundle_id TEXT,
        target_path TEXT,
        target_hash TEXT,
        target_record_counts JSONB,
        expected_base_v3_hash TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE existing workspace_bundles%ROWTYPE;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_workspace_is_writable(target_workspace_id)
          OR NOT samurai_can_workspace(target_workspace_id, 'owner')
          OR btrim(target_legacy_bundle_id) = ''
          OR target_hash !~ '^[0-9a-f]{64}$'
          OR expected_base_v3_hash !~ '^[0-9a-f]{64}$'
          OR jsonb_typeof(target_record_counts) <> 'object'
          OR target_path = ''
          OR target_path LIKE '%.staging-%/base-v3%'
        THEN RAISE EXCEPTION 'workspace_bundle_v4_legacy_ledger_input_invalid'; END IF;
        SELECT * INTO existing FROM workspace_bundles
        WHERE workspace_id = target_workspace_id AND id = target_legacy_bundle_id FOR UPDATE;
        IF NOT FOUND
          OR existing.format_version <> 3
          OR existing.path NOT LIKE '%.staging-%/base-v3'
          OR existing.sha256 IS DISTINCT FROM expected_base_v3_hash THEN
          RAISE EXCEPTION 'workspace_bundle_v4_legacy_ledger_not_proven';
        END IF;
        UPDATE workspace_bundles
        SET format_version = 4, path = target_path, sha256 = target_hash, record_counts = target_record_counts
        WHERE workspace_id = target_workspace_id AND id = target_legacy_bundle_id;
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_repair_workspace_bundle_v4_legacy_ledger(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC"
    ]
  },
  {
    // Starting (or resuming) a dedicated Completion migration is itself an
    // auditable state transition.  Keep the Run, read-only switch, and Audit
    // row in the same Security Definer transaction.
    version: 41,
    name: "workspace_server_completion_migration_run_start_audit",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_begin_completion_migration_run(
        target_workspace_id TEXT, target_run_id TEXT, target_operation_id TEXT
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE current_state TEXT; DECLARE existing_state TEXT;
      DECLARE existing_operation_id TEXT; DECLARE existing_owner_account_id TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR current_setting('samurai.caller_kind', true) IS DISTINCT FROM 'human'
          OR current_setting('samurai.caller_principal_id', true) IS DISTINCT FROM samurai_current_account_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_completion_migration_owner_human_required';
        END IF;
        SELECT state, operation_id, owner_account_id
          INTO existing_state, existing_operation_id, existing_owner_account_id
        FROM workspace_completion_migration_runs
        WHERE workspace_id = target_workspace_id AND id = target_run_id FOR UPDATE;
        IF FOUND THEN
          IF existing_operation_id IS DISTINCT FROM target_operation_id
             OR existing_owner_account_id IS DISTINCT FROM samurai_current_account_id() THEN
            RAISE EXCEPTION 'workspace_completion_migration_run_capability_invalid';
          END IF;
          IF existing_state IN ('switched', 'rolled_back') THEN RETURN existing_state; END IF;
          IF existing_state = 'failed' THEN
            UPDATE workspace_completion_migration_runs
            SET state = 'preparing', error_code = NULL, completed_at = NULL, updated_at = NOW()
            WHERE workspace_id = target_workspace_id AND id = target_run_id;
            existing_state := 'preparing';
          END IF;
          UPDATE workspaces SET state = 'read_only', version = version + 1, updated_at = NOW()
          WHERE id = target_workspace_id AND state = 'active';
          PERFORM samurai_append_workspace_audit(
            target_workspace_id, NULL, 'workspace.completion.migration.begin', 'completed',
            target_operation_id, 'completion_migration_run', target_run_id, NULL, NULL,
            jsonb_build_object('state', existing_state, 'resumed', TRUE)
          );
          RETURN existing_state;
        END IF;
        SELECT state INTO current_state FROM workspaces WHERE id = target_workspace_id FOR UPDATE;
        IF current_state <> 'active' THEN RAISE EXCEPTION 'workspace_completion_migration_workspace_not_active'; END IF;
        IF EXISTS(SELECT 1 FROM workspace_completion_migration_runs WHERE workspace_id = target_workspace_id
          AND state IN ('preparing', 'backfilling', 'verified', 'rolling_back')) THEN
          RAISE EXCEPTION 'workspace_completion_migration_already_running';
        END IF;
        INSERT INTO workspace_completion_migration_runs(workspace_id, id, operation_id, owner_account_id, state)
        VALUES (target_workspace_id, target_run_id, target_operation_id, samurai_current_account_id(), 'preparing');
        UPDATE workspaces SET state = 'read_only', version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
        PERFORM samurai_append_workspace_audit(
          target_workspace_id, NULL, 'workspace.completion.migration.begin', 'completed',
          target_operation_id, 'completion_migration_run', target_run_id, NULL, NULL,
          jsonb_build_object('state', 'preparing', 'resumed', FALSE)
        );
        RETURN 'preparing';
      END
      $$`
    ]
  },
  {
    version: 42,
    name: "workspace_server_agent_room_permissions_and_connection_descriptors",
    statements: [
      `CREATE TABLE workspace_agents (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        display_name TEXT NOT NULL CHECK (btrim(display_name) <> ''),
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')) DEFAULT 'active',
        version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id)
      )`,
      `CREATE TABLE workspace_agent_room_permissions (
        workspace_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        can_view BOOLEAN NOT NULL DEFAULT FALSE,
        can_edit BOOLEAN NOT NULL DEFAULT FALSE,
        can_execute BOOLEAN NOT NULL DEFAULT FALSE,
        version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, room_id, agent_id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, agent_id) REFERENCES workspace_agents(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_connection_descriptors (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        agent_id TEXT,
        principal_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        connector_id TEXT NOT NULL CHECK (btrim(connector_id) <> ''),
        app_id TEXT NOT NULL CHECK (btrim(app_id) <> ''),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')) DEFAULT 'active',
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        allowed_room_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        room_limit INTEGER NOT NULL DEFAULT 1 CHECK (room_limit > 0 AND room_limit <= 100),
        ingress_classes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, agent_id) REFERENCES workspace_agents(workspace_id, id) ON DELETE RESTRICT,
        CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
        CHECK (cardinality(allowed_room_ids) <= room_limit)
      )`,
      "CREATE INDEX workspace_agents_status_index ON workspace_agents(workspace_id, status, updated_at DESC)",
      "CREATE INDEX workspace_agent_room_permissions_room_index ON workspace_agent_room_permissions(workspace_id, room_id, updated_at DESC)",
      "CREATE INDEX workspace_connection_descriptors_lookup_index ON workspace_connection_descriptors(workspace_id, status, expires_at)",
      "ALTER TABLE workspace_agents ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_agent_room_permissions ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_connection_descriptors ENABLE ROW LEVEL SECURITY",
      `CREATE POLICY workspace_agents_read ON workspace_agents FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'guest')
      )`,
      `CREATE POLICY workspace_agents_write_denied ON workspace_agents FOR ALL
       USING (false) WITH CHECK (false)`,
      `CREATE POLICY workspace_agent_room_permissions_read ON workspace_agent_room_permissions FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')
      )`,
      `CREATE POLICY workspace_agent_room_permissions_write_denied ON workspace_agent_room_permissions FOR ALL
       USING (false) WITH CHECK (false)`,
      `CREATE POLICY workspace_connection_descriptors_read ON workspace_connection_descriptors FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'admin')
      )`,
      `CREATE POLICY workspace_connection_descriptors_write_denied ON workspace_connection_descriptors FOR ALL
       USING (false) WITH CHECK (false)`,
      `CREATE OR REPLACE FUNCTION samurai_register_workspace_agent(
        target_workspace_id TEXT,
        target_agent_id TEXT,
        target_display_name TEXT,
        target_description TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
          RAISE EXCEPTION 'workspace_admin_permission_required';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF btrim(target_agent_id) = '' OR btrim(target_display_name) = '' THEN
          RAISE EXCEPTION 'workspace_agent_input_invalid';
        END IF;
        INSERT INTO workspace_agents(workspace_id, id, display_name, description, created_by)
        VALUES (target_workspace_id, target_agent_id, btrim(target_display_name), btrim(COALESCE(target_description, '')), samurai_current_account_id());
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_can_agent_room(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_agent_id TEXT,
        action_name TEXT
      ) RETURNS BOOLEAN
      LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT COALESCE(CASE action_name
          WHEN 'read' THEN permission.can_view
          WHEN 'edit' THEN permission.can_edit
          WHEN 'execute' THEN permission.can_execute
          ELSE FALSE
        END, FALSE)
        FROM workspace_agent_room_permissions AS permission
        JOIN workspace_agents AS agent
          ON agent.workspace_id = permission.workspace_id AND agent.id = permission.agent_id AND agent.status = 'active'
        WHERE target_workspace_id = samurai_current_workspace_id()
          AND permission.workspace_id = target_workspace_id
          AND permission.room_id = target_room_id
          AND permission.agent_id = target_agent_id
        LIMIT 1
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_set_workspace_agent_room_permission(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_agent_id TEXT,
        target_can_view BOOLEAN,
        target_can_edit BOOLEAN,
        target_can_execute BOOLEAN,
        target_expected_version BIGINT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE current_version BIGINT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_room(target_workspace_id, target_room_id, 'manage') THEN
          RAISE EXCEPTION 'room_permission_denied';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF target_can_edit AND NOT target_can_view OR target_can_execute AND NOT target_can_view THEN
          RAISE EXCEPTION 'workspace_agent_room_permission_invalid';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM workspace_agents
          WHERE workspace_id = target_workspace_id AND id = target_agent_id AND status = 'active'
        ) THEN RAISE EXCEPTION 'workspace_agent_not_active'; END IF;
        SELECT version INTO current_version
        FROM workspace_agent_room_permissions
        WHERE workspace_id = target_workspace_id AND room_id = target_room_id AND agent_id = target_agent_id
        FOR UPDATE;
        IF FOUND AND current_version <> target_expected_version THEN
          RAISE EXCEPTION 'workspace_agent_room_permission_version_conflict';
        END IF;
        IF NOT FOUND AND target_expected_version <> 0 THEN
          RAISE EXCEPTION 'workspace_agent_room_permission_version_conflict';
        END IF;
        INSERT INTO workspace_agent_room_permissions(
          workspace_id, room_id, agent_id, can_view, can_edit, can_execute, version, created_by
        ) VALUES (
          target_workspace_id, target_room_id, target_agent_id, target_can_view, target_can_edit, target_can_execute,
          CASE WHEN current_version IS NULL THEN 1 ELSE current_version + 1 END, samurai_current_account_id()
        )
        ON CONFLICT (workspace_id, room_id, agent_id) DO UPDATE SET
          can_view = EXCLUDED.can_view,
          can_edit = EXCLUDED.can_edit,
          can_execute = EXCLUDED.can_execute,
          version = workspace_agent_room_permissions.version + 1,
          updated_at = NOW();
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_upsert_workspace_connection_descriptor(
        target_workspace_id TEXT,
        target_connection_id TEXT,
        target_agent_id TEXT,
        target_principal_account_id TEXT,
        target_connector_id TEXT,
        target_app_id TEXT,
        target_status TEXT,
        target_expires_at TIMESTAMPTZ,
        target_revoked_at TIMESTAMPTZ,
        target_allowed_room_ids TEXT[],
        target_room_limit INTEGER,
        target_ingress_classes TEXT[],
        target_expected_version BIGINT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE current_version BIGINT;
      DECLARE bound_room_id TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
          RAISE EXCEPTION 'workspace_admin_permission_required';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF target_status NOT IN ('active', 'revoked', 'expired')
          OR btrim(target_connection_id) = ''
          OR btrim(target_connector_id) = ''
          OR btrim(target_app_id) = ''
          OR target_room_limit < 1 OR target_room_limit > 100
          OR COALESCE(cardinality(target_allowed_room_ids), 0) > target_room_limit
          OR (target_status = 'revoked') <> (target_revoked_at IS NOT NULL)
          OR (target_status = 'active' AND target_expires_at <= NOW())
          OR (target_status = 'expired' AND target_expires_at > NOW()) THEN
          RAISE EXCEPTION 'workspace_connection_descriptor_invalid';
        END IF;
        IF target_principal_account_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM workspace_members
          WHERE workspace_id = target_workspace_id AND account_id = target_principal_account_id AND state = 'active'
        ) THEN RAISE EXCEPTION 'workspace_connection_principal_not_active'; END IF;
        IF target_agent_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM workspace_agents
          WHERE workspace_id = target_workspace_id AND id = target_agent_id AND status = 'active'
        ) THEN RAISE EXCEPTION 'workspace_connection_agent_not_active'; END IF;
        IF EXISTS (
          SELECT 1 FROM unnest(COALESCE(target_allowed_room_ids, ARRAY[]::TEXT[])) AS binding(room_id)
          WHERE binding.room_id IS NULL OR btrim(binding.room_id) = ''
        ) THEN RAISE EXCEPTION 'workspace_connection_room_binding_invalid'; END IF;
        FOREACH bound_room_id IN ARRAY COALESCE(target_allowed_room_ids, ARRAY[]::TEXT[]) LOOP
          IF NOT samurai_can_room(target_workspace_id, bound_room_id, 'manage') THEN
            RAISE EXCEPTION 'workspace_connection_room_binding_invalid';
          END IF;
        END LOOP;
        SELECT version INTO current_version
        FROM workspace_connection_descriptors
        WHERE workspace_id = target_workspace_id AND id = target_connection_id
        FOR UPDATE;
        IF FOUND AND current_version <> target_expected_version THEN
          RAISE EXCEPTION 'workspace_connection_descriptor_version_conflict';
        END IF;
        IF NOT FOUND AND target_expected_version <> 0 THEN
          RAISE EXCEPTION 'workspace_connection_descriptor_version_conflict';
        END IF;
        INSERT INTO workspace_connection_descriptors(
          workspace_id, id, agent_id, principal_account_id, connector_id, app_id, status, expires_at,
          revoked_at, allowed_room_ids, room_limit, ingress_classes, version, created_by
        ) VALUES (
          target_workspace_id, target_connection_id, NULLIF(btrim(target_agent_id), ''), target_principal_account_id,
          btrim(target_connector_id), btrim(target_app_id), target_status, target_expires_at, target_revoked_at,
          COALESCE(target_allowed_room_ids, ARRAY[]::TEXT[]), target_room_limit, COALESCE(target_ingress_classes, ARRAY[]::TEXT[]),
          CASE WHEN current_version IS NULL THEN 1 ELSE current_version + 1 END, samurai_current_account_id()
        )
        ON CONFLICT (workspace_id, id) DO UPDATE SET
          agent_id = EXCLUDED.agent_id,
          principal_account_id = EXCLUDED.principal_account_id,
          connector_id = EXCLUDED.connector_id,
          app_id = EXCLUDED.app_id,
          status = EXCLUDED.status,
          expires_at = EXCLUDED.expires_at,
          revoked_at = EXCLUDED.revoked_at,
          allowed_room_ids = EXCLUDED.allowed_room_ids,
          room_limit = EXCLUDED.room_limit,
          ingress_classes = EXCLUDED.ingress_classes,
          version = workspace_connection_descriptors.version + 1,
          updated_at = NOW();
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_register_workspace_agent(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_set_workspace_agent_room_permission(TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, BIGINT) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_upsert_workspace_connection_descriptor(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], INTEGER, TEXT[], BIGINT) FROM PUBLIC"
    ]
  },
  {
    version: 43,
    name: "workspace_server_runtime_execution_and_activity_tables",
    statements: [
      `CREATE TABLE workspace_runtime_sessions (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        room_id TEXT,
        title TEXT NOT NULL,
        ui_locale TEXT NOT NULL,
        output_locale TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, session_key),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_runtime_messages (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
        content TEXT NOT NULL,
        input_locale TEXT NOT NULL,
        output_locale TEXT NOT NULL,
        envelope JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, session_id) REFERENCES workspace_runtime_sessions(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_runtime_operations (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        session_id TEXT,
        room_id TEXT,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, session_id) REFERENCES workspace_runtime_sessions(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_runtime_runs (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        session_id TEXT,
        room_id TEXT,
        principal JSONB,
        source JSONB,
        session_ref JSONB,
        agent_id TEXT,
        requested_by_participant_id TEXT,
        input_message_id TEXT,
        output_message_id TEXT,
        backend_id TEXT NOT NULL,
        backend_kind TEXT NOT NULL,
        backend_session_id TEXT,
        status TEXT NOT NULL,
        phase TEXT,
        current_attempt INTEGER,
        request_idempotency_key TEXT,
        request_hash TEXT,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        input_summary TEXT NOT NULL,
        output_summary TEXT,
        error_code TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, session_id) REFERENCES workspace_runtime_sessions(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, input_message_id) REFERENCES workspace_runtime_messages(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, output_message_id) REFERENCES workspace_runtime_messages(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE UNIQUE INDEX workspace_runtime_runs_idempotency_index
       ON workspace_runtime_runs(workspace_id, session_id, request_idempotency_key)
       WHERE request_idempotency_key IS NOT NULL`,
      `CREATE TABLE workspace_runtime_reservations (
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        version BIGINT NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK (status IN ('held', 'released')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, session_id),
        UNIQUE (workspace_id, run_id),
        FOREIGN KEY (workspace_id, session_id) REFERENCES workspace_runtime_sessions(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, run_id) REFERENCES workspace_runtime_runs(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_runtime_events (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        session_id TEXT,
        backend_session_id TEXT,
        event_type TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        attempt_no INTEGER,
        source_event_id TEXT,
        source_sequence INTEGER,
        payload JSONB NOT NULL DEFAULT '{}'::JSONB,
        resource_refs JSONB NOT NULL DEFAULT '[]'::JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, run_id, source_event_id),
        FOREIGN KEY (workspace_id, run_id) REFERENCES workspace_runtime_runs(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_runtime_changes (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        run_id TEXT,
        session_id TEXT,
        room_id TEXT,
        activity_id TEXT,
        domain_operation_id TEXT,
        session_ref JSONB,
        resource_ref JSONB NOT NULL,
        change_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        legacy_operation_id TEXT,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, run_id) REFERENCES workspace_runtime_runs(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, session_id) REFERENCES workspace_runtime_sessions(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_runtime_activities (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        backend_run_id TEXT,
        record JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, room_id, idempotency_key),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, backend_run_id) REFERENCES workspace_runtime_runs(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_runtime_resource_usage (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        activity_id TEXT NOT NULL,
        workspace_job_attempt_id TEXT,
        resource_ref JSONB NOT NULL,
        resource_version TEXT,
        content_hash TEXT,
        usage_scope JSONB NOT NULL,
        stage TEXT NOT NULL,
        domain_operation_id TEXT,
        workspace_change_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, activity_id) REFERENCES workspace_runtime_activities(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, workspace_change_id) REFERENCES workspace_runtime_changes(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_runtime_resources (
        workspace_id TEXT NOT NULL,
        room_id TEXT,
        resource_kind TEXT NOT NULL,
        id TEXT NOT NULL,
        version BIGINT NOT NULL DEFAULT 1,
        state TEXT NOT NULL DEFAULT 'active',
        frontmatter JSONB NOT NULL DEFAULT '{}'::JSONB,
        content TEXT,
        content_hash TEXT,
        file_path TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, resource_kind, id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_runtime_settings (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE RESTRICT,
        settings JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE workspace_runtime_client_events (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        id TEXT NOT NULL,
        target_client_kind TEXT NOT NULL,
        target_client_id TEXT,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::JSONB,
        resource_refs JSONB NOT NULL DEFAULT '[]'::JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        delivered_at TIMESTAMPTZ,
        acked_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        error_code TEXT,
        PRIMARY KEY (workspace_id, id)
      )`,
      "CREATE INDEX workspace_runtime_messages_session_index ON workspace_runtime_messages(workspace_id, session_id, created_at)",
      "CREATE INDEX workspace_runtime_runs_session_index ON workspace_runtime_runs(workspace_id, session_id, started_at DESC)",
      "CREATE INDEX workspace_runtime_events_run_index ON workspace_runtime_events(workspace_id, run_id, sequence)",
      "CREATE INDEX workspace_runtime_changes_session_index ON workspace_runtime_changes(workspace_id, session_id, created_at)",
      "CREATE INDEX workspace_runtime_resources_room_index ON workspace_runtime_resources(workspace_id, room_id, resource_kind, updated_at DESC)",
      ...runtimeRlsStatements()
    ]
  },
  {
    version: 44,
    name: "workspace_server_runtime_automation_jobs_and_runs",
    statements: [
      `CREATE TABLE workspace_runtime_automation_jobs (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled', 'archived')),
        schedule TEXT NOT NULL,
        target_instruction TEXT NOT NULL,
        delivery_target JSONB NOT NULL DEFAULT '{}'::JSONB,
        authority JSONB,
        created_principal_snapshot JSONB,
        source_snapshot JSONB,
        connection_id TEXT,
        session_ref JSONB,
        authorization_state TEXT NOT NULL CHECK (authorization_state IN ('ready', 'rebind_required', 'blocked')),
        authorization_error_code TEXT,
        authorized_at TIMESTAMPTZ,
        blocked_at TIMESTAMPTZ,
        rebound_at TIMESTAMPTZ,
        management_state TEXT NOT NULL CHECK (management_state IN ('allowed', 'manager_stopped')),
        management_operation_id TEXT,
        created_operation_id TEXT,
        rebound_operation_id TEXT,
        next_run_at TIMESTAMPTZ,
        last_run_at TIMESTAMPTZ,
        retry_after_at TIMESTAMPTZ,
        locked_until TIMESTAMPTZ,
        lock_owner_token TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT,
        CHECK ((locked_until IS NULL) = (lock_owner_token IS NULL)),
        CHECK (authorization_state <> 'ready' OR (authority IS NOT NULL AND created_principal_snapshot IS NOT NULL AND source_snapshot IS NOT NULL AND authorized_at IS NOT NULL)),
        CHECK (management_state <> 'manager_stopped' OR status = 'disabled')
      )`,
      `CREATE TABLE workspace_runtime_automation_runs (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        session_ref JSONB,
        backend_run_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'blocked')),
        operation_id TEXT,
        authority JSONB,
        connector_id TEXT,
        app_id TEXT,
        activity_id TEXT,
        error_code TEXT,
        scheduled_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        blocked_at TIMESTAMPTZ,
        error TEXT,
        attempt_no INTEGER NOT NULL DEFAULT 1 CHECK (attempt_no > 0),
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, job_id, scheduled_at),
        FOREIGN KEY (workspace_id, job_id) REFERENCES workspace_runtime_automation_jobs(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      "CREATE INDEX workspace_runtime_automation_jobs_due_index ON workspace_runtime_automation_jobs(workspace_id, status, authorization_state, next_run_at)",
      "CREATE INDEX workspace_runtime_automation_runs_job_index ON workspace_runtime_automation_runs(workspace_id, job_id, started_at DESC)",
      ...runtimeAutomationRlsStatements()
    ]
  },
  {
    version: 45,
    name: "workspace_server_external_integration_runtime_state",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_external_integration_enabled()
      RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT samurai_context_value('samurai.external_integration') = '1'
      $$`,
      `CREATE TABLE workspace_external_integration_records (
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        record_type TEXT NOT NULL CHECK (record_type ~ '^[a-z][a-z0-9_]{0,63}$'),
        id TEXT NOT NULL CHECK (btrim(id) <> ''),
        version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      "CREATE INDEX workspace_external_integration_records_type_index ON workspace_external_integration_records(workspace_id, record_type, updated_at DESC)",
      "CREATE UNIQUE INDEX workspace_external_integration_records_workspace_unique_index ON workspace_external_integration_records(workspace_id, record_type, id) WHERE workspace_id IS NOT NULL",
      "CREATE UNIQUE INDEX workspace_external_integration_records_global_unique_index ON workspace_external_integration_records(record_type, id) WHERE workspace_id IS NULL",
      "ALTER TABLE workspace_external_integration_records ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE workspace_external_integration_records FORCE ROW LEVEL SECURITY",
      `CREATE POLICY workspace_external_integration_records_access ON workspace_external_integration_records FOR ALL
       USING (samurai_external_integration_enabled()
         AND (workspace_id IS NULL OR workspace_id = samurai_current_workspace_id() OR samurai_current_workspace_id() IS NULL))
       WITH CHECK (samurai_external_integration_enabled()
         AND (workspace_id IS NULL OR workspace_id = samurai_current_workspace_id() OR samurai_current_workspace_id() IS NULL))`,
      `ALTER POLICY workspace_connection_descriptors_read ON workspace_connection_descriptors
       USING (
         (workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'admin'))
         OR (workspace_id = samurai_current_workspace_id() AND samurai_external_integration_enabled())
         OR (samurai_external_integration_enabled() AND samurai_current_workspace_id() IS NULL)
       )`,
      `CREATE OR REPLACE FUNCTION samurai_external_connection_descriptor(
        target_workspace_id TEXT,
        target_connector_id TEXT
      ) RETURNS TABLE(
        workspace_id TEXT,
        id TEXT,
        agent_id TEXT,
        principal_account_id TEXT,
        connector_id TEXT,
        app_id TEXT,
        status TEXT,
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        allowed_room_ids TEXT[],
        ingress_classes TEXT[],
        version BIGINT,
        created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ
      )
      LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT descriptor.workspace_id, descriptor.id, descriptor.agent_id, descriptor.principal_account_id,
               descriptor.connector_id, descriptor.app_id, descriptor.status, descriptor.expires_at,
               descriptor.revoked_at, descriptor.allowed_room_ids, descriptor.ingress_classes,
               descriptor.version, descriptor.created_at, descriptor.updated_at
        FROM workspace_connection_descriptors AS descriptor
        WHERE target_workspace_id = samurai_current_workspace_id()
          AND descriptor.workspace_id = target_workspace_id
          AND descriptor.connector_id = target_connector_id
        ORDER BY descriptor.updated_at DESC, descriptor.id
        LIMIT 1
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_external_connection_descriptor(TEXT, TEXT) FROM PUBLIC"
    ]
  },
  {
    version: 46,
    name: "workspace_server_agent_backend_and_episode_key_guards",
    statements: [
      "ALTER TABLE workspace_agents ADD COLUMN backend_id TEXT NOT NULL DEFAULT 'samurai-native'",
      "ALTER TABLE workspace_agents ADD CONSTRAINT workspace_agents_backend_id_nonempty CHECK (btrim(backend_id) <> '')",
      "CREATE INDEX workspace_agents_backend_index ON workspace_agents(workspace_id, backend_id, status)",
      "ALTER TABLE workspace_completion_episodes DROP CONSTRAINT IF EXISTS workspace_completion_episodes_workspace_id_room_id_external_episode_key_key",
      "CREATE UNIQUE INDEX workspace_completion_episodes_external_key_unique ON workspace_completion_episodes(workspace_id, room_id, external_episode_key) WHERE external_episode_key IS NOT NULL",
      `CREATE OR REPLACE FUNCTION samurai_set_workspace_agent_backend(
        target_workspace_id TEXT,
        target_agent_id TEXT,
        target_backend_id TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'admin') THEN
          RAISE EXCEPTION 'workspace_admin_permission_required';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        IF btrim(target_agent_id) = '' OR btrim(target_backend_id) = '' THEN
          RAISE EXCEPTION 'workspace_agent_backend_input_invalid';
        END IF;
        UPDATE workspace_agents
        SET backend_id = btrim(target_backend_id), version = version + 1, updated_at = NOW()
        WHERE workspace_id = target_workspace_id AND id = target_agent_id AND status = 'active';
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_agent_not_active'; END IF;
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_set_workspace_agent_backend(TEXT, TEXT, TEXT) FROM PUBLIC"
    ]
  },
  {
    version: 47,
    name: "workspace_server_runtime_settings_respect_workspace_freeze",
    statements: [
      `ALTER POLICY workspace_runtime_settings_access ON workspace_runtime_settings
       WITH CHECK (
         workspace_id = samurai_current_workspace_id()
         AND samurai_workspace_is_writable(workspace_id)
         AND samurai_can_workspace(workspace_id, 'admin')
       )`
    ]
  },
  {
    version: 48,
    name: "workspace_server_bundle_v4_agent_connection_import_guards",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_import_workspace_agent(
        target_workspace_id TEXT,
        target_agent_id TEXT,
        target_display_name TEXT,
        target_description TEXT,
        target_backend_id TEXT,
        target_status TEXT,
        target_version BIGINT,
        target_created_by TEXT,
        target_created_at TIMESTAMPTZ,
        target_updated_at TIMESTAMPTZ
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        IF btrim(target_agent_id) = '' OR btrim(target_display_name) = '' OR btrim(target_backend_id) = ''
          OR target_status NOT IN ('active', 'disabled', 'revoked') OR target_version < 1
          OR target_created_at IS NULL OR target_updated_at IS NULL
          OR NOT EXISTS (SELECT 1 FROM accounts WHERE id = target_created_by) THEN
          RAISE EXCEPTION 'workspace_bundle_agent_invalid';
        END IF;
        INSERT INTO workspace_agents(
          workspace_id, id, display_name, description, backend_id, status, version,
          created_by, created_at, updated_at
        ) VALUES (
          target_workspace_id, btrim(target_agent_id), btrim(target_display_name),
          btrim(COALESCE(target_description, '')), btrim(target_backend_id), target_status,
          target_version, target_created_by, target_created_at, target_updated_at
        )
        ON CONFLICT (workspace_id, id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          description = EXCLUDED.description,
          backend_id = EXCLUDED.backend_id,
          status = EXCLUDED.status,
          version = EXCLUDED.version,
          created_by = EXCLUDED.created_by,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_import_workspace_agent_room_permission(
        target_workspace_id TEXT,
        target_room_id TEXT,
        target_agent_id TEXT,
        target_can_view BOOLEAN,
        target_can_edit BOOLEAN,
        target_can_execute BOOLEAN,
        target_version BIGINT,
        target_created_by TEXT,
        target_created_at TIMESTAMPTZ,
        target_updated_at TIMESTAMPTZ
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        IF target_can_edit AND NOT target_can_view OR target_can_execute AND NOT target_can_view
          OR target_version < 1 OR target_created_at IS NULL OR target_updated_at IS NULL
          OR NOT EXISTS (SELECT 1 FROM rooms WHERE workspace_id = target_workspace_id AND id = target_room_id)
          OR NOT EXISTS (SELECT 1 FROM workspace_agents WHERE workspace_id = target_workspace_id AND id = target_agent_id)
          OR NOT EXISTS (SELECT 1 FROM accounts WHERE id = target_created_by) THEN
          RAISE EXCEPTION 'workspace_bundle_agent_room_permission_invalid';
        END IF;
        INSERT INTO workspace_agent_room_permissions(
          workspace_id, room_id, agent_id, can_view, can_edit, can_execute, version,
          created_by, created_at, updated_at
        ) VALUES (
          target_workspace_id, target_room_id, target_agent_id, target_can_view, target_can_edit,
          target_can_execute, target_version, target_created_by, target_created_at, target_updated_at
        )
        ON CONFLICT (workspace_id, room_id, agent_id) DO UPDATE SET
          can_view = EXCLUDED.can_view,
          can_edit = EXCLUDED.can_edit,
          can_execute = EXCLUDED.can_execute,
          version = EXCLUDED.version,
          created_by = EXCLUDED.created_by,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at;
      END
      $$`,
      `CREATE OR REPLACE FUNCTION samurai_import_workspace_connection_descriptor(
        target_workspace_id TEXT,
        target_connection_id TEXT,
        target_agent_id TEXT,
        target_principal_account_id TEXT,
        target_connector_id TEXT,
        target_app_id TEXT,
        target_status TEXT,
        target_expires_at TIMESTAMPTZ,
        target_revoked_at TIMESTAMPTZ,
        target_allowed_room_ids TEXT[],
        target_room_limit INTEGER,
        target_ingress_classes TEXT[],
        target_version BIGINT,
        target_created_by TEXT,
        target_created_at TIMESTAMPTZ,
        target_updated_at TIMESTAMPTZ
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE bound_room_id TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        IF btrim(target_connection_id) = '' OR btrim(target_connector_id) = '' OR btrim(target_app_id) = ''
          OR target_status NOT IN ('revoked', 'expired')
          OR (target_status = 'revoked') <> (target_revoked_at IS NOT NULL)
          OR target_room_limit < 1 OR target_room_limit > 100
          OR COALESCE(cardinality(target_allowed_room_ids), 0) > target_room_limit
          OR target_version < 1 OR target_expires_at IS NULL
          OR target_created_at IS NULL OR target_updated_at IS NULL
          OR NOT EXISTS (SELECT 1 FROM accounts WHERE id = target_principal_account_id)
          OR NOT EXISTS (SELECT 1 FROM accounts WHERE id = target_created_by)
          OR (target_agent_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM workspace_agents WHERE workspace_id = target_workspace_id AND id = target_agent_id
          )) THEN
          RAISE EXCEPTION 'workspace_bundle_connection_descriptor_invalid';
        END IF;
        FOREACH bound_room_id IN ARRAY COALESCE(target_allowed_room_ids, ARRAY[]::TEXT[]) LOOP
          IF bound_room_id IS NULL OR btrim(bound_room_id) = ''
            OR NOT EXISTS (SELECT 1 FROM rooms WHERE workspace_id = target_workspace_id AND id = bound_room_id) THEN
            RAISE EXCEPTION 'workspace_bundle_connection_room_binding_invalid';
          END IF;
        END LOOP;
        INSERT INTO workspace_connection_descriptors(
          workspace_id, id, agent_id, principal_account_id, connector_id, app_id, status, expires_at,
          revoked_at, allowed_room_ids, room_limit, ingress_classes, version, created_by, created_at, updated_at
        ) VALUES (
          target_workspace_id, btrim(target_connection_id), NULLIF(btrim(target_agent_id), ''),
          target_principal_account_id, btrim(target_connector_id), btrim(target_app_id), target_status,
          target_expires_at, target_revoked_at, COALESCE(target_allowed_room_ids, ARRAY[]::TEXT[]),
          target_room_limit, COALESCE(target_ingress_classes, ARRAY[]::TEXT[]), target_version,
          target_created_by, target_created_at, target_updated_at
        )
        ON CONFLICT (workspace_id, id) DO UPDATE SET
          agent_id = EXCLUDED.agent_id,
          principal_account_id = EXCLUDED.principal_account_id,
          connector_id = EXCLUDED.connector_id,
          app_id = EXCLUDED.app_id,
          status = EXCLUDED.status,
          expires_at = EXCLUDED.expires_at,
          revoked_at = EXCLUDED.revoked_at,
          allowed_room_ids = EXCLUDED.allowed_room_ids,
          room_limit = EXCLUDED.room_limit,
          ingress_classes = EXCLUDED.ingress_classes,
          version = EXCLUDED.version,
          created_by = EXCLUDED.created_by,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at;
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_import_workspace_agent(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_import_workspace_agent_room_permission(TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC",
      "REVOKE EXECUTE ON FUNCTION samurai_import_workspace_connection_descriptor(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], INTEGER, TEXT[], BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC"
    ]
  },
  {
    version: 49,
    name: "workspace_server_runtime_client_event_room_authorization",
    statements: [
      "ALTER TABLE workspace_runtime_client_events ADD COLUMN room_id TEXT",
      "ALTER TABLE workspace_runtime_client_events ADD CONSTRAINT workspace_runtime_client_events_room_fkey FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT",
      "CREATE INDEX workspace_runtime_client_events_room_index ON workspace_runtime_client_events(workspace_id, room_id, created_at)",
      "DROP POLICY workspace_runtime_client_events_access ON workspace_runtime_client_events",
      `CREATE POLICY workspace_runtime_client_events_access ON workspace_runtime_client_events FOR ALL USING (
        workspace_id = samurai_current_workspace_id() AND (
          (room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read'))
          OR (room_id IS NULL AND samurai_can_workspace(workspace_id, 'guest'))
        )
      ) WITH CHECK (
        workspace_id = samurai_current_workspace_id() AND samurai_workspace_is_writable(workspace_id) AND (
          (room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'execute'))
          OR (room_id IS NULL AND samurai_can_workspace(workspace_id, 'execute'))
        )
      )`
    ]
  },
  {
    // HTTP/self-host transfer uses the same V4 ledger as the CLI. A transfer
    // temporarily makes the source read-only, so this function intentionally
    // checks ownership rather than the ordinary writable predicate.
    version: 50,
    name: "workspace_server_bundle_v4_transfer_ledger",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_record_workspace_bundle_v4_transfer(
        target_workspace_id TEXT,
        target_bundle_id TEXT,
        target_path TEXT,
        target_hash TEXT,
        target_record_counts JSONB,
        target_transfer_id TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE transfer_row workspace_transfers%ROWTYPE;
      DECLARE existing_bundle workspace_bundles%ROWTYPE;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_can_workspace(target_workspace_id, 'owner')
          OR btrim(target_transfer_id) = ''
          OR target_hash !~ '^[0-9a-f]{64}$'
          OR jsonb_typeof(target_record_counts) <> 'object'
          OR target_path = ''
          OR target_path LIKE '%.staging-%/%'
        THEN RAISE EXCEPTION 'workspace_bundle_v4_transfer_ledger_input_invalid'; END IF;

        SELECT * INTO transfer_row FROM workspace_transfers
        WHERE workspace_id = target_workspace_id AND id = target_transfer_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_transfer_not_found'; END IF;
        IF transfer_row.state = 'exported'
          AND transfer_row.bundle_path = target_path
          AND transfer_row.bundle_hash = target_hash THEN
          RETURN;
        END IF;
        IF transfer_row.state <> 'preparing' THEN RAISE EXCEPTION 'workspace_transfer_not_ready'; END IF;

        SELECT * INTO existing_bundle FROM workspace_bundles
        WHERE workspace_id = target_workspace_id AND id = target_bundle_id FOR UPDATE;
        IF FOUND THEN
          IF existing_bundle.format_version <> 4
            OR existing_bundle.path <> target_path
            OR existing_bundle.sha256 <> target_hash
            OR existing_bundle.record_counts <> target_record_counts THEN
            RAISE EXCEPTION 'workspace_bundle_v4_ledger_conflict';
          END IF;
        ELSE
          INSERT INTO workspace_bundles(workspace_id, id, format_version, path, sha256, record_counts, created_by)
          VALUES (target_workspace_id, target_bundle_id, 4, target_path, target_hash, target_record_counts, samurai_current_account_id());
        END IF;

        UPDATE workspace_transfers
        SET state = 'exported', bundle_path = target_path, bundle_hash = target_hash,
            version = version + 1, updated_at = NOW()
        WHERE workspace_id = target_workspace_id AND id = target_transfer_id AND state = 'preparing';
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_transfer_not_ready'; END IF;
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_record_workspace_bundle_v4_transfer(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC"
    ]
  },
  {
    // Hosted deployments may serve more than one Workspace. The worker lists
    // only identities explicitly configured by each Workspace owner, then
    // opens a separate ordinary RLS transaction for every returned pair.
    // The worker marker is set by the Server composition and is never derived
    // from HTTP input or a Workspace caller.
    version: 51,
    name: "workspace_server_worker_maintenance_identity_listing",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_list_completion_maintenance_identities()
       RETURNS TABLE(workspace_id TEXT, account_id TEXT)
       LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
         SELECT identity.workspace_id, identity.account_id
         FROM workspace_completion_maintenance_identities AS identity
         WHERE current_setting('samurai.worker', true) = '1'
         ORDER BY identity.workspace_id, identity.account_id
       $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_list_completion_maintenance_identities() FROM PUBLIC"
    ]
  },
  {
    // Gateway control-plane state is Workspace-owned operational state. It is
    // deliberately separate from legacy local tables and from prose
    // Workspace records. Each table keeps stable lookup columns alongside the
    // validated domain record so duplicate, lease, and expiry decisions do
    // not depend on an unindexed JSON scan.
    version: 52,
    name: "workspace_server_gateway_runtime_state",
    statements: [
      `CREATE TABLE workspace_gateway_pairing_policies (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        id TEXT NOT NULL,
        status TEXT NOT NULL,
        trust_mode TEXT NOT NULL,
        allowlist JSONB NOT NULL DEFAULT '[]'::JSONB,
        allowed_tools JSONB NOT NULL DEFAULT '[]'::JSONB,
        pairing_ttl_ms BIGINT,
        duplicate_window_ms BIGINT,
        rate_limit_window_ms BIGINT,
        rate_limit_max INTEGER,
        record JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, channel),
        UNIQUE (workspace_id, id)
      )`,
      `CREATE TABLE workspace_gateway_routing_policies (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        id TEXT NOT NULL,
        status TEXT NOT NULL,
        session_key_strategy TEXT NOT NULL,
        default_account_id TEXT,
        default_thread_id TEXT,
        default_route TEXT NOT NULL,
        record JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, channel),
        UNIQUE (workspace_id, id)
      )`,
      `CREATE TABLE workspace_gateway_pairings (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        channel TEXT NOT NULL,
        source_identity TEXT NOT NULL,
        source_label TEXT,
        status TEXT NOT NULL,
        pairing_code TEXT,
        session_key TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        record JSONB NOT NULL DEFAULT '{}'::JSONB,
        requested_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id)
      )`,
      `CREATE TABLE workspace_gateway_inbound_messages (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        channel TEXT NOT NULL,
        source_identity TEXT NOT NULL,
        source_label TEXT,
        body TEXT NOT NULL,
        body_hash TEXT NOT NULL DEFAULT '',
        external_message_id TEXT,
        status TEXT NOT NULL,
        trusted BOOLEAN NOT NULL DEFAULT FALSE,
        session_key TEXT,
        pairing_id TEXT,
        message_id TEXT,
        error TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        record JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id)
      )`,
      `CREATE TABLE workspace_gateway_deliveries (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        inbound_id TEXT,
        session_key TEXT NOT NULL,
        channel TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
        next_attempt_at TIMESTAMPTZ,
        lease_until TIMESTAMPTZ,
        receipt JSONB,
        last_error TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::JSONB,
        record JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        delivered_at TIMESTAMPTZ,
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, idempotency_key)
      )`,
      `CREATE TABLE workspace_gateway_boundary_policies (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        source_channel TEXT NOT NULL,
        source_identity TEXT,
        session_key TEXT NOT NULL,
        allowed_tools JSONB NOT NULL DEFAULT '[]'::JSONB,
        mcp_config_refs JSONB NOT NULL DEFAULT '[]'::JSONB,
        secret_refs JSONB NOT NULL DEFAULT '[]'::JSONB,
        sandbox JSONB NOT NULL,
        path_normalization JSONB NOT NULL,
        allowlist JSONB NOT NULL DEFAULT '[]'::JSONB,
        timeout_ms BIGINT,
        concurrency_lock JSONB,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        record JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id)
      )`,
      `CREATE TABLE workspace_gateway_mcp_configs (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        server_name TEXT NOT NULL,
        transport TEXT NOT NULL,
        enabled BOOLEAN NOT NULL,
        allowed_tools JSONB NOT NULL DEFAULT '[]'::JSONB,
        config_ref JSONB,
        secret_refs JSONB NOT NULL DEFAULT '[]'::JSONB,
        stdio JSONB,
        http JSONB,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        record JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, server_name)
      )`,
      `CREATE TABLE workspace_gateway_concurrency_locks (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        lock_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        policy_id TEXT,
        owner_ref JSONB,
        status TEXT NOT NULL,
        acquired_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        released_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        record JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, lock_key)
      )`,
      `CREATE TABLE workspace_gateway_sandbox_instances (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        instance_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        backend TEXT NOT NULL,
        status TEXT NOT NULL,
        sandbox JSONB NOT NULL,
        session_key TEXT,
        owner_ref JSONB,
        workspace_root TEXT,
        last_used_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        record JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, instance_key)
      )`,
      `CREATE TABLE workspace_gateway_sandbox_syncs (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        instance_key TEXT NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_root TEXT,
        remote_workspace_root TEXT,
        file_count BIGINT,
        byte_count BIGINT,
        error TEXT,
        record JSONB NOT NULL DEFAULT '{}'::JSONB,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        PRIMARY KEY (workspace_id, id)
      )`,
      "CREATE INDEX workspace_gateway_pairings_lookup ON workspace_gateway_pairings(workspace_id, channel, source_identity, status, session_key, updated_at DESC)",
      "CREATE INDEX workspace_gateway_inbound_duplicate ON workspace_gateway_inbound_messages(workspace_id, channel, source_identity, body_hash, created_at DESC)",
      "CREATE INDEX workspace_gateway_deliveries_due ON workspace_gateway_deliveries(workspace_id, status, next_attempt_at, lease_until)",
      "CREATE INDEX workspace_gateway_boundary_lookup ON workspace_gateway_boundary_policies(workspace_id, source_channel, source_identity, session_key, updated_at DESC)",
      "CREATE INDEX workspace_gateway_sandbox_syncs_instance ON workspace_gateway_sandbox_syncs(workspace_id, instance_id, started_at DESC)",
      ...workspaceGatewayRlsStatements()
    ]
  },
  {
    // Skill Optimization is a durable, reviewable operation. Its candidate
    // body and rollback Markdown remain explicit records here while the live
    // Skill document is changed only through the Completion file transaction.
    version: 53,
    name: "workspace_server_skill_optimization_state",
    statements: [
      `CREATE TABLE workspace_skill_optimization_runs (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        target_skill_id TEXT NOT NULL,
        room_id TEXT,
        session_id TEXT,
        status TEXT NOT NULL,
        record JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_skill_optimization_datasets (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        room_id TEXT,
        record JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_skill_optimization_objectives (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        room_id TEXT,
        status TEXT NOT NULL,
        record JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_skill_optimization_work_items (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        room_id TEXT,
        status TEXT NOT NULL,
        worker_id TEXT,
        lease_until TIMESTAMPTZ,
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        record JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, objective_id) REFERENCES workspace_skill_optimization_objectives(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_skill_optimization_candidates (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        room_id TEXT,
        content_hash TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        record JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, run_id) REFERENCES workspace_skill_optimization_runs(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_skill_optimization_evaluations (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        room_id TEXT,
        record JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, run_id) REFERENCES workspace_skill_optimization_runs(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, candidate_id) REFERENCES workspace_skill_optimization_candidates(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_skill_optimization_promotions (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        room_id TEXT,
        status TEXT NOT NULL,
        record JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, run_id) REFERENCES workspace_skill_optimization_runs(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, candidate_id) REFERENCES workspace_skill_optimization_candidates(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_skill_optimization_snapshots (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        room_id TEXT,
        content_hash TEXT NOT NULL,
        markdown TEXT NOT NULL,
        record JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, run_id) REFERENCES workspace_skill_optimization_runs(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, candidate_id) REFERENCES workspace_skill_optimization_candidates(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE workspace_skill_optimization_locks (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        room_id TEXT,
        acquired_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, skill_id),
        FOREIGN KEY (workspace_id, room_id) REFERENCES rooms(workspace_id, id) ON DELETE RESTRICT
      )`,
      "CREATE INDEX workspace_skill_optimization_runs_skill ON workspace_skill_optimization_runs(workspace_id, target_skill_id, created_at DESC)",
      "CREATE INDEX workspace_skill_optimization_candidates_run ON workspace_skill_optimization_candidates(workspace_id, run_id, created_at ASC)",
      "CREATE INDEX workspace_skill_optimization_evaluations_candidate ON workspace_skill_optimization_evaluations(workspace_id, candidate_id, created_at ASC)",
      "CREATE INDEX workspace_skill_optimization_work_items_due ON workspace_skill_optimization_work_items(workspace_id, status, lease_until, updated_at)",
      ...workspaceSkillOptimizationRlsStatements()
    ]
  },
  {
    // v52 created the policy rows with a generic record column, while the
    // typed Gateway adapter persists the public metadata field separately.
    // Add the missing projection without rewriting an already-applied
    // migration checksum.
    version: 54,
    name: "workspace_server_gateway_policy_metadata_columns",
    statements: [
      "ALTER TABLE workspace_gateway_pairing_policies ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::JSONB",
      "ALTER TABLE workspace_gateway_routing_policies ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::JSONB"
    ]
  },
  {
    // The original Runtime policies used FOR ALL with a read-only USING
    // clause. PostgreSQL applies that USING clause to DELETE as well, so a
    // Room reader could delete runtime evidence. Split the policies by SQL
    // command and keep deletion disabled except for the existing temporary
    // user-message cleanup path.
    version: 55,
    name: "workspace_server_runtime_command_specific_rls",
    statements: [
      ...runtimeCommandSpecificRlsStatements()
    ]
  },
  {
    // A process can stop after the import transaction commits but before the
    // read-only Workspace is activated. The owner may resume that exact
    // manifest, including after the short session TTL, without opening a
    // generic write capability or accepting a different Bundle.
    version: 56,
    name: "workspace_server_import_resume_capability",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_reopen_workspace_import(
        target_workspace_id TEXT,
        import_session_id TEXT,
        target_manifest_hash TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE current_state TEXT;
      DECLARE session_account_id TEXT;
      DECLARE session_state TEXT;
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR samurai_current_account_id() IS NULL
          OR NOT samurai_can_workspace(target_workspace_id, 'owner') THEN
          RAISE EXCEPTION 'workspace_import_owner_required';
        END IF;
        SELECT state INTO current_state
        FROM workspaces
        WHERE id = target_workspace_id
        FOR UPDATE;
        IF current_state IS DISTINCT FROM 'read_only' THEN
          RAISE EXCEPTION 'workspace_import_target_not_resumable';
        END IF;
        SELECT account_id, state INTO session_account_id, session_state
        FROM workspace_import_sessions
        WHERE workspace_id = target_workspace_id AND id = import_session_id
        FOR UPDATE;
        IF session_account_id IS DISTINCT FROM samurai_current_account_id()
          OR session_state IS DISTINCT FROM 'writing' THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM workspace_bundles
          WHERE workspace_id = target_workspace_id AND sha256 = target_manifest_hash
        ) THEN
          RAISE EXCEPTION 'workspace_import_manifest_mismatch';
        END IF;
        UPDATE workspace_import_sessions
        SET expires_at = NOW() + INTERVAL '1 hour', updated_at = NOW()
        WHERE workspace_id = target_workspace_id AND id = import_session_id AND state = 'writing';
      END
      $$`,
      "REVOKE EXECUTE ON FUNCTION samurai_reopen_workspace_import(TEXT, TEXT, TEXT) FROM PUBLIC"
    ]
  },
  {
    // v55 split Runtime policies by SQL command but accidentally widened
    // Client Event access back to the whole Workspace. Re-apply the Room
    // boundary in a new migration so already-migrated databases are fixed as
    // well as fresh databases.
    version: 57,
    name: "workspace_server_runtime_client_event_room_command_rls",
    statements: [
      "DROP POLICY IF EXISTS workspace_runtime_client_events_access ON workspace_runtime_client_events",
      "DROP POLICY IF EXISTS workspace_runtime_client_events_select ON workspace_runtime_client_events",
      "DROP POLICY IF EXISTS workspace_runtime_client_events_insert ON workspace_runtime_client_events",
      "DROP POLICY IF EXISTS workspace_runtime_client_events_update ON workspace_runtime_client_events",
      "DROP POLICY IF EXISTS workspace_runtime_client_events_delete ON workspace_runtime_client_events",
      `CREATE POLICY workspace_runtime_client_events_select ON workspace_runtime_client_events FOR SELECT USING (
        workspace_id = samurai_current_workspace_id() AND (
          (room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read'))
          OR (room_id IS NULL AND samurai_can_workspace(workspace_id, 'guest'))
        )
      )`,
      `CREATE POLICY workspace_runtime_client_events_insert ON workspace_runtime_client_events FOR INSERT WITH CHECK (
        workspace_id = samurai_current_workspace_id() AND samurai_workspace_is_writable(workspace_id) AND (
          (room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'execute'))
          OR (room_id IS NULL AND samurai_can_workspace(workspace_id, 'execute'))
        )
      )`,
      `CREATE POLICY workspace_runtime_client_events_update ON workspace_runtime_client_events FOR UPDATE USING (
        workspace_id = samurai_current_workspace_id() AND samurai_workspace_is_writable(workspace_id) AND (
          (room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'execute'))
          OR (room_id IS NULL AND samurai_can_workspace(workspace_id, 'execute'))
        )
      ) WITH CHECK (
        workspace_id = samurai_current_workspace_id() AND samurai_workspace_is_writable(workspace_id) AND (
          (room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'execute'))
          OR (room_id IS NULL AND samurai_can_workspace(workspace_id, 'execute'))
        )
      )`
    ]
  },
  {
    // Keep the migration ledger immutable. PostgreSQL exposes RETURNS TABLE
    // fields as PL/pgSQL variables, so the existing invitation function's
    // unqualified room_id reference becomes ambiguous on already-migrated
    // databases. Replacing it in a new migration preserves the public
    // function contract while making the parent-membership check explicit.
    version: 58,
    name: "workspace_server_room_invitation_output_column_ambiguity_fix",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_accept_invitation(
        target_workspace_id TEXT,
        supplied_token_hash TEXT,
        target_operation_id TEXT
      ) RETURNS TABLE(workspace_role TEXT, room_id TEXT, room_role TEXT, invitation_version BIGINT)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE invitation workspace_invitations%ROWTYPE;
      DECLARE existing_workspace_member workspace_members%ROWTYPE;
      DECLARE has_existing_workspace_member BOOLEAN;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.room_hierarchy:' || target_workspace_id, 0));
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR samurai_current_account_id() IS NULL
          OR target_operation_id IS NULL OR btrim(target_operation_id) = ''
          OR NOT EXISTS (
            SELECT 1 FROM accounts
            WHERE id = samurai_current_account_id() AND status = 'active'
          ) THEN
          RAISE EXCEPTION 'workspace_invitation_invalid';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        SELECT * INTO invitation
        FROM workspace_invitations
        WHERE workspace_id = target_workspace_id
          AND token_hash = supplied_token_hash
          AND revoked_at IS NULL
          AND accepted_at IS NULL
          AND expires_at > NOW()
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_invitation_invalid'; END IF;
        SELECT * INTO existing_workspace_member
        FROM workspace_members
        WHERE workspace_id = target_workspace_id
          AND account_id = samurai_current_account_id()
        FOR UPDATE;
        has_existing_workspace_member := FOUND;
        IF NOT has_existing_workspace_member OR existing_workspace_member.state <> 'active' THEN
          PERFORM samurai_clear_stale_room_memberships_on_workspace_activation(
            target_workspace_id, samurai_current_account_id()
          );
        END IF;
        INSERT INTO workspace_members(workspace_id, account_id, role, state, version, updated_at)
        VALUES (target_workspace_id, samurai_current_account_id(), invitation.workspace_role, 'active', 1, NOW())
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET
          role = CASE WHEN samurai_role_rank(EXCLUDED.role) > samurai_role_rank(workspace_members.role) THEN EXCLUDED.role ELSE workspace_members.role END,
          state = 'active', revoked_at = NULL, version = workspace_members.version + 1, updated_at = NOW();
        IF invitation.room_id IS NOT NULL THEN
          IF NOT EXISTS (
            SELECT 1 FROM rooms WHERE workspace_id = target_workspace_id AND id = invitation.room_id
          ) THEN RAISE EXCEPTION 'room_not_available'; END IF;
          IF EXISTS (
            WITH RECURSIVE ancestors(room_id, parent_room_id) AS (
              SELECT parent.id, parent.parent_room_id
              FROM rooms AS room
              JOIN rooms AS parent
                ON parent.workspace_id = room.workspace_id AND parent.id = room.parent_room_id
              WHERE room.workspace_id = target_workspace_id AND room.id = invitation.room_id
              UNION ALL
              SELECT parent.id, parent.parent_room_id
              FROM rooms AS parent
              JOIN ancestors ON ancestors.parent_room_id = parent.id
              WHERE parent.workspace_id = target_workspace_id
            )
            SELECT 1 FROM ancestors
            WHERE NOT EXISTS (
              SELECT 1 FROM room_members AS ancestor_member
              WHERE ancestor_member.workspace_id = target_workspace_id
                AND ancestor_member.room_id = ancestors.room_id
                AND ancestor_member.account_id = samurai_current_account_id()
                AND ancestor_member.state = 'active'
            )
          ) THEN RAISE EXCEPTION 'room_parent_membership_required'; END IF;
          INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version, updated_at)
          VALUES (target_workspace_id, invitation.room_id, samurai_current_account_id(), COALESCE(invitation.room_role, invitation.workspace_role), 'active', 1, NOW())
          ON CONFLICT (workspace_id, room_id, account_id) DO UPDATE SET
            role = CASE WHEN samurai_role_rank(EXCLUDED.role) > samurai_role_rank(room_members.role) THEN EXCLUDED.role ELSE room_members.role END,
            state = 'active', revoked_at = NULL, version = room_members.version + 1, updated_at = NOW();
          INSERT INTO workspace_events(workspace_id, room_id, kind, operation_id, payload)
          VALUES (
            target_workspace_id, invitation.room_id, 'room.member.changed', target_operation_id,
            jsonb_build_object('changed_room_id', invitation.room_id)
          );
        END IF;
        UPDATE workspace_invitations
        SET accepted_by = samurai_current_account_id(), accepted_at = NOW(), version = version + 1
        WHERE workspace_id = target_workspace_id AND id = invitation.id
        RETURNING version INTO invitation_version;
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
        RETURN QUERY SELECT invitation.workspace_role, invitation.room_id, invitation.room_role, invitation_version;
      END
      $$`
    ]
  },
  {
    // The v58 function fixed the ancestor query, but its ON CONFLICT column
    // list still collides with the RETURNS TABLE room_id output variable when
    // PostgreSQL compiles the function on first use. Use the primary-key
    // constraint explicitly instead of changing the public return contract.
    version: 59,
    name: "workspace_server_room_invitation_conflict_target_ambiguity_fix",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_accept_invitation(
        target_workspace_id TEXT,
        supplied_token_hash TEXT,
        target_operation_id TEXT
      ) RETURNS TABLE(workspace_role TEXT, room_id TEXT, room_role TEXT, invitation_version BIGINT)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE invitation workspace_invitations%ROWTYPE;
      DECLARE existing_workspace_member workspace_members%ROWTYPE;
      DECLARE has_existing_workspace_member BOOLEAN;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('samurai.workspace.room_hierarchy:' || target_workspace_id, 0));
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR samurai_current_account_id() IS NULL
          OR target_operation_id IS NULL OR btrim(target_operation_id) = ''
          OR NOT EXISTS (
            SELECT 1 FROM accounts
            WHERE id = samurai_current_account_id() AND status = 'active'
          ) THEN
          RAISE EXCEPTION 'workspace_invitation_invalid';
        END IF;
        PERFORM samurai_assert_workspace_writable(target_workspace_id);
        SELECT * INTO invitation
        FROM workspace_invitations
        WHERE workspace_id = target_workspace_id
          AND token_hash = supplied_token_hash
          AND revoked_at IS NULL
          AND accepted_at IS NULL
          AND expires_at > NOW()
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_invitation_invalid'; END IF;
        SELECT * INTO existing_workspace_member
        FROM workspace_members
        WHERE workspace_id = target_workspace_id
          AND account_id = samurai_current_account_id()
        FOR UPDATE;
        has_existing_workspace_member := FOUND;
        IF NOT has_existing_workspace_member OR existing_workspace_member.state <> 'active' THEN
          PERFORM samurai_clear_stale_room_memberships_on_workspace_activation(
            target_workspace_id, samurai_current_account_id()
          );
        END IF;
        INSERT INTO workspace_members(workspace_id, account_id, role, state, version, updated_at)
        VALUES (target_workspace_id, samurai_current_account_id(), invitation.workspace_role, 'active', 1, NOW())
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET
          role = CASE WHEN samurai_role_rank(EXCLUDED.role) > samurai_role_rank(workspace_members.role) THEN EXCLUDED.role ELSE workspace_members.role END,
          state = 'active', revoked_at = NULL, version = workspace_members.version + 1, updated_at = NOW();
        IF invitation.room_id IS NOT NULL THEN
          IF NOT EXISTS (
            SELECT 1 FROM rooms WHERE workspace_id = target_workspace_id AND id = invitation.room_id
          ) THEN RAISE EXCEPTION 'room_not_available'; END IF;
          IF EXISTS (
            WITH RECURSIVE ancestors(room_id, parent_room_id) AS (
              SELECT parent.id, parent.parent_room_id
              FROM rooms AS room
              JOIN rooms AS parent
                ON parent.workspace_id = room.workspace_id AND parent.id = room.parent_room_id
              WHERE room.workspace_id = target_workspace_id AND room.id = invitation.room_id
              UNION ALL
              SELECT parent.id, parent.parent_room_id
              FROM rooms AS parent
              JOIN ancestors ON ancestors.parent_room_id = parent.id
              WHERE parent.workspace_id = target_workspace_id
            )
            SELECT 1 FROM ancestors
            WHERE NOT EXISTS (
              SELECT 1 FROM room_members AS ancestor_member
              WHERE ancestor_member.workspace_id = target_workspace_id
                AND ancestor_member.room_id = ancestors.room_id
                AND ancestor_member.account_id = samurai_current_account_id()
                AND ancestor_member.state = 'active'
            )
          ) THEN RAISE EXCEPTION 'room_parent_membership_required'; END IF;
          INSERT INTO room_members(workspace_id, room_id, account_id, role, state, version, updated_at)
          VALUES (target_workspace_id, invitation.room_id, samurai_current_account_id(), COALESCE(invitation.room_role, invitation.workspace_role), 'active', 1, NOW())
          ON CONFLICT ON CONSTRAINT room_members_pkey DO UPDATE SET
            role = CASE WHEN samurai_role_rank(EXCLUDED.role) > samurai_role_rank(room_members.role) THEN EXCLUDED.role ELSE room_members.role END,
            state = 'active', revoked_at = NULL, version = room_members.version + 1, updated_at = NOW();
          INSERT INTO workspace_events(workspace_id, room_id, kind, operation_id, payload)
          VALUES (
            target_workspace_id, invitation.room_id, 'room.member.changed', target_operation_id,
            jsonb_build_object('changed_room_id', invitation.room_id)
          );
        END IF;
        UPDATE workspace_invitations
        SET accepted_by = samurai_current_account_id(), accepted_at = NOW(), version = version + 1
        WHERE workspace_id = target_workspace_id AND id = invitation.id
        RETURNING version INTO invitation_version;
        UPDATE workspaces SET version = version + 1, updated_at = NOW() WHERE id = target_workspace_id;
        RETURN QUERY SELECT invitation.workspace_role, invitation.room_id, invitation.room_role, invitation_version;
      END
      $$`
    ]
  },
  {
    // v27 replaced the single-row use constraint with append-only unknown →
    // confirmed rows. Repair an old table constraint by its column identity,
    // not by a generated PostgreSQL name.
    version: 60,
    name: "workspace_server_learning_resource_use_append_only_uniqueness_repair",
    statements: [
      `DO $$
       DECLARE legacy_constraint RECORD;
       BEGIN
         FOR legacy_constraint IN
           SELECT constraint_row.conname
           FROM pg_constraint AS constraint_row
           WHERE constraint_row.conrelid = 'workspace_learning_resource_uses'::regclass
             AND constraint_row.contype = 'u'
             AND constraint_row.conkey = ARRAY[
               (SELECT attribute.attnum FROM pg_attribute AS attribute WHERE attribute.attrelid = 'workspace_learning_resource_uses'::regclass AND attribute.attname = 'workspace_id'),
               (SELECT attribute.attnum FROM pg_attribute AS attribute WHERE attribute.attrelid = 'workspace_learning_resource_uses'::regclass AND attribute.attname = 'resource_id'),
               (SELECT attribute.attnum FROM pg_attribute AS attribute WHERE attribute.attrelid = 'workspace_learning_resource_uses'::regclass AND attribute.attname = 'resource_version'),
               (SELECT attribute.attnum FROM pg_attribute AS attribute WHERE attribute.attrelid = 'workspace_learning_resource_uses'::regclass AND attribute.attname = 'activity_id')
             ]::SMALLINT[]
         LOOP
           EXECUTE format('ALTER TABLE workspace_learning_resource_uses DROP CONSTRAINT %I', legacy_constraint.conname);
         END LOOP;
       END
       $$`,
      "CREATE UNIQUE INDEX IF NOT EXISTS workspace_learning_resource_use_initial_unique ON workspace_learning_resource_uses(workspace_id, resource_id, resource_version, activity_id) WHERE supersedes_use_id IS NULL",
      "CREATE UNIQUE INDEX IF NOT EXISTS workspace_learning_resource_use_correction_unique ON workspace_learning_resource_uses(workspace_id, supersedes_use_id) WHERE supersedes_use_id IS NOT NULL"
    ]
  },
  {
    // PostgreSQL does not create an index for a referencing foreign key.
    // Cleanup and correction lookups must not scan every Activity row.
    version: 61,
    name: "workspace_server_completion_activity_correction_index",
    statements: [
      "CREATE INDEX IF NOT EXISTS workspace_completion_activities_correction_index ON workspace_completion_activities(workspace_id, correction_of_activity_id)"
    ]
  },
  {
    // A resource that is already machine-verified may still receive ordinary
    // metadata/pointer updates. Only creation or a transition into the
    // machine-verified state requires a new attestation.
    version: 62,
    name: "workspace_server_completion_machine_verified_transition_guard",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_guard_completion_machine_verified() RETURNS TRIGGER
       LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
       BEGIN
         IF NEW.creation_source = 'machine_verified'
           AND NOT samurai_is_import_session(NEW.workspace_id)
           AND current_setting('samurai.completion_attestation_apply', true) IS DISTINCT FROM 'on' THEN
           IF TG_OP = 'INSERT' THEN
             RAISE EXCEPTION 'workspace_completion_machine_verified_attestation_required';
           ELSIF OLD.creation_source IS DISTINCT FROM 'machine_verified' THEN
             RAISE EXCEPTION 'workspace_completion_machine_verified_attestation_required';
           END IF;
         END IF;
         RETURN NEW;
       END
       $$`
    ]
  },
  {
    // A backfill may create and immediately read its own file-batch ledger
    // while the Workspace is read-only.  The Run capability already limits
    // that path to the matching owner, run and phase; include it in USING as
    // well as WITH CHECK so finalization and child-entry checks do not lose
    // visibility of the just-created batch.
    version: 63,
    name: "workspace_server_completion_migration_file_batch_visibility",
    statements: [
      "DROP POLICY workspace_completion_file_batches_access ON workspace_completion_file_batches",
      `CREATE POLICY workspace_completion_file_batches_access ON workspace_completion_file_batches FOR ALL USING (
        workspace_id = samurai_current_workspace_id() AND (
          samurai_completion_migration_write_allowed(workspace_id)
          OR (scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'guest'))
          OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read'))
        )
      ) WITH CHECK (
        workspace_id = samurai_current_workspace_id() AND (
          samurai_is_import_session(workspace_id)
          OR samurai_completion_migration_write_allowed(workspace_id)
          OR (samurai_workspace_is_writable(workspace_id) AND (
            (scope_kind = 'workspace' AND samurai_can_workspace(workspace_id, 'admin'))
            OR (scope_kind = 'room' AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'execute'))
          ))
        )
      )`,
      "DROP POLICY workspace_completion_file_batch_entries_access ON workspace_completion_file_batch_entries",
      `CREATE POLICY workspace_completion_file_batch_entries_access ON workspace_completion_file_batch_entries FOR ALL USING (
        workspace_id = samurai_current_workspace_id() AND (
          samurai_completion_migration_write_allowed(workspace_id)
          OR EXISTS (
            SELECT 1 FROM workspace_completion_file_batches batch
            WHERE batch.workspace_id = workspace_completion_file_batch_entries.workspace_id
              AND batch.id = workspace_completion_file_batch_entries.batch_id
              AND ((batch.scope_kind = 'workspace' AND samurai_can_workspace(batch.workspace_id, 'guest'))
                OR (batch.scope_kind = 'room' AND batch.room_id IS NOT NULL AND samurai_can_room(batch.workspace_id, batch.room_id, 'read')))
          )
        )
      ) WITH CHECK (
        workspace_id = samurai_current_workspace_id() AND EXISTS (
          SELECT 1 FROM workspace_completion_file_batches batch
          WHERE batch.workspace_id = workspace_completion_file_batch_entries.workspace_id
            AND batch.id = workspace_completion_file_batch_entries.batch_id
            AND (samurai_is_import_session(batch.workspace_id)
              OR samurai_completion_migration_write_allowed(batch.workspace_id)
              OR (samurai_workspace_is_writable(batch.workspace_id) AND (
                (batch.scope_kind = 'workspace' AND samurai_can_workspace(batch.workspace_id, 'admin'))
                OR (batch.scope_kind = 'room' AND batch.room_id IS NOT NULL AND samurai_can_room(batch.workspace_id, batch.room_id, 'execute'))
              )))
        )
      )`
    ]
  },
  {
    // File batches are the durable ledger used by the file/DB coordinator.
    // Keep the read-only migration exception separate from normal access so a
    // parent batch and its child entries can be written and then recovered
    // only by the matching migration Run, not by an ordinary writable caller.
    version: 64,
    name: "workspace_server_completion_migration_file_batch_capability_policy",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_completion_migration_write_allowed(target_workspace_id TEXT)
      RETURNS BOOLEAN
      LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT target_workspace_id = samurai_current_workspace_id()
          AND EXISTS(
            SELECT 1 FROM workspace_completion_migration_runs run
            WHERE run.workspace_id = target_workspace_id
              AND run.id = samurai_context_value('samurai.completion_migration_run_id')
              AND run.owner_account_id = samurai_current_account_id()
              AND (
                (current_setting('samurai.completion_migration_operation', true) = 'completion_backfill'
                  AND run.state IN ('preparing', 'backfilling', 'verified'))
                OR (current_setting('samurai.completion_migration_operation', true) = 'completion_rollback'
                  AND run.state = 'rolling_back')
              )
          )
      $$`,
      "DROP POLICY IF EXISTS workspace_completion_file_batches_migration_access ON workspace_completion_file_batches",
      `CREATE POLICY workspace_completion_file_batches_migration_access ON workspace_completion_file_batches FOR ALL
       USING (samurai_completion_migration_write_allowed(workspace_id))
       WITH CHECK (samurai_completion_migration_write_allowed(workspace_id))`,
      "DROP POLICY IF EXISTS workspace_completion_file_batch_entries_migration_access ON workspace_completion_file_batch_entries",
      `CREATE POLICY workspace_completion_file_batch_entries_migration_access ON workspace_completion_file_batch_entries FOR ALL
       USING (samurai_completion_migration_write_allowed(workspace_id))
       WITH CHECK (samurai_completion_migration_write_allowed(workspace_id))`
    ]
  },
  {
    // Import abort follows the foreign-key dependency graph.  Earlier
    // versions removed file batches before resource versions and profile/skill
    // metadata, which could hide the original import error behind cleanup.
    version: 65,
    name: "workspace_server_bundle_import_abort_dependency_order",
    statements: [
      `CREATE OR REPLACE FUNCTION samurai_abort_workspace_import(
        target_workspace_id TEXT,
        import_session_id TEXT
      ) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF target_workspace_id IS DISTINCT FROM samurai_current_workspace_id()
          OR NOT samurai_is_import_session(target_workspace_id) THEN
          RAISE EXCEPTION 'workspace_import_session_invalid';
        END IF;
        DELETE FROM workspace_completion_search_projection WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_policy_rules WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_policy_change_requests WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_policy_approvals WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_uses WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_evaluations WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_evidence WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_attestations WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_resource_links WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_redactions WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_skill_files WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_workspace_documents WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_job_raw_outputs WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_resource_versions WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_resources WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_file_batch_entries WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_file_batches WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_episode_activities WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_activities WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_episodes WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_job_attempts WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_jobs WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_curator_snapshots WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_curator_state WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_configurations WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_migration_receipts WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_migration_runs WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_completion_maintenance_identities WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_resource_uses WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_resource_links WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_evidence WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_resource_versions WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_resources WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_job_attempts WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_jobs WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_activities WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_learning_settings WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_audit_entries WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_bundles WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_transfers WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_invitations WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_jobs WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_events WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_operations WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_file_transactions WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_files WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_records WHERE workspace_id = target_workspace_id;
        DELETE FROM room_members WHERE workspace_id = target_workspace_id;
        DELETE FROM rooms WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_members WHERE workspace_id = target_workspace_id;
        DELETE FROM workspace_import_sessions WHERE workspace_id = target_workspace_id AND id = import_session_id;
        DELETE FROM workspaces WHERE id = target_workspace_id AND state = 'read_only';
        IF NOT FOUND THEN RAISE EXCEPTION 'workspace_import_target_invalid'; END IF;
      END
      $$`
    ]
  }
];

function workspaceGatewayRlsStatements(): string[] {
  const tables = [
    "workspace_gateway_pairing_policies",
    "workspace_gateway_routing_policies",
    "workspace_gateway_pairings",
    "workspace_gateway_inbound_messages",
    "workspace_gateway_deliveries",
    "workspace_gateway_boundary_policies",
    "workspace_gateway_mcp_configs",
    "workspace_gateway_concurrency_locks",
    "workspace_gateway_sandbox_instances",
    "workspace_gateway_sandbox_syncs"
  ];
  const statements: string[] = [];
  for (const table of tables) {
    statements.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    statements.push(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    statements.push(`CREATE POLICY ${table}_access ON ${table} FOR ALL
      USING (
        workspace_id = samurai_current_workspace_id()
        AND (
          samurai_can_workspace(workspace_id, 'read')
          OR samurai_is_completion_maintenance_identity(workspace_id)
          OR (samurai_external_integration_enabled() AND current_setting('samurai.external_integration', true) = '1')
        )
      )
      WITH CHECK (
        workspace_id = samurai_current_workspace_id()
        AND samurai_workspace_is_writable(workspace_id)
        AND (
          samurai_can_workspace(workspace_id, 'execute')
          OR samurai_is_completion_maintenance_identity(workspace_id)
          OR (samurai_external_integration_enabled() AND current_setting('samurai.external_integration', true) = '1')
        )
      )`);
  }
  return statements;
}

function workspaceSkillOptimizationRlsStatements(): string[] {
  const tables = [
    "workspace_skill_optimization_runs",
    "workspace_skill_optimization_datasets",
    "workspace_skill_optimization_objectives",
    "workspace_skill_optimization_work_items",
    "workspace_skill_optimization_candidates",
    "workspace_skill_optimization_evaluations",
    "workspace_skill_optimization_promotions",
    "workspace_skill_optimization_snapshots",
    "workspace_skill_optimization_locks"
  ];
  const statements: string[] = [];
  for (const table of tables) {
    statements.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    statements.push(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  }
  for (const table of tables) {
    statements.push(`CREATE POLICY ${table}_access ON ${table} FOR ALL
      USING (
        workspace_id = samurai_current_workspace_id()
        AND (
          (
            room_id IS NULL
            AND samurai_can_workspace(workspace_id, 'read')
          )
          OR (
            room_id IS NOT NULL
            AND samurai_can_room(workspace_id, room_id, 'read')
          )
          OR samurai_is_completion_maintenance_identity(workspace_id)
        )
      )
      WITH CHECK (
        workspace_id = samurai_current_workspace_id()
        AND samurai_workspace_is_writable(workspace_id)
        AND (
          (
            room_id IS NULL
            AND samurai_can_workspace(workspace_id, 'execute')
          )
          OR (
            room_id IS NOT NULL
            AND samurai_can_room(workspace_id, room_id, 'execute')
          )
          OR samurai_is_completion_maintenance_identity(workspace_id)
        )
      )`);
  }
  return statements;
}

export async function applyWorkspaceServerMigrations(pool: Pool, runtimeRole: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SET search_path TO public");
    await client.query(`CREATE TABLE IF NOT EXISTS samurai_server_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const applied = await client.query<{ version: number; name: string; checksum: string }>(
      "SELECT version, name, checksum FROM samurai_server_schema_migrations ORDER BY version"
    );
    const appliedByVersion = new Map(applied.rows.map((row) => [Number(row.version), row]));
    for (const migration of migrations) {
      const checksum = migrationChecksum(migration);
      const existing = appliedByVersion.get(migration.version);
      if (existing) {
        if (existing.name !== migration.name || existing.checksum !== checksum) {
          throw new Error(`workspace_server_schema_migration_mismatch:${migration.version}`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        for (const statement of migration.statements) await client.query(statement);
        await client.query(
          "INSERT INTO samurai_server_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
          [migration.version, migration.name, checksum]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    await grantRuntimeRole(client, runtimeRole);
  } finally {
    client.release();
  }
}

export function workspaceServerMigrationDefinitions(): readonly { version: number; name: string; statements: readonly string[] }[] {
  return migrations;
}

/** Runtime startup uses this to reject a database whose migrations are stale or altered. */
export function workspaceServerMigrationStatus(): readonly { version: number; name: string; checksum: string }[] {
  return migrations.map((migration) => ({
    version: migration.version,
    name: migration.name,
    checksum: migrationChecksum(migration)
  }));
}

function runtimeRlsStatements(): string[] {
  const statements: string[] = [];
  const tables = [
    "workspace_runtime_sessions",
    "workspace_runtime_messages",
    "workspace_runtime_operations",
    "workspace_runtime_runs",
    "workspace_runtime_reservations",
    "workspace_runtime_events",
    "workspace_runtime_changes",
    "workspace_runtime_activities",
    "workspace_runtime_resource_usage",
    "workspace_runtime_resources",
    "workspace_runtime_settings",
    "workspace_runtime_client_events"
  ];
  for (const table of tables) {
    statements.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    statements.push(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  }
  statements.push(`CREATE POLICY workspace_runtime_sessions_access ON workspace_runtime_sessions FOR ALL USING (
    workspace_id = samurai_current_workspace_id() AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read')
  ) WITH CHECK (
    workspace_id = samurai_current_workspace_id() AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'execute')
  )`);
  statements.push(`CREATE POLICY workspace_runtime_messages_access ON workspace_runtime_messages FOR ALL USING (
    workspace_id = samurai_current_workspace_id() AND EXISTS (
      SELECT 1 FROM workspace_runtime_sessions session
      WHERE session.workspace_id = workspace_runtime_messages.workspace_id
        AND session.id = workspace_runtime_messages.session_id
        AND session.room_id IS NOT NULL
        AND samurai_can_room(session.workspace_id, session.room_id, 'read')
    )
  ) WITH CHECK (
    workspace_id = samurai_current_workspace_id() AND EXISTS (
      SELECT 1 FROM workspace_runtime_sessions session
      WHERE session.workspace_id = workspace_runtime_messages.workspace_id
        AND session.id = workspace_runtime_messages.session_id
        AND session.room_id IS NOT NULL
        AND samurai_can_room(session.workspace_id, session.room_id, 'execute')
    )
  )`);
  statements.push(`CREATE POLICY workspace_runtime_operations_access ON workspace_runtime_operations FOR ALL USING (
    workspace_id = samurai_current_workspace_id() AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read')
  ) WITH CHECK (
    workspace_id = samurai_current_workspace_id() AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'execute')
  )`);
  statements.push(`CREATE POLICY workspace_runtime_runs_access ON workspace_runtime_runs FOR ALL USING (
    workspace_id = samurai_current_workspace_id() AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read')
  ) WITH CHECK (
    workspace_id = samurai_current_workspace_id() AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'execute')
  )`);
  statements.push(`CREATE POLICY workspace_runtime_reservations_access ON workspace_runtime_reservations FOR ALL USING (
    workspace_id = samurai_current_workspace_id() AND EXISTS (
      SELECT 1 FROM workspace_runtime_runs run
      WHERE run.workspace_id = workspace_runtime_reservations.workspace_id
        AND run.id = workspace_runtime_reservations.run_id
        AND run.room_id IS NOT NULL AND samurai_can_room(run.workspace_id, run.room_id, 'read')
    )
  ) WITH CHECK (
    workspace_id = samurai_current_workspace_id() AND EXISTS (
      SELECT 1 FROM workspace_runtime_runs run
      WHERE run.workspace_id = workspace_runtime_reservations.workspace_id
        AND run.id = workspace_runtime_reservations.run_id
        AND run.room_id IS NOT NULL AND samurai_can_room(run.workspace_id, run.room_id, 'execute')
    )
  )`);
  statements.push(`CREATE POLICY workspace_runtime_events_access ON workspace_runtime_events FOR ALL USING (
    workspace_id = samurai_current_workspace_id() AND EXISTS (
      SELECT 1 FROM workspace_runtime_runs run
      WHERE run.workspace_id = workspace_runtime_events.workspace_id
        AND run.id = workspace_runtime_events.run_id
        AND run.room_id IS NOT NULL AND samurai_can_room(run.workspace_id, run.room_id, 'read')
    )
  ) WITH CHECK (
    workspace_id = samurai_current_workspace_id() AND EXISTS (
      SELECT 1 FROM workspace_runtime_runs run
      WHERE run.workspace_id = workspace_runtime_events.workspace_id
        AND run.id = workspace_runtime_events.run_id
        AND run.room_id IS NOT NULL AND samurai_can_room(run.workspace_id, run.room_id, 'execute')
    )
  )`);
  statements.push(`CREATE POLICY workspace_runtime_changes_access ON workspace_runtime_changes FOR ALL USING (
    workspace_id = samurai_current_workspace_id() AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read')
  ) WITH CHECK (
    workspace_id = samurai_current_workspace_id() AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'execute')
  )`);
  statements.push(`CREATE POLICY workspace_runtime_activities_access ON workspace_runtime_activities FOR ALL USING (
    workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')
  ) WITH CHECK (
    workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'execute')
  )`);
  statements.push(`CREATE POLICY workspace_runtime_resource_usage_access ON workspace_runtime_resource_usage FOR ALL USING (
    workspace_id = samurai_current_workspace_id() AND EXISTS (
      SELECT 1 FROM workspace_runtime_activities activity
      WHERE activity.workspace_id = workspace_runtime_resource_usage.workspace_id
        AND activity.id = workspace_runtime_resource_usage.activity_id
        AND samurai_can_room(activity.workspace_id, activity.room_id, 'read')
    )
  ) WITH CHECK (
    workspace_id = samurai_current_workspace_id() AND EXISTS (
      SELECT 1 FROM workspace_runtime_activities activity
      WHERE activity.workspace_id = workspace_runtime_resource_usage.workspace_id
        AND activity.id = workspace_runtime_resource_usage.activity_id
        AND samurai_can_room(activity.workspace_id, activity.room_id, 'execute')
    )
  )`);
  statements.push(`CREATE POLICY workspace_runtime_resources_access ON workspace_runtime_resources FOR ALL USING (
    workspace_id = samurai_current_workspace_id() AND (
      (room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read'))
      OR (room_id IS NULL AND samurai_can_workspace(workspace_id, 'guest'))
    )
  ) WITH CHECK (
    workspace_id = samurai_current_workspace_id() AND (
      (room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'edit'))
      OR (room_id IS NULL AND samurai_can_workspace(workspace_id, 'admin'))
    )
  )`);
  statements.push(`CREATE POLICY workspace_runtime_settings_access ON workspace_runtime_settings FOR ALL USING (
    workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'guest')
  ) WITH CHECK (
    workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'admin')
  )`);
  statements.push(`CREATE POLICY workspace_runtime_client_events_access ON workspace_runtime_client_events FOR ALL USING (
    workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'guest')
  ) WITH CHECK (
    workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'execute')
  )`);
  return statements;
}

function runtimeCommandSpecificRlsStatements(): string[] {
  const policies: Array<{
    table: string;
    read: string;
    write: string;
    delete?: string;
  }> = [
    {
      table: "workspace_runtime_sessions",
      read: "workspace_id = samurai_current_workspace_id() AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read')",
      write: "workspace_id = samurai_current_workspace_id() AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'execute')"
    },
    {
      table: "workspace_runtime_messages",
      read: `workspace_id = samurai_current_workspace_id() AND EXISTS (
        SELECT 1 FROM workspace_runtime_sessions session
        WHERE session.workspace_id = workspace_runtime_messages.workspace_id
          AND session.id = workspace_runtime_messages.session_id
          AND session.room_id IS NOT NULL
          AND samurai_can_room(session.workspace_id, session.room_id, 'read')
      )`,
      write: `workspace_id = samurai_current_workspace_id() AND EXISTS (
        SELECT 1 FROM workspace_runtime_sessions session
        WHERE session.workspace_id = workspace_runtime_messages.workspace_id
          AND session.id = workspace_runtime_messages.session_id
          AND session.room_id IS NOT NULL
          AND samurai_can_room(session.workspace_id, session.room_id, 'execute')
      )`,
      delete: `workspace_id = samurai_current_workspace_id() AND EXISTS (
        SELECT 1 FROM workspace_runtime_sessions session
        WHERE session.workspace_id = workspace_runtime_messages.workspace_id
          AND session.id = workspace_runtime_messages.session_id
          AND session.room_id IS NOT NULL
          AND samurai_can_room(session.workspace_id, session.room_id, 'execute')
      ) AND NOT EXISTS (
        SELECT 1 FROM workspace_runtime_runs run
        WHERE run.workspace_id = workspace_runtime_messages.workspace_id
          AND (run.input_message_id = workspace_runtime_messages.id OR run.output_message_id = workspace_runtime_messages.id)
      )`
    },
    {
      table: "workspace_runtime_operations",
      read: "workspace_id = samurai_current_workspace_id() AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read')",
      write: "workspace_id = samurai_current_workspace_id() AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'execute')"
    },
    {
      table: "workspace_runtime_runs",
      read: "workspace_id = samurai_current_workspace_id() AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read')",
      write: "workspace_id = samurai_current_workspace_id() AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'execute')"
    },
    {
      table: "workspace_runtime_reservations",
      read: `workspace_id = samurai_current_workspace_id() AND EXISTS (
        SELECT 1 FROM workspace_runtime_runs run
        WHERE run.workspace_id = workspace_runtime_reservations.workspace_id
          AND run.id = workspace_runtime_reservations.run_id
          AND run.room_id IS NOT NULL AND samurai_can_room(run.workspace_id, run.room_id, 'read')
      )`,
      write: `workspace_id = samurai_current_workspace_id() AND EXISTS (
        SELECT 1 FROM workspace_runtime_runs run
        WHERE run.workspace_id = workspace_runtime_reservations.workspace_id
          AND run.id = workspace_runtime_reservations.run_id
          AND run.room_id IS NOT NULL AND samurai_can_room(run.workspace_id, run.room_id, 'execute')
      )`
    },
    {
      table: "workspace_runtime_events",
      read: `workspace_id = samurai_current_workspace_id() AND EXISTS (
        SELECT 1 FROM workspace_runtime_runs run
        WHERE run.workspace_id = workspace_runtime_events.workspace_id
          AND run.id = workspace_runtime_events.run_id
          AND run.room_id IS NOT NULL AND samurai_can_room(run.workspace_id, run.room_id, 'read')
      )`,
      write: `workspace_id = samurai_current_workspace_id() AND EXISTS (
        SELECT 1 FROM workspace_runtime_runs run
        WHERE run.workspace_id = workspace_runtime_events.workspace_id
          AND run.id = workspace_runtime_events.run_id
          AND run.room_id IS NOT NULL AND samurai_can_room(run.workspace_id, run.room_id, 'execute')
      )`
    },
    {
      table: "workspace_runtime_changes",
      read: "workspace_id = samurai_current_workspace_id() AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read')",
      write: "workspace_id = samurai_current_workspace_id() AND room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'execute')"
    },
    {
      table: "workspace_runtime_activities",
      read: "workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')",
      write: "workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'execute')"
    },
    {
      table: "workspace_runtime_resource_usage",
      read: `workspace_id = samurai_current_workspace_id() AND EXISTS (
        SELECT 1 FROM workspace_runtime_activities activity
        WHERE activity.workspace_id = workspace_runtime_resource_usage.workspace_id
          AND activity.id = workspace_runtime_resource_usage.activity_id
          AND samurai_can_room(activity.workspace_id, activity.room_id, 'read')
      )`,
      write: `workspace_id = samurai_current_workspace_id() AND EXISTS (
        SELECT 1 FROM workspace_runtime_activities activity
        WHERE activity.workspace_id = workspace_runtime_resource_usage.workspace_id
          AND activity.id = workspace_runtime_resource_usage.activity_id
          AND samurai_can_room(activity.workspace_id, activity.room_id, 'execute')
      )`
    },
    {
      table: "workspace_runtime_resources",
      read: `workspace_id = samurai_current_workspace_id() AND (
        (room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read'))
        OR (room_id IS NULL AND samurai_can_workspace(workspace_id, 'guest'))
      )`,
      write: `workspace_id = samurai_current_workspace_id() AND (
        (room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'edit'))
        OR (room_id IS NULL AND samurai_can_workspace(workspace_id, 'admin'))
      )`
    },
    {
      table: "workspace_runtime_settings",
      read: "workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'guest')",
      write: "workspace_id = samurai_current_workspace_id() AND samurai_can_workspace(workspace_id, 'admin')"
    },
    {
      table: "workspace_runtime_client_events",
      read: `workspace_id = samurai_current_workspace_id() AND (
        (room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read'))
        OR (room_id IS NULL AND samurai_can_workspace(workspace_id, 'guest'))
      )`,
      write: `workspace_id = samurai_current_workspace_id() AND samurai_workspace_is_writable(workspace_id) AND (
        (room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'execute'))
        OR (room_id IS NULL AND samurai_can_workspace(workspace_id, 'execute'))
      )`
    }
  ];
  return policies.flatMap((policy) => [
    `DROP POLICY IF EXISTS ${policy.table}_access ON ${policy.table}`,
    `CREATE POLICY ${policy.table}_select ON ${policy.table} FOR SELECT USING (${policy.read})`,
    `CREATE POLICY ${policy.table}_insert ON ${policy.table} FOR INSERT WITH CHECK (${policy.write})`,
    `CREATE POLICY ${policy.table}_update ON ${policy.table} FOR UPDATE USING (${policy.write}) WITH CHECK (${policy.write})`,
    ...(policy.delete ? [`CREATE POLICY ${policy.table}_delete ON ${policy.table} FOR DELETE USING (${policy.delete})`] : [])
  ]);
}

function runtimeAutomationRlsStatements(): string[] {
  return [
    "ALTER TABLE workspace_runtime_automation_jobs ENABLE ROW LEVEL SECURITY",
    "ALTER TABLE workspace_runtime_automation_jobs FORCE ROW LEVEL SECURITY",
    "ALTER TABLE workspace_runtime_automation_runs ENABLE ROW LEVEL SECURITY",
    "ALTER TABLE workspace_runtime_automation_runs FORCE ROW LEVEL SECURITY",
    `CREATE POLICY workspace_runtime_automation_jobs_access ON workspace_runtime_automation_jobs FOR ALL USING (
      workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')
    ) WITH CHECK (
      workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'edit')
    )`,
    `CREATE POLICY workspace_runtime_automation_runs_access ON workspace_runtime_automation_runs FOR ALL USING (
      workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'read')
    ) WITH CHECK (
      workspace_id = samurai_current_workspace_id() AND samurai_can_room(workspace_id, room_id, 'execute')
    )`
  ];
}

async function grantRuntimeRole(sql: WorkspaceSql, roleName: string): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(roleName)) throw new Error("workspace_server_runtime_role_invalid");
  const role = `"${roleName.replaceAll('"', '""')}"`;
  const tables = [
    "accounts",
    "workspaces",
    "workspace_members",
    "rooms",
    "room_members",
    "workspace_records",
    "workspace_files",
    "workspace_file_transactions",
    "workspace_operations",
    "workspace_events",
    "workspace_jobs",
    "workspace_invitations",
    "workspace_transfers",
    "workspace_bundles",
    "account_operations",
    "workspace_import_sessions",
    "workspace_audit_entries",
    "workspace_learning_activities",
    "workspace_learning_resources",
    "workspace_learning_resource_versions",
    "workspace_learning_evidence",
    "workspace_learning_resource_links",
    "workspace_learning_settings",
    "workspace_learning_jobs",
    "workspace_learning_job_attempts",
    "workspace_learning_resource_uses",
    "workspace_completion_configurations",
    "workspace_completion_activities",
    "workspace_completion_episodes",
    "workspace_completion_episode_activities",
    "workspace_completion_resources",
    "workspace_completion_resource_versions",
    "workspace_completion_skill_files",
    "workspace_completion_evidence",
    "workspace_completion_resource_links",
    "workspace_completion_policy_rules",
    "workspace_completion_policy_change_requests",
    "workspace_completion_uses",
    "workspace_completion_evaluations",
    "workspace_completion_jobs",
    "workspace_completion_job_attempts",
    "workspace_completion_curator_state",
    "workspace_completion_curator_snapshots",
    "workspace_completion_file_batches",
    "workspace_completion_file_batch_entries",
    "workspace_completion_search_projection",
    "workspace_completion_migration_receipts",
    "workspace_completion_migration_runs",
    "workspace_completion_workspace_documents",
    "workspace_completion_job_raw_outputs",
    "workspace_completion_redactions",
    "workspace_completion_maintenance_identities",
    "workspace_completion_policy_approvals",
    "workspace_completion_attestations",
    "workspace_agents",
    "workspace_agent_room_permissions",
    "workspace_connection_descriptors",
    "workspace_runtime_sessions",
    "workspace_runtime_messages",
    "workspace_runtime_operations",
    "workspace_runtime_runs",
    "workspace_runtime_reservations",
    "workspace_runtime_events",
    "workspace_runtime_changes",
    "workspace_runtime_activities",
    "workspace_runtime_resource_usage",
    "workspace_runtime_resources",
    "workspace_runtime_settings",
    "workspace_runtime_client_events",
    "workspace_runtime_automation_jobs",
    "workspace_runtime_automation_runs",
    "workspace_external_integration_records",
    "workspace_gateway_pairing_policies",
    "workspace_gateway_routing_policies",
    "workspace_gateway_pairings",
    "workspace_gateway_inbound_messages",
    "workspace_gateway_deliveries",
    "workspace_gateway_boundary_policies",
    "workspace_gateway_mcp_configs",
    "workspace_gateway_concurrency_locks",
    "workspace_gateway_sandbox_instances",
    "workspace_gateway_sandbox_syncs",
    "workspace_skill_optimization_runs",
    "workspace_skill_optimization_datasets",
    "workspace_skill_optimization_objectives",
    "workspace_skill_optimization_work_items",
    "workspace_skill_optimization_candidates",
    "workspace_skill_optimization_evaluations",
    "workspace_skill_optimization_promotions",
    "workspace_skill_optimization_snapshots",
    "workspace_skill_optimization_locks"
  ];
  // Runtime code may read Room rows through RLS, but hierarchy and direct
  // membership mutations are deliberately restricted to the guarded SQL
  // functions in migrations 22 and 23. Import functions are SECURITY DEFINER and
  // retain the same short-lived import-session check.
  const guardedMutationTables = [
    "workspace_members", "rooms", "room_members", "workspace_agents",
    "workspace_agent_room_permissions", "workspace_connection_descriptors"
  ];
  const writableTables = tables.filter((table) => !guardedMutationTables.includes(table));
  const functions = [
    "samurai_context_value(TEXT)",
    "samurai_current_account_id()",
    "samurai_current_workspace_id()",
    "samurai_is_bootstrap()",
    "samurai_role_rank(TEXT)",
    "samurai_workspace_role(TEXT)",
    "samurai_can_workspace(TEXT, TEXT)",
    "samurai_has_workspace_membership(TEXT)",
    "samurai_room_role(TEXT, TEXT)",
    "samurai_can_room(TEXT, TEXT, TEXT)",
    "samurai_can_agent_room(TEXT, TEXT, TEXT, TEXT)",
    "samurai_workspace_is_writable(TEXT)",
    "samurai_assert_workspace_writable(TEXT)",
    "samurai_is_import_session(TEXT)",
    "samurai_adjust_workspace_learning_usage(TEXT, TEXT, NUMERIC, BIGINT, NUMERIC, BIGINT)",
    "samurai_lock_workspace_learning_settings(TEXT, TEXT)",
    "samurai_create_workspace(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)",
    "samurai_start_workspace_import(TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT)",
    "samurai_complete_workspace_import(TEXT, TEXT, TEXT)",
    "samurai_abort_workspace_import(TEXT, TEXT)",
    "samurai_create_room(TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT)",
    "samurai_move_room(TEXT, TEXT, TEXT, BIGINT, BIGINT, TEXT)",
    "samurai_preview_room_move(TEXT, TEXT, TEXT)",
    "samurai_set_workspace_member(TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT)",
    "samurai_set_room_member_with_impact(TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT)",
    "samurai_register_workspace_agent(TEXT, TEXT, TEXT, TEXT)",
    "samurai_set_workspace_agent_backend(TEXT, TEXT, TEXT)",
    "samurai_set_workspace_agent_room_permission(TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, BIGINT)",
    "samurai_upsert_workspace_connection_descriptor(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], INTEGER, TEXT[], BIGINT)",
    "samurai_preview_room_member_change(TEXT, TEXT, TEXT, TEXT, TEXT)",
    "samurai_accept_invitation(TEXT, TEXT, TEXT)",
    "samurai_revoke_invitation(TEXT, TEXT, BIGINT)",
    "samurai_append_workspace_audit(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, JSONB)",
    "samurai_create_workspace_invitation(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BIGINT)",
    "samurai_list_workspace_account_identities(TEXT)",
    "samurai_import_workspace_account_identity(TEXT, TEXT, TEXT, TEXT, TEXT)",
    "samurai_import_workspace_member(TEXT, TEXT, TEXT, TEXT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ)",
    "samurai_import_workspace_room(TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ)",
    "samurai_import_workspace_room_member(TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ)",
    "samurai_import_workspace_agent(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ)",
    "samurai_import_workspace_agent_room_permission(TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ)",
    "samurai_import_workspace_connection_descriptor(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], INTEGER, TEXT[], BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ)",
    "samurai_validate_workspace_room_hierarchy(TEXT)",
    "samurai_import_workspace_audit(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, JSONB, TIMESTAMPTZ)",
    "samurai_finalize_workspace_file_transaction(TEXT, TEXT)",
    "samurai_begin_workspace_transfer(TEXT, TEXT)",
    "samurai_record_workspace_bundle(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT)",
    "samurai_record_workspace_bundle_v4(TEXT, TEXT, TEXT, TEXT, JSONB)",
    "samurai_record_workspace_bundle_v4_transfer(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT)",
    "samurai_repair_workspace_bundle_v4_legacy_ledger(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT)",
    "samurai_fail_workspace_transfer(TEXT, TEXT, TEXT)",
    "samurai_rollback_workspace_transfer(TEXT, TEXT)",
    "samurai_record_workspace_transfer_receipt(TEXT, TEXT, TEXT, JSONB)",
    "samurai_complete_workspace_transfer(TEXT, TEXT)",
    "samurai_record_import_bundle(TEXT, TEXT, TEXT, TEXT, JSONB)",
    "samurai_reopen_workspace_import(TEXT, TEXT, TEXT)",
    "samurai_redact_completion_resource(TEXT, TEXT, TEXT, TEXT)",
    "samurai_rollback_completion_legacy_migration(TEXT, TEXT)",
    "samurai_completion_migration_write_allowed(TEXT)",
    "samurai_begin_completion_migration_run(TEXT, TEXT, TEXT)",
    "samurai_transition_completion_migration_run(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT)",
    "samurai_configure_completion_maintenance_identity(TEXT, TEXT)",
    "samurai_is_completion_maintenance_identity(TEXT)",
    "samurai_list_completion_maintenance_identities()",
    "samurai_external_integration_enabled()",
    "samurai_external_connection_descriptor(TEXT, TEXT)",
    "similarity(TEXT, TEXT)"
  ];
  const legacyFunctions = [
    "samurai_create_room(TEXT, TEXT, TEXT, BIGINT)",
    "samurai_create_room(TEXT, TEXT, TEXT)",
    "samurai_create_room(TEXT, TEXT, TEXT, TEXT, BIGINT)",
    "samurai_move_room(TEXT, TEXT, TEXT, BIGINT, BIGINT)",
    "samurai_set_workspace_member(TEXT, TEXT, TEXT, TEXT, BIGINT)",
    "samurai_set_room_member_with_impact(TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT)",
    "samurai_set_workspace_member(TEXT, TEXT, TEXT, TEXT)",
    "samurai_set_room_member(TEXT, TEXT, TEXT, TEXT, TEXT)",
    "samurai_set_room_member(TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT)",
    "samurai_accept_invitation(TEXT, TEXT)",
    "samurai_rollback_completion_legacy_migration_v35(TEXT, TEXT)"
  ];
  await sql.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  // The long-running process checks migration status at boot, but only the
  // short-lived admin command may alter the migration ledger.
  await sql.query(`GRANT SELECT ON TABLE samurai_server_schema_migrations TO ${role}`);
  await sql.query(`REVOKE INSERT, UPDATE, DELETE ON TABLE samurai_server_schema_migrations FROM ${role}`);
  await sql.query(`GRANT SELECT ON TABLE ${tables.join(", ")} TO ${role}`);
  await sql.query(`GRANT INSERT, UPDATE, DELETE ON TABLE ${writableTables.join(", ")} TO ${role}`);
  await sql.query(`REVOKE DELETE ON TABLE workspace_learning_activities, workspace_learning_resource_versions, workspace_learning_evidence, workspace_learning_resource_links, workspace_learning_jobs, workspace_learning_job_attempts, workspace_learning_resource_uses, workspace_completion_activities, workspace_completion_episode_activities, workspace_completion_resource_versions, workspace_completion_skill_files, workspace_completion_evidence, workspace_completion_resource_links, workspace_completion_policy_rules, workspace_completion_policy_change_requests, workspace_completion_uses, workspace_completion_evaluations, workspace_completion_job_attempts, workspace_completion_file_batch_entries, workspace_completion_migration_receipts, workspace_completion_migration_runs, workspace_completion_policy_approvals, workspace_completion_attestations FROM ${role}`);
  await sql.query(`REVOKE UPDATE ON TABLE workspace_completion_activities, workspace_completion_episode_activities, workspace_completion_evidence, workspace_completion_resource_links, workspace_completion_policy_rules, workspace_completion_policy_change_requests, workspace_completion_uses, workspace_completion_evaluations, workspace_completion_file_batch_entries, workspace_completion_migration_receipts, workspace_completion_migration_runs, workspace_completion_policy_approvals, workspace_completion_attestations FROM ${role}`);
  await sql.query(`REVOKE INSERT ON TABLE workspace_completion_migration_runs FROM ${role}`);
  await sql.query(`REVOKE INSERT, UPDATE, DELETE ON TABLE ${guardedMutationTables.join(", ")} FROM ${role}`);
  await sql.query(`GRANT USAGE ON SEQUENCE workspace_events_id_seq TO ${role}`);
  await sql.query(`GRANT EXECUTE ON FUNCTION ${functions.join(", ")} TO ${role}`);
  for (const legacyFunction of legacyFunctions) {
    await sql.query(`REVOKE EXECUTE ON FUNCTION ${legacyFunction} FROM ${role}`).catch(() => undefined);
  }
  await sql.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${role}`);
  await sql.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${role}`);
  await sql.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM ${role}`);
}

function migrationChecksum(migration: WorkspaceServerMigration): string {
  return createHash("sha256").update(JSON.stringify({ name: migration.name, statements: migration.statements })).digest("hex");
}

export type WorkspaceServerSchemaQueryRow = QueryResultRow;
