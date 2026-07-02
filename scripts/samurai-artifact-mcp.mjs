#!/usr/bin/env node

const artifactInputSchema = {
  type: "object",
  required: ["title", "content"],
  properties: {
    title: { type: "string", description: "Artifact title shown in Samurai." },
    content: { type: "string", description: "Complete Artifact body." },
    kind: {
      type: "string",
      enum: ["markdown", "document", "table", "chart", "structured_draft", "generated_report", "note"],
      description: "Optional Artifact kind. Markdown is the default path in v1."
    },
    metadata: { type: "object", description: "Optional non-secret metadata." }
  }
};

const searchInputSchema = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", description: "Search query." },
    limit: { type: "number", description: "Maximum result count." }
  }
};

const tools = [{
  name: "artifact_create",
  bridgeName: "samurai.artifact.create",
  description: "Create a Samurai workspace Artifact from generated user-facing content.",
  inputSchema: artifactInputSchema
}, {
  name: "session_search",
  bridgeName: "samurai.session.search",
  description: "Search previous Samurai sessions without prompt injection.",
  inputSchema: searchInputSchema
}, {
  name: "memory_search",
  bridgeName: "samurai.memory.search",
  description: "Search accepted Samurai Memory entries by topic.",
  inputSchema: searchInputSchema
}, {
  name: "wiki_search",
  bridgeName: "samurai.wiki.search",
  description: "Search active Samurai Knowledge Wiki pages.",
  inputSchema: searchInputSchema
}, {
  name: "skill_search",
  bridgeName: "samurai.skill.search",
  description: "Search Samurai Skill catalog refs.",
  inputSchema: searchInputSchema
}];

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainMessages();
});

process.stdin.on("error", (error) => {
  writeLog(`stdin error: ${error.message}`);
});

function drainMessages() {
  while (buffer.length > 0) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) {
        return;
      }
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      handleMessageBody(body);
      continue;
    }

    const lineEnd = buffer.indexOf("\n");
    if (lineEnd < 0) {
      return;
    }
    const line = buffer.subarray(0, lineEnd).toString("utf8").trim();
    buffer = buffer.subarray(lineEnd + 1);
    if (line) {
      handleMessageBody(line);
    }
  }
}

function handleMessageBody(body) {
  let request;
  try {
    request = JSON.parse(body);
  } catch (error) {
    writeError(null, -32700, `Invalid JSON: ${error.message}`);
    return;
  }
  handleRequest(request).catch((error) => {
    writeError(request?.id ?? null, -32000, error instanceof Error ? error.message : String(error));
  });
}

async function handleRequest(request) {
  if (!request || typeof request !== "object") {
    writeError(null, -32600, "Invalid request");
    return;
  }
  if (request.method === "notifications/initialized" || request.id === undefined || request.id === null) {
    return;
  }
  if (request.method === "initialize") {
    writeResult(request.id, {
      protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "samurai-artifact-bridge", version: "0.1.0" }
    });
    return;
  }
  if (request.method === "tools/list") {
    writeResult(request.id, {
      tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    });
    return;
  }
  if (request.method === "tools/call") {
    const params = request.params ?? {};
    const tool = tools.find((item) => item.name === params.name || item.bridgeName === params.name);
    if (!tool) {
      writeError(request.id, -32602, `Unknown tool: ${params.name ?? "unknown"}`);
      return;
    }
    const result = await callBridgeTool(tool, params.arguments ?? {}, request.id);
    writeResult(request.id, {
      content: [{ type: "text", text: bridgeResultText(tool, result) }],
      structuredContent: result
    });
    return;
  }
  writeError(request.id, -32601, `Method not found: ${request.method}`);
}

async function callBridgeTool(tool, args, requestId) {
  const endpoint = requiredEnv("SAMURAI_TOOL_BRIDGE_URL");
  const token = requiredEnv("SAMURAI_TOOL_BRIDGE_TOKEN");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      tool_name: tool.bridgeName,
      tool_call_id: `mcp_${String(requestId)}`,
      input: tool.bridgeName === "samurai.artifact.create" ? sanitizeArtifactInput(args) : sanitizeSearchInput(args)
    })
  });
  const text = await response.text();
  const parsed = text ? safeJson(text) : {};
  if (!response.ok) {
    throw new Error(`Samurai tool bridge failed (${response.status}): ${typeof parsed.error === "string" ? parsed.error : text}`);
  }
  return parsed;
}

function bridgeResultText(tool, result) {
  if (tool.bridgeName === "samurai.artifact.create") {
    return `Artifact created: ${result.title ?? result.artifact_id ?? "created"}`;
  }
  const output = Array.isArray(result.output) ? result.output : [];
  return `${tool.name} returned ${output.length} result(s).`;
}

function sanitizeArtifactInput(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Tool input must be an object.");
  }
  const title = typeof args.title === "string" ? args.title.trim() : "";
  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (!title || !content) {
    throw new Error("Both title and content are required.");
  }
  return {
    title,
    content,
    ...(typeof args.kind === "string" ? { kind: args.kind } : {}),
    ...(args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata) ? { metadata: args.metadata } : {})
  };
}

function sanitizeSearchInput(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Tool input must be an object.");
  }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    throw new Error("query is required.");
  }
  const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.min(Math.floor(args.limit), 8)) : undefined;
  return {
    query,
    ...(limit ? { limit } : {})
  };
}

function requiredEnv(key) {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function writeResult(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeError(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function writeLog(message) {
  process.stderr.write(`[samurai-artifact-mcp] ${message}\n`);
}
