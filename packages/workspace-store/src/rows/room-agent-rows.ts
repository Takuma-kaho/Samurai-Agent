export interface RoomsTable { id: string; name: string; created_at: string; updated_at: string; }

export interface AgentsTable {
  id: string;
  name: string;
  role: string;
  instructions: string;
  backend_id: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}
