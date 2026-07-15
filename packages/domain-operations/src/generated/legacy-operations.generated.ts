// Deprecated operation metadata and the bounded collection compatibility contract.
export const deprecatedOperations = [
  {
    "id": "workspace.delete",
    "title": "Request workspace delete",
    "description": "Prepare a delete operation for a workspace resource.",
    "contractVersion": "1.0",
    "replacement": { "kind": "effective_inventory", "target": "/api/domain/commands/effective" }
  },
  {
    "id": "approval.approve",
    "title": "Approve request",
    "description": "Approve a pending owner decision request.",
    "contractVersion": "1.0",
    "replacement": { "kind": "effective_inventory", "target": "/api/domain/commands/effective" }
  },
  {
    "id": "approval.deny",
    "title": "Deny request",
    "description": "Deny a pending owner decision request.",
    "contractVersion": "1.0",
    "replacement": { "kind": "effective_inventory", "target": "/api/domain/commands/effective" }
  },
  {
    "id": "grant.create",
    "title": "Create grant",
    "description": "Create an owner-scoped grant for a capability operation.",
    "contractVersion": "1.0",
    "replacement": { "kind": "effective_inventory", "target": "/api/domain/commands/effective" }
  },
  {
    "id": "grant.revoke",
    "title": "Revoke grant",
    "description": "Revoke an existing capability grant.",
    "contractVersion": "1.0",
    "replacement": { "kind": "effective_inventory", "target": "/api/domain/commands/effective" }
  }
] as const;
export const collectionManageCompatibility = {
  "id": "collection.manage",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "action": {
        "enum": [
          "getItems",
          "putItems",
          "schemaDocs",
          "getSchema",
          "putSchema",
          "patchSchema"
        ]
      },
      "collection_id": {
        "type": "string"
      },
      "envelope_id": {
        "type": "string"
      },
      "fields": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "ids": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "input_locale": {
        "type": "string"
      },
      "input_message_id": {
        "type": "string"
      },
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": {}
        }
      },
      "metadata": {
        "type": "object",
        "additionalProperties": {}
      },
      "mode": {
        "enum": [
          "create",
          "upsert",
          "merge"
        ]
      },
      "output_locale": {
        "type": "string"
      },
      "patches": {
        "type": "array",
        "items": {}
      },
      "provider_tool_call": {
        "type": "boolean"
      },
      "schema": {
        "type": "object",
        "additionalProperties": {}
      },
      "session_id": {
        "type": "string"
      },
      "slug": {
        "type": "string"
      },
      "source_operation_id": {
        "type": "string"
      },
      "surface_operation_id": {
        "type": "string"
      },
      "view_id": {
        "type": "string"
      }
    },
    "required": [
      "action"
    ]
  }
} as const;
