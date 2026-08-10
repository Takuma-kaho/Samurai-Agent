import type { JsonColumn } from "./json-column";

/** Secret-free Core09 Connection metadata only. */
export interface ExternalAppConnectionsTable {
  id: string;
  workspace_id: string;
  connector_id: string;
  app_id: string;
  status: string;
  delegated_principal_json: JsonColumn;
  non_secret_metadata_json: JsonColumn;
  created_by_json: JsonColumn;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface ExternalAppConnectionRoomsTable {
  connection_id: string;
  room_id: string;
}

export interface ExternalAppConnectionIngressClassesTable {
  connection_id: string;
  ingress_class: string;
}
