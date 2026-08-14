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
  }
];

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
    "workspace_audit_entries"
  ];
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
    "samurai_workspace_is_writable(TEXT)",
    "samurai_assert_workspace_writable(TEXT)",
    "samurai_is_import_session(TEXT)",
    "samurai_create_workspace(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)",
    "samurai_start_workspace_import(TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT)",
    "samurai_complete_workspace_import(TEXT, TEXT, TEXT)",
    "samurai_abort_workspace_import(TEXT, TEXT)",
    "samurai_create_room(TEXT, TEXT, TEXT, BIGINT)",
    "samurai_set_workspace_member(TEXT, TEXT, TEXT, TEXT, BIGINT)",
    "samurai_set_room_member(TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT)",
    "samurai_accept_invitation(TEXT, TEXT)",
    "samurai_revoke_invitation(TEXT, TEXT, BIGINT)",
    "samurai_append_workspace_audit(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, JSONB)",
    "samurai_create_workspace_invitation(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BIGINT)",
    "samurai_list_workspace_account_identities(TEXT)",
    "samurai_import_workspace_account_identity(TEXT, TEXT, TEXT, TEXT, TEXT)",
    "samurai_import_workspace_audit(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, JSONB, TIMESTAMPTZ)",
    "samurai_finalize_workspace_file_transaction(TEXT, TEXT)",
    "samurai_begin_workspace_transfer(TEXT, TEXT)",
    "samurai_record_workspace_bundle(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT)",
    "samurai_fail_workspace_transfer(TEXT, TEXT, TEXT)",
    "samurai_rollback_workspace_transfer(TEXT, TEXT)",
    "samurai_record_workspace_transfer_receipt(TEXT, TEXT, TEXT, JSONB)",
    "samurai_complete_workspace_transfer(TEXT, TEXT)",
    "samurai_record_import_bundle(TEXT, TEXT, TEXT, TEXT, JSONB)",
    "similarity(TEXT, TEXT)"
  ];
  const legacyFunctions = [
    "samurai_create_room(TEXT, TEXT, TEXT)",
    "samurai_set_workspace_member(TEXT, TEXT, TEXT, TEXT)",
    "samurai_set_room_member(TEXT, TEXT, TEXT, TEXT, TEXT)"
  ];
  await sql.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  // The long-running process checks migration status at boot, but only the
  // short-lived admin command may alter the migration ledger.
  await sql.query(`GRANT SELECT ON TABLE samurai_server_schema_migrations TO ${role}`);
  await sql.query(`REVOKE INSERT, UPDATE, DELETE ON TABLE samurai_server_schema_migrations FROM ${role}`);
  await sql.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${tables.join(", ")} TO ${role}`);
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
