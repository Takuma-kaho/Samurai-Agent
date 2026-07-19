import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  approvePairing,
  createDefaultGatewayPairingPolicy,
  createDefaultGatewayRoutingPolicy,
  createSandboxCommandAdapter,
  createSecretResolutionBundle,
  createSandboxExecutionPlan,
  createDefaultGatewayBoundaryPolicy,
  createCronMemoryReviewEnvelope,
  createGatewayEnvelope,
  createGatewayInboundMessage,
  createHttpMcpToolAdapter,
  createLocalCliEnvelope,
  createPendingPairing,
  createPooledStdioMcpToolAdapter,
  createSandboxLifecycleAdapter,
  createSandboxWorkspaceSyncAdapter,
  createStdioMcpToolAdapter,
  executeSandboxCommand,
  executeSandboxLifecycleAction,
  executeMcpToolInvocation,
  executeSandboxWorkspaceSync,
  gatewayMcpConfigToBoundaryRef,
  gatewayContextForPairing,
  evaluateGatewayPairingPolicy,
  inspectSandboxExecutorCapabilities,
  localCliGatewayContext,
  materializeSecretFiles,
  createWebEnvelope,
  normalizeGatewayWorkspacePath,
  planMcpToolInvocation,
  resolveSecretRefs,
  revokePairing,
  resolveGatewaySessionRouting,
  rotatePairingCode,
  routeSession,
  httpMcpServerConfigFromGatewayConfig,
  stdioMcpServerConfigFromGatewayConfig,
  summarizeGatewayMcpConfig,
  sessionKeyForExternalSource
} from "./index";

describe("gateway", () => {
  it("creates fixed web, local cli, and cron contexts", () => {
    const web = createWebEnvelope("hello");
    const local = createLocalCliEnvelope("local action", "project/main");
    const cron = createCronMemoryReviewEnvelope();

    expect(web).toMatchObject({
      source: "web",
      actor_identity: "owner",
      session_key: "web:owner:main",
      metadata: {
        source: "web",
        actor_identity: "owner",
        instruction_source: "owner_instruction",
        channel: "web",
        session_key: "web:owner:main"
      }
    });
    expect(cron).toMatchObject({
      source: "cron",
      actor_identity: "owner_scheduled",
      session_key: "cron:owner_scheduled:memory-review",
      metadata: {
        source: "cron",
        actor_identity: "owner_scheduled",
        instruction_source: "scheduled_context",
        channel: "cron",
        session_key: "cron:owner_scheduled:memory-review"
      }
    });
    expect(local).toMatchObject({
      source: "local_cli",
      actor_identity: "owner",
      session_key: "local_cli:owner:project~2Fmain",
      metadata: {
        source: "local_cli",
        actor_identity: "owner",
        instruction_source: "owner_instruction",
        channel: "local_cli",
        session_key: "local_cli:owner:project~2Fmain"
      }
    });
    expect(localCliGatewayContext("project/main").session_key).toBe("local_cli:owner:project~2Fmain");
    expect(routeSession({ source: "web", identity: "owner" })).toBe("web:owner:main");
    expect(sessionKeyForExternalSource({
      channel: "webhook",
      source_identity: "source/1",
      route: "thread 1"
    })).toBe("webhook:source~2F1:thread~201");
    expect(sessionKeyForExternalSource({
      channel: "webhook",
      source_identity: "bot",
      account_id: "account/1",
      thread_id: "thread:2"
    })).toBe("webhook:account~2F1:thread~3A2");
  });

  it("redacts secret-like envelope metadata", () => {
    const envelope = createGatewayEnvelope({
      source: "web",
      actor_identity: "owner",
      instruction_source: "owner_instruction",
      channel: "web",
      session_key: "web:owner:main"
    }, "hello", "ja", "ja", {
      api_key: "raw-api-key",
      nested: {
        authorization: "Bearer raw-token",
        note: "key=raw-key"
      }
    });

    expect(JSON.stringify(envelope.metadata)).not.toContain("raw-api-key");
    expect(JSON.stringify(envelope.metadata)).not.toContain("raw-token");
    expect(envelope.metadata.api_key).toBe("[redacted]");
    expect((envelope.metadata.nested as { authorization?: string }).authorization).toBe("[redacted]");
    expect((envelope.metadata.nested as { note?: string }).note).toBe("key=[redacted]");
  });

  it("blocks unpaired external input and routes approved sources", () => {
    const pending = createPendingPairing({
      channel: "webhook",
      source_identity: "source-1",
      source_label: "Source 1"
    }, "2026-01-01T00:00:00.000Z");

    const blocked = createGatewayInboundMessage({
      channel: "webhook",
      source_identity: "source-1",
      body: "hello",
      pairing: pending,
      now: "2026-01-01T00:00:01.000Z"
    });
    const routed = createGatewayInboundMessage({
      channel: "webhook",
      source_identity: "source-1",
      body: "hello",
      pairing: approvePairing(pending, "2026-01-01T00:00:02.000Z"),
      now: "2026-01-01T00:00:03.000Z"
    });

    expect(blocked).toMatchObject({ status: "blocked", trusted: false });
    expect(routed).toMatchObject({
      status: "routed",
      trusted: true,
      session_key: "webhook:source-1:main"
    });
    expect(gatewayContextForPairing(approvePairing(pending, "2026-01-01T00:00:02.000Z"))).toMatchObject({
      source: "webhook",
      actor_identity: "paired_contact",
      instruction_source: "paired_identity_message",
      channel: "webhook",
      session_key: "webhook:source-1:main"
    });
  });

  it("evaluates channel pairing policies before trusting external sources", () => {
    const webhookPolicy = createDefaultGatewayPairingPolicy("webhook", "2026-01-01T00:00:00.000Z");
    const slackPolicy = createDefaultGatewayPairingPolicy("slack", "2026-01-01T00:00:00.000Z");
    const localPolicy = createDefaultGatewayPairingPolicy("local_cli", "2026-01-01T00:00:00.000Z");
    const blockedPolicy = {
      ...webhookPolicy,
      trust_mode: "blocked" as const
    };
    const scopedPolicy = {
      ...webhookPolicy,
      allowlist: ["webhook:allowed-source"]
    };

    expect(evaluateGatewayPairingPolicy(webhookPolicy, {
      channel: "webhook",
      source_identity: "any-source"
    })).toMatchObject({
      allowed: true,
      trusted_without_pairing: false,
      allowlist_snapshot: ["*"],
      pairing_ttl_ms: 300_000
    });
    expect(evaluateGatewayPairingPolicy(slackPolicy, {
      channel: "slack",
      source_identity: "workspace:T123/user:U456"
    })).toMatchObject({
      allowed: true,
      trusted_without_pairing: false
    });
    expect(evaluateGatewayPairingPolicy(localPolicy, {
      channel: "local_cli",
      source_identity: "owner-cli"
    })).toMatchObject({
      allowed: true,
      trusted_without_pairing: true
    });
    expect(evaluateGatewayPairingPolicy(blockedPolicy, {
      channel: "webhook",
      source_identity: "any-source"
    })).toMatchObject({
      allowed: false,
      reason: "policy_blocked"
    });
    expect(evaluateGatewayPairingPolicy(scopedPolicy, {
      channel: "webhook",
      source_identity: "blocked-source"
    })).toMatchObject({
      allowed: false,
      reason: "source_not_allowed"
    });
  });

  it("resolves gateway session routing from channel policies", () => {
    const defaultPolicy = createDefaultGatewayRoutingPolicy("webhook", "2026-01-01T00:00:00.000Z");
    const emailPolicy = createDefaultGatewayRoutingPolicy("email", "2026-01-01T00:00:00.000Z");
    const accountMainPolicy = {
      ...defaultPolicy,
      session_key_strategy: "account_main" as const
    };
    const channelMainPolicy = {
      ...defaultPolicy,
      session_key_strategy: "channel_main" as const
    };

    expect(resolveGatewaySessionRouting(defaultPolicy, {
      channel: "webhook",
      source_identity: "source/1",
      account_id: "account/1",
      thread_id: "thread:2",
      route: "ignored"
    })).toMatchObject({
      allowed: true,
      session_key: "webhook:account~2F1:thread~3A2",
      session_key_strategy: "account_thread"
    });
    expect(resolveGatewaySessionRouting(accountMainPolicy, {
      channel: "webhook",
      source_identity: "source/1",
      account_id: "account/1",
      thread_id: "thread:2",
      route: "ignored"
    })).toMatchObject({
      allowed: true,
      session_key: "webhook:account~2F1:main",
      thread_id: "main",
      session_key_strategy: "account_main"
    });
    expect(resolveGatewaySessionRouting(channelMainPolicy, {
      channel: "webhook",
      source_identity: "source/1",
      account_id: "account/1",
      thread_id: "thread:2"
    })).toMatchObject({
      allowed: true,
      session_key: "webhook:channel:main",
      account_id: "channel",
      session_key_strategy: "channel_main"
    });
    expect(resolveGatewaySessionRouting(emailPolicy, {
      channel: "email",
      source_identity: "sender@example.com",
      thread_id: "message-123"
    })).toMatchObject({
      allowed: true,
      session_key: "email:sender~40example.com:message-123",
      session_key_strategy: "account_thread"
    });
  });

  it("rotates pending pairing codes and records revocation metadata", () => {
    const pending = createPendingPairing({
      channel: "webhook",
      source_identity: "source-rotate"
    }, "2026-01-01T00:00:00.000Z");
    const rotated = rotatePairingCode(pending, "2026-01-01T00:01:00.000Z");
    const revoked = revokePairing(approvePairing(rotated, "2026-01-01T00:02:00.000Z"), "2026-01-01T00:03:00.000Z");

    expect(rotated.status).toBe("pending");
    expect(rotated.pairing_code).toBeTruthy();
    expect(rotated.pairing_code).not.toBe(pending.pairing_code);
    expect(rotated.expires_at).toBe("2026-01-01T00:06:00.000Z");
    expect(revoked).toMatchObject({
      status: "revoked",
      pairing_code: undefined,
      revoked_at: "2026-01-01T00:03:00.000Z",
      resolved_at: "2026-01-01T00:02:00.000Z"
    });
  });

  it("creates a default external boundary policy for routed sources", () => {
    const boundary = createDefaultGatewayBoundaryPolicy({
      source_channel: "webhook",
      source_identity: "source-1",
      session_key: "webhook:source-1:main",
      allowed_tools: ["collection.record.create"],
      allowlist: ["webhook:source-1"],
      now: "2026-01-01T00:00:00.000Z"
    });

    expect(boundary).toMatchObject({
      source_channel: "webhook",
      source_identity: "source-1",
      session_key: "webhook:source-1:main",
      allowed_tools: ["collection.record.create"],
      sandbox: {
        mode: "non_main",
        scope: "session",
        workspace_access: "none",
        network_access: "none"
      },
      concurrency_lock: {
        scope: "session",
        key: "webhook:source-1:main"
      }
    });
  });

  it("normalizes gateway workspace paths without escaping the workspace", () => {
    expect(normalizeGatewayWorkspacePath("artifacts/../memory/note.md")).toBe("memory/note.md");
    expect(() => normalizeGatewayWorkspacePath("../secret.txt")).toThrow("gateway_path_outside_workspace");
    expect(() => normalizeGatewayWorkspacePath("/etc/passwd")).toThrow("gateway_absolute_path_not_allowed");
  });

  it("reports sandbox executor capability diagnostics without contacting remote targets", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnProbe = ((command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === "docker") {
        const error = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
        return { error, status: null, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "OpenSSH_9.9" };
    }) as unknown as typeof import("node:child_process").spawnSync;

    const statuses = inspectSandboxExecutorCapabilities({ spawnProbe });

    expect(statuses).toContainEqual(expect.objectContaining({
      backend: "none",
      available: true,
      reason: "host_process"
    }));
    expect(statuses).toContainEqual(expect.objectContaining({
      backend: "docker",
      available: false,
      reason: "command_not_found"
    }));
    expect(statuses).toContainEqual(expect.objectContaining({
      backend: "ssh",
      available: true,
      reason: "command_available",
      detail: "OpenSSH_9.9"
    }));
    expect(statuses).toContainEqual(expect.objectContaining({
      backend: "remote",
      available: true,
      command: "ssh"
    }));
    expect(calls).toHaveLength(3);
    expect(calls).toEqual(expect.arrayContaining([
      { command: "docker", args: ["--version"] },
      { command: "ssh", args: ["-V"] }
    ]));
  });

  it("executes sandbox commands through the host adapter and redacts SecretRef material", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "samurai-sandbox-host-"));
    const boundary = {
      ...createDefaultGatewayBoundaryPolicy({
        source_channel: "webhook",
        source_identity: "source-sandbox",
        session_key: "webhook:source-sandbox:main"
      }),
      secret_refs: [{
        id: "secret_exec",
        source: "env" as const,
        provider: "test",
        key: "EXEC_TOKEN"
      }],
      sandbox: {
        mode: "all" as const,
        scope: "session" as const,
        backend: "none" as const,
        workspace_access: "read" as const,
        network_access: "none" as const,
        allowed_paths: [],
        denied_paths: [],
        timeout_ms: 2000,
        metadata: {}
      }
    };

    const result = await executeSandboxCommand(
      boundary,
      {
        command: process.execPath,
        args: ["-e", "console.log(process.env.SECRET_VALUE)"],
        secret_env: { SECRET_VALUE: "secret_exec" }
      },
      createSandboxCommandAdapter(),
      {
        workspaceRoot,
        env: { EXEC_TOKEN: "sandbox-secret" }
      }
    );

    expect(result).toMatchObject({
      status: "completed",
      resolved_secret_ref_ids: ["secret_exec"],
      stdout: "[redacted:secret_exec]\n"
    });
    expect(JSON.stringify(result)).not.toContain("sandbox-secret");
    expect(JSON.stringify(result)).not.toContain("EXEC_TOKEN");
  });

  it("builds docker sandbox command invocations with workspace and secret mounts", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "samurai-sandbox-docker-"));
    let captured: { command: string; args: string[] } | undefined;
    const fakeSpawn = ((command: string, args: string[]) => {
      captured = { command, args };
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: PassThrough;
        kill(signal?: NodeJS.Signals): boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.write("used docker-secret");
        child.stdout.end();
        child.emit("close", 0, null);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const boundary = {
      ...createDefaultGatewayBoundaryPolicy({
        source_channel: "webhook",
        source_identity: "source-docker",
        session_key: "webhook:source-docker:main"
      }),
      secret_refs: [{
        id: "secret_docker",
        source: "env" as const,
        provider: "test",
        key: "DOCKER_TOKEN"
      }],
      sandbox: {
        mode: "all" as const,
        scope: "session" as const,
        backend: "docker" as const,
        workspace_access: "read_write" as const,
        network_access: "none" as const,
        allowed_paths: [],
        denied_paths: [],
        timeout_ms: 2000,
        metadata: { docker_image: "samurai-test-sandbox:latest" }
      }
    };

    const result = await executeSandboxCommand(
      boundary,
      {
        command: "node",
        args: ["tool.js"],
        cwd: "tools",
        env: { PLAIN: "1" },
        secret_env: { TOKEN: "secret_docker" },
        secret_files: [{ secret_ref_id: "secret_docker", filename: "token.txt", env: "TOKEN_FILE" }]
      },
      createSandboxCommandAdapter({ spawnProcess: fakeSpawn }),
      {
        workspaceRoot,
        env: { DOCKER_TOKEN: "docker-secret" }
      }
    );

    expect(result.status).toBe("completed");
    expect(result.stdout).toBe("used [redacted:secret_docker]");
    expect(captured?.command).toBe("docker");
    expect(captured?.args).toEqual(expect.arrayContaining([
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${path.resolve(workspaceRoot)}:/workspace:rw`,
      "-w",
      "/workspace/tools",
      "--env",
      "PLAIN=1",
      "--env",
      "TOKEN=docker-secret",
      "samurai-test-sandbox:latest",
      "node",
      "tool.js"
    ]));
    expect(captured?.args.some((arg) => arg.startsWith(`${tmpdir()}/`) && arg.endsWith(":/run/samurai-secrets:ro"))).toBe(true);
    expect(captured?.args.some((arg) => arg.startsWith("TOKEN_FILE=/run/samurai-secrets/"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("docker-secret");
    expect(JSON.stringify(result)).not.toContain("DOCKER_TOKEN");
  });

  it("builds ssh sandbox command invocations with remote SecretRef files", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "samurai-sandbox-ssh-"));
    let captured: { command: string; args: string[]; stdin: string } | undefined;
    const fakeSpawn = ((command: string, args: string[]) => {
      captured = { command, args, stdin: "" };
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: PassThrough;
        kill(signal?: NodeJS.Signals): boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => true;
      child.stdin.on("data", (chunk) => {
        if (captured) {
          captured.stdin += String(chunk);
        }
      });
      child.stdin.on("finish", () => {
        child.stdout.write("used ssh-secret");
        child.stdout.end();
        child.emit("close", 0, null);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const boundary = {
      ...createDefaultGatewayBoundaryPolicy({
        source_channel: "webhook",
        source_identity: "source-ssh",
        session_key: "webhook:source-ssh:main"
      }),
      secret_refs: [{
        id: "secret_ssh",
        source: "env" as const,
        provider: "test",
        key: "SSH_TOKEN"
      }],
      sandbox: {
        mode: "all" as const,
        scope: "session" as const,
        backend: "ssh" as const,
        workspace_access: "read_write" as const,
        network_access: "none" as const,
        allowed_paths: [],
        denied_paths: [],
        timeout_ms: 2000,
        metadata: {
          ssh_target: "agent@example.test",
          remote_workspace_root: "/srv/samurai/workspace"
        }
      }
    };

    const result = await executeSandboxCommand(
      boundary,
      {
        command: "node",
        args: ["tool.js"],
        cwd: "tools",
        env: { PLAIN: "1" },
        secret_env: { TOKEN: "secret_ssh" },
        secret_files: [{ secret_ref_id: "secret_ssh", filename: "token.txt", env: "TOKEN_FILE" }]
      },
      createSandboxCommandAdapter({ spawnProcess: fakeSpawn }),
      {
        workspaceRoot,
        env: { SSH_TOKEN: "ssh-secret" }
      }
    );

    expect(result.status).toBe("completed");
    expect(result.stdout).toBe("used [redacted:secret_ssh]");
    expect(captured?.command).toBe("ssh");
    expect(captured?.args).toEqual(["agent@example.test", "sh -s"]);
    expect(JSON.stringify(captured?.args)).not.toContain("ssh-secret");
    expect(captured?.stdin).toContain('SAMURAI_SECRET_DIR=$(mktemp -d "${TMPDIR:-/tmp}/samurai-gateway-secrets.XXXXXX")');
    expect(captured?.stdin).toContain("cleanup() { rm -rf \"$SAMURAI_SECRET_DIR\"; }");
    expect(captured?.stdin).toContain("TOKEN_FILE=\"$SAMURAI_SECRET_DIR/token.txt\"");
    expect(captured?.stdin).toContain("cd '/srv/samurai/workspace/tools'");
    expect(captured?.stdin).toContain("'node' 'tool.js'");
    expect(JSON.stringify(result)).not.toContain("ssh-secret");
    expect(JSON.stringify(result)).not.toContain("SSH_TOKEN");
  });

  it("syncs sandbox workspaces through the local sync transport", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "samurai-sandbox-sync-workspace-"));
    const remoteRoot = await mkdtemp(path.join(tmpdir(), "samurai-sandbox-sync-remote-"));
    await writeFile(path.join(workspaceRoot, "note.txt"), "hello sandbox sync");
    const boundary = {
      ...createDefaultGatewayBoundaryPolicy({
        source_channel: "webhook",
        source_identity: "source-sync",
        session_key: "webhook:source-sync:main"
      }),
      sandbox: {
        mode: "all" as const,
        scope: "session" as const,
        backend: "ssh" as const,
        workspace_access: "read_write" as const,
        network_access: "none" as const,
        allowed_paths: [],
        denied_paths: [],
        timeout_ms: 2000,
        metadata: { workspace_sync_transport: "local" }
      }
    };

    const result = await executeSandboxWorkspaceSync(
      boundary.sandbox,
      {
        direction: "seed_to_sandbox",
        workspace_root: workspaceRoot,
        remote_workspace_root: remoteRoot
      },
      createSandboxWorkspaceSyncAdapter()
    );

    expect(result).toMatchObject({
      status: "completed",
      direction: "seed_to_sandbox",
      file_count: expect.any(Number),
      remote_workspace_root: remoteRoot
    });
    expect(await readFile(path.join(remoteRoot, "note.txt"), "utf8")).toBe("hello sandbox sync");
  });

  it("builds rsync sandbox workspace sync invocations for ssh backends", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "samurai-sandbox-rsync-"));
    let captured: { command: string; args: string[] } | undefined;
    const fakeSpawn = ((command: string, args: string[]) => {
      captured = { command, args };
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: PassThrough;
        kill(signal?: NodeJS.Signals): boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.end();
        child.emit("close", 0, null);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const boundary = {
      ...createDefaultGatewayBoundaryPolicy({
        source_channel: "webhook",
        source_identity: "source-rsync",
        session_key: "webhook:source-rsync:main"
      }),
      sandbox: {
        mode: "all" as const,
        scope: "session" as const,
        backend: "ssh" as const,
        workspace_access: "read_write" as const,
        network_access: "none" as const,
        allowed_paths: [],
        denied_paths: [],
        timeout_ms: 2000,
        metadata: {
          ssh_target: "agent@example.test",
          remote_workspace_root: "/srv/samurai/workspace"
        }
      }
    };

    const result = await executeSandboxWorkspaceSync(
      boundary.sandbox,
      {
        direction: "seed_to_sandbox",
        workspace_root: workspaceRoot,
        remote_workspace_root: "/srv/samurai/workspace"
      },
      createSandboxWorkspaceSyncAdapter({ spawnProcess: fakeSpawn })
    );

    expect(result.status).toBe("completed");
    expect(captured?.command).toBe("rsync");
    expect(captured?.args).toEqual(expect.arrayContaining([
      "-az",
      `${path.resolve(workspaceRoot)}/`,
      "agent@example.test:/srv/samurai/workspace/"
    ]));
  });

  it("mirrors local sandbox workspaces with newer files winning", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "samurai-sandbox-mirror-workspace-"));
    const remoteRoot = await mkdtemp(path.join(tmpdir(), "samurai-sandbox-mirror-remote-"));
    const sharedLocal = path.join(workspaceRoot, "shared.txt");
    const sharedRemote = path.join(remoteRoot, "shared.txt");
    await writeFile(sharedLocal, "old-local");
    await writeFile(sharedRemote, "new-remote");
    await writeFile(path.join(workspaceRoot, "local-only.txt"), "local");
    await writeFile(path.join(remoteRoot, "remote-only.txt"), "remote");
    const oldTime = new Date("2026-01-01T00:00:00.000Z");
    const newTime = new Date("2026-01-02T00:00:00.000Z");
    await utimes(sharedLocal, oldTime, oldTime);
    await utimes(sharedRemote, newTime, newTime);
    const boundary = {
      ...createDefaultGatewayBoundaryPolicy({
        source_channel: "webhook",
        source_identity: "source-mirror",
        session_key: "webhook:source-mirror:main"
      }),
      sandbox: {
        mode: "all" as const,
        scope: "session" as const,
        backend: "ssh" as const,
        workspace_access: "read_write" as const,
        network_access: "none" as const,
        allowed_paths: [],
        denied_paths: [],
        timeout_ms: 2000,
        metadata: { workspace_sync_transport: "local" }
      }
    };

    const result = await executeSandboxWorkspaceSync(
      boundary.sandbox,
      {
        direction: "mirror",
        workspace_root: workspaceRoot,
        remote_workspace_root: remoteRoot
      },
      createSandboxWorkspaceSyncAdapter()
    );

    expect(result).toMatchObject({
      status: "completed",
      reason: "mirror_newer_wins"
    });
    expect(await readFile(sharedLocal, "utf8")).toBe("new-remote");
    expect(await readFile(sharedRemote, "utf8")).toBe("new-remote");
    expect(await readFile(path.join(remoteRoot, "local-only.txt"), "utf8")).toBe("local");
    expect(await readFile(path.join(workspaceRoot, "remote-only.txt"), "utf8")).toBe("remote");
  });

  it("runs docker sandbox lifecycle commands through the lifecycle adapter", async () => {
    let captured: { command: string; args: string[] } | undefined;
    const fakeSpawn = ((command: string, args: string[]) => {
      captured = { command, args };
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: PassThrough;
        kill(signal?: NodeJS.Signals): boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.write("restarted");
        child.stdout.end();
        child.emit("close", 0, null);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const boundary = {
      ...createDefaultGatewayBoundaryPolicy({
        source_channel: "webhook",
        source_identity: "source-life",
        session_key: "webhook:source-life:main"
      }),
      sandbox: {
        mode: "all" as const,
        scope: "session" as const,
        backend: "docker" as const,
        workspace_access: "read_write" as const,
        network_access: "none" as const,
        allowed_paths: [],
        denied_paths: [],
        timeout_ms: 2000,
        metadata: { docker_container_id: "samurai-sandbox-test" }
      }
    };

    const result = await executeSandboxLifecycleAction(
      boundary.sandbox,
      {
        action: "recreate",
        instance_key: "docker:session:webhook:source-life:main"
      },
      createSandboxLifecycleAdapter({ spawnProcess: fakeSpawn })
    );

    expect(result).toMatchObject({
      status: "completed",
      command: "docker",
      stdout: "restarted"
    });
    expect(captured).toEqual({
      command: "docker",
      args: ["restart", "samurai-sandbox-test"]
    });
  });

  it("resolves SecretRef values without exposing raw keys in the result", async () => {
    const fileRoot = await mkdtemp(path.join(tmpdir(), "samurai-secret-test-"));
    await writeFile(path.join(fileRoot, "token.txt"), "file-secret\n");

    const resolved = await resolveSecretRefs([
      {
        id: "secret_env",
        source: "env",
        provider: "test",
        key: "SAMURAI_TEST_SECRET",
        label: "Env secret"
      },
      {
        id: "secret_file",
        source: "file",
        provider: "test",
        key: "token.txt"
      },
      {
        id: "secret_keychain",
        source: "keychain",
        provider: "test",
        key: "login"
      }
    ], {
      env: { SAMURAI_TEST_SECRET: "env-secret" },
      fileRoot
    });

    expect(resolved).toEqual([
      expect.objectContaining({ id: "secret_env", resolved: true, value: "env-secret" }),
      expect.objectContaining({ id: "secret_file", resolved: true, value: "file-secret" }),
      expect.objectContaining({ id: "secret_keychain", resolved: false, reason: "unsupported_source" })
    ]);
    expect(JSON.stringify(resolved)).not.toContain("SAMURAI_TEST_SECRET");
    expect(JSON.stringify(resolved)).not.toContain("token.txt");
  });

  it("creates a SecretRef resolution bundle for sandbox or MCP adapters without exposing keys in the summary", async () => {
    const bundle = await createSecretResolutionBundle([
      {
        id: "secret_env",
        source: "env",
        provider: "test",
        key: "SAMURAI_TEST_SECRET",
        label: "Env secret",
        scope: "mcp"
      },
      {
        id: "secret_missing",
        source: "env",
        provider: "test",
        key: "MISSING_SECRET"
      }
    ], {
      env: { SAMURAI_TEST_SECRET: "env-secret" }
    });

    expect(bundle).toMatchObject({
      status: "failed",
      reason: "secret_resolution_failed",
      summary: {
        secret_ref_ids: ["secret_env", "secret_missing"],
        resolved_secret_ref_ids: ["secret_env"],
        unresolved_secret_ref_ids: ["secret_missing"],
        unresolved_reasons: { secret_missing: "missing" }
      },
      materials: [
        {
          id: "secret_env",
          source: "env",
          provider: "test",
          value: "env-secret",
          label: "Env secret",
          scope: "mcp"
        }
      ]
    });
    expect(JSON.stringify(bundle.summary)).not.toContain("SAMURAI_TEST_SECRET");
    expect(JSON.stringify(bundle.summary)).not.toContain("env-secret");
    expect(JSON.stringify(bundle.summary)).not.toContain("MISSING_SECRET");
  });

  it("materializes SecretRef files for sandbox executors and removes them on cleanup", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "samurai-secret-material-root-"));
    const materialized = await materializeSecretFiles([
      {
        id: "secret_ssh",
        source: "env",
        provider: "ssh",
        value: "ssh-secret"
      }
    ], [
      {
        secret_ref_id: "secret_ssh",
        filename: "identity",
        mode: 0o600
      }
    ], { tmpRoot });

    const file = materialized.files[0];
    expect(await readFile(file.path, "utf8")).toBe("ssh-secret");
    expect((await stat(file.path)).mode & 0o777).toBe(0o600);

    await materialized.cleanup();
    await expect(access(file.path)).rejects.toBeTruthy();
  });

  it("plans MCP tool invocation through boundary and sandbox policy", () => {
    const boundary = {
      ...createDefaultGatewayBoundaryPolicy({
        source_channel: "webhook",
        source_identity: "source-1",
        session_key: "webhook:source-1:main"
      }),
      mcp_config_refs: [{
        id: "mcp_calendar",
        server_name: "calendar",
        allowed_tools: ["calendar.read"],
        secret_refs: [{
          id: "secret_calendar",
          source: "env" as const,
          provider: "calendar",
          key: "CALENDAR_TOKEN"
        }]
      }],
      sandbox: {
        mode: "non_main" as const,
        scope: "session" as const,
        backend: "none" as const,
        workspace_access: "read" as const,
        network_access: "localhost" as const,
        allowed_paths: [{ root: "collections/calendar", access: "read" as const }],
        denied_paths: ["secrets"],
        timeout_ms: 1000,
        metadata: {}
      }
    };

    const ready = planMcpToolInvocation(boundary, { server_name: "calendar", tool_name: "calendar.read" });
    const blocked = planMcpToolInvocation(boundary, { server_name: "calendar", tool_name: "calendar.write" });
    const sandbox = createSandboxExecutionPlan(boundary.sandbox);

    expect(ready).toMatchObject({
      status: "ready",
      server_name: "calendar",
      tool_name: "calendar.read",
      secret_ref_ids: ["secret_calendar"]
    });
    expect(blocked).toMatchObject({ status: "blocked", reason: "tool_not_allowed" });
    expect(sandbox).toMatchObject({
      mode: "non_main",
      workspace_access: "read",
      allowed_paths: [{ root: "collections/calendar", access: "read" }],
      denied_paths: ["secrets"]
    });
  });

  it("summarizes stored MCP configs and converts them to execution refs without exposing secret keys", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const config = {
      id: "gateway_mcp_calendar",
      server_name: "calendar",
      transport: "stdio" as const,
      enabled: true,
      allowed_tools: ["calendar.read"],
      secret_refs: [{
        id: "secret_calendar",
        source: "env" as const,
        provider: "calendar",
        key: "CALENDAR_TOKEN"
      }],
      stdio: {
        command: "node",
        args: ["calendar-mcp.js"],
        env: {},
        secret_env: { CALENDAR_TOKEN: "secret_calendar" },
        secret_files: [],
        framing: "json_lines" as const,
        initialize: true,
        timeout_ms: 2000
      },
      metadata: {},
      created_at: now,
      updated_at: now
    };

    const summary = summarizeGatewayMcpConfig(config);
    const boundaryRef = gatewayMcpConfigToBoundaryRef(config);
    const stdioConfig = stdioMcpServerConfigFromGatewayConfig(config);

    expect(summary).toMatchObject({
      id: "gateway_mcp_calendar",
      server_name: "calendar",
      secret_ref_ids: ["secret_calendar"],
      has_stdio: true,
      timeout_ms: 2000
    });
    expect(JSON.stringify(summary)).not.toContain("CALENDAR_TOKEN");
    expect(boundaryRef.secret_refs).toEqual(config.secret_refs);
    expect(stdioConfig).toMatchObject({
      server_name: "calendar",
      command: "node",
      secret_env: { CALENDAR_TOKEN: "secret_calendar" }
    });
  });

  it("executes MCP tools through an adapter without leaking resolved secrets", async () => {
    let adapterSawSecret = false;
    const boundary = {
      ...createDefaultGatewayBoundaryPolicy({
        source_channel: "webhook",
        source_identity: "source-1",
        session_key: "webhook:source-1:main"
      }),
      mcp_config_refs: [{
        id: "mcp_calendar",
        server_name: "calendar",
        allowed_tools: ["calendar.read"],
        secret_refs: [{
          id: "secret_calendar",
          source: "env" as const,
          provider: "calendar",
          key: "CALENDAR_TOKEN"
        }]
      }]
    };

    const result = await executeMcpToolInvocation(
      boundary,
      { server_name: "calendar", tool_name: "calendar.read", input: { range: "today" } },
      {
        async invoke(input) {
          adapterSawSecret = input.secrets[0]?.value === "calendar-secret";
          return {
            output: {
              ok: true,
              echoed: `used calendar-secret for ${input.input.range}`
            }
          };
        }
      },
      { env: { CALENDAR_TOKEN: "calendar-secret" } }
    );

    expect(adapterSawSecret).toBe(true);
    expect(result).toMatchObject({
      status: "completed",
      secret_ref_ids: ["secret_calendar"],
      resolved_secret_ref_ids: ["secret_calendar"],
      secret_resolution: {
        secret_ref_ids: ["secret_calendar"],
        resolved_secret_ref_ids: ["secret_calendar"],
        unresolved_secret_ref_ids: []
      },
      output: { ok: true, echoed: "used [redacted:secret_calendar] for today" }
    });
    expect(JSON.stringify(result)).not.toContain("calendar-secret");
    expect(JSON.stringify(result)).not.toContain("CALENDAR_TOKEN");
  });

  it("executes MCP tools through an HTTP JSON-RPC adapter without leaking secret headers", async () => {
    let fetchSawSecretHeader = false;
    const config = {
      id: "gateway_mcp_http_calendar",
      server_name: "calendar-http",
      transport: "http" as const,
      enabled: true,
      allowed_tools: ["calendar.read"],
      secret_refs: [{
        id: "secret_http_calendar",
        source: "env" as const,
        provider: "calendar",
        key: "CALENDAR_HTTP_TOKEN"
      }],
      http: {
        endpoint_url: "https://calendar.example.test/mcp",
        headers: { "x-client": "samurai" },
        secret_headers: { authorization: "secret_http_calendar" },
        timeout_ms: 2000
      },
      metadata: {},
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    };
    const boundary = {
      ...createDefaultGatewayBoundaryPolicy({
        source_channel: "webhook",
        source_identity: "source-http",
        session_key: "webhook:source-http:main"
      }),
      mcp_config_refs: [gatewayMcpConfigToBoundaryRef(config)]
    };
    const result = await executeMcpToolInvocation(
      boundary,
      { server_name: "calendar-http", tool_name: "calendar.read", input: { range: "today" } },
      createHttpMcpToolAdapter({
        resolveConfig: () => httpMcpServerConfigFromGatewayConfig(config),
        fetch: async (_url, init) => {
          fetchSawSecretHeader = init.headers.authorization === "Bearer calendar-http-secret";
          expect(JSON.parse(init.body).params).toEqual({
            name: "calendar.read",
            arguments: { range: "today" }
          });
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({
                jsonrpc: "2.0",
                id: "1",
                result: { content: [{ type: "text", text: "used Bearer calendar-http-secret" }] }
              });
            }
          };
        }
      }),
      { env: { CALENDAR_HTTP_TOKEN: "Bearer calendar-http-secret" } }
    );

    expect(fetchSawSecretHeader).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({
      content: [{ type: "text", text: "used Bearer [redacted]" }]
    });
    expect(JSON.stringify(result)).not.toContain("calendar-http-secret");
    expect(JSON.stringify(result)).not.toContain("CALENDAR_HTTP_TOKEN");
  });

  it("runs MCP tool calls through a stdio server process and cleans temporary secret files", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "samurai-mcp-stdio-"));
    const serverPath = path.join(tmpRoot, "mcp-server.cjs");
    await writeFile(serverPath, `
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.id) return;
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "fake-calendar", version: "1.0.0" }
      }
    });
    return;
  }
  if (message.method === "tools/call") {
    const filePath = process.env.SSH_IDENTITY_FILE;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        ok: true,
        filePath,
        content: [
          {
            type: "text",
            text: "used " + process.env.CALENDAR_TOKEN + " and " + fs.readFileSync(filePath, "utf8")
          }
        ]
      }
    });
  }
});
`);

    const boundary = {
      ...createDefaultGatewayBoundaryPolicy({
        source_channel: "webhook",
        source_identity: "source-1",
        session_key: "webhook:source-1:main"
      }),
      mcp_config_refs: [{
        id: "mcp_calendar",
        server_name: "calendar",
        allowed_tools: ["calendar.read"],
        secret_refs: [
          {
            id: "secret_calendar",
            source: "env" as const,
            provider: "calendar",
            key: "CALENDAR_TOKEN"
          },
          {
            id: "secret_ssh",
            source: "env" as const,
            provider: "ssh",
            key: "SSH_IDENTITY"
          }
        ]
      }]
    };

    const result = await executeMcpToolInvocation(
      boundary,
      { server_name: "calendar", tool_name: "calendar.read", input: { range: "today" } },
      createStdioMcpToolAdapter({
        env: { PATH: process.env.PATH },
        resolveConfig(input) {
          return input.server_name === "calendar"
            ? {
                server_name: "calendar",
                command: process.execPath,
                args: [serverPath],
                secret_env: { CALENDAR_TOKEN: "secret_calendar" },
                secret_files: [{
                  env: "SSH_IDENTITY_FILE",
                  secret_ref_id: "secret_ssh",
                  filename: "identity"
                }],
                framing: "json_lines",
                timeout_ms: 2000
              }
            : undefined;
        }
      }),
      {
        env: {
          CALENDAR_TOKEN: "calendar-secret",
          SSH_IDENTITY: "ssh-secret"
        }
      }
    );

    const output = result.output as { content?: Array<{ text?: string }>; filePath?: string };
    expect(result).toMatchObject({
      status: "completed",
      secret_resolution: {
        resolved_secret_ref_ids: ["secret_calendar", "secret_ssh"],
        unresolved_secret_ref_ids: []
      }
    });
    expect(output.content?.[0]?.text).toBe("used [redacted:secret_calendar] and [redacted:secret_ssh]");
    expect(JSON.stringify(result)).not.toContain("calendar-secret");
    expect(JSON.stringify(result)).not.toContain("ssh-secret");
    expect(JSON.stringify(result)).not.toContain("CALENDAR_TOKEN");
    expect(JSON.stringify(result)).not.toContain("SSH_IDENTITY");
    await expect(access(output.filePath ?? "")).rejects.toBeTruthy();
  });

  it("reuses pooled stdio MCP server processes until explicitly closed", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "samurai-mcp-pool-"));
    const serverPath = path.join(tmpRoot, "mcp-server.cjs");
    await writeFile(serverPath, `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let calls = 0;
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.id) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
    return;
  }
  if (message.method === "tools/call") {
    calls += 1;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { pid: process.pid, calls, token: process.env.CALENDAR_TOKEN }
    });
  }
});
`);
    const boundary = {
      ...createDefaultGatewayBoundaryPolicy({
        source_channel: "webhook",
        source_identity: "source-1",
        session_key: "webhook:source-1:main"
      }),
      mcp_config_refs: [{
        id: "mcp_calendar",
        server_name: "calendar",
        allowed_tools: ["calendar.read"],
        secret_refs: [{
          id: "secret_calendar",
          source: "env" as const,
          provider: "calendar",
          key: "CALENDAR_TOKEN"
        }]
      }]
    };
    const adapter = createPooledStdioMcpToolAdapter({
      env: { PATH: process.env.PATH },
      maxProcesses: 2,
      idleTtlMs: 60_000,
      resolveConfig(input) {
        return input.server_name === "calendar"
          ? {
              server_name: "calendar",
              command: process.execPath,
              args: [serverPath],
              secret_env: { CALENDAR_TOKEN: "secret_calendar" },
              framing: "json_lines",
              timeout_ms: 2000
            }
          : undefined;
      }
    });

    const first = await executeMcpToolInvocation(
      boundary,
      { server_name: "calendar", tool_name: "calendar.read", input: { range: "today" } },
      adapter,
      { env: { CALENDAR_TOKEN: "calendar-secret" } }
    );
    const second = await executeMcpToolInvocation(
      boundary,
      { server_name: "calendar", tool_name: "calendar.read", input: { range: "tomorrow" } },
      adapter,
      { env: { CALENDAR_TOKEN: "calendar-secret" } }
    );
    const [third, fourth] = await Promise.all([
      executeMcpToolInvocation(boundary, { server_name: "calendar", tool_name: "calendar.read", input: { range: "week" } }, adapter, { env: { CALENDAR_TOKEN: "calendar-secret" } }),
      executeMcpToolInvocation(boundary, { server_name: "calendar", tool_name: "calendar.read", input: { range: "month" } }, adapter, { env: { CALENDAR_TOKEN: "calendar-secret" } })
    ]);
    const firstOutput = first.output as { pid?: number; calls?: number };
    const secondOutput = second.output as { pid?: number; calls?: number };

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(firstOutput.pid).toBe(secondOutput.pid);
    expect(firstOutput.calls).toBe(1);
    expect(secondOutput.calls).toBe(2);
    expect((third.output as { pid?: number }).pid).toBe(firstOutput.pid);
    expect((fourth.output as { pid?: number }).pid).toBe(firstOutput.pid);
    expect(adapter.stats()).toMatchObject({
      process_count: 1,
      max_processes: 2,
      idle_ttl_ms: 60_000
    });
    expect(JSON.stringify(second)).not.toContain("calendar-secret");
    expect(JSON.stringify(second)).not.toContain("CALENDAR_TOKEN");

    await adapter.closeAll();
    expect(adapter.stats().process_count).toBe(0);
  });

  it("rejects pending MCP requests and refuses invocation after pool shutdown", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "samurai-mcp-pool-close-"));
    const serverPath = path.join(tmpRoot, "mcp-server.cjs");
    await writeFile(serverPath, `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
process.on("SIGTERM", () => {});
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
  }
});
`);
    const adapter = createPooledStdioMcpToolAdapter({
      env: { PATH: process.env.PATH },
      resolveConfig() {
        return {
          server_name: "calendar",
          command: process.execPath,
          args: [serverPath],
          framing: "json_lines",
          timeout_ms: 60_000
        };
      }
    });
    const pending = adapter.invoke({
      server_name: "calendar",
      tool_name: "calendar.read",
      input: {},
      sandbox: createSandboxExecutionPlan(createDefaultGatewayBoundaryPolicy({
        source_channel: "webhook",
        source_identity: "source-1",
        session_key: "webhook:source-1:main"
      }).sandbox),
      secrets: []
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closing = adapter.closeAll();
    await expect(pending).rejects.toThrow("mcp_process_closed");
    await closing;
    await expect(adapter.invoke({
      server_name: "calendar",
      tool_name: "calendar.read",
      input: {},
      sandbox: createSandboxExecutionPlan(createDefaultGatewayBoundaryPolicy({
        source_channel: "webhook",
        source_identity: "source-1",
        session_key: "webhook:source-1:main"
      }).sandbox),
      secrets: []
    })).rejects.toThrow("mcp_process_pool_closed");
  });

  it("reports SecretRef ids without marking them unresolved when an MCP tool is blocked before resolution", async () => {
    const boundary = {
      ...createDefaultGatewayBoundaryPolicy({
        source_channel: "webhook",
        source_identity: "source-1",
        session_key: "webhook:source-1:main"
      }),
      mcp_config_refs: [{
        id: "mcp_calendar",
        server_name: "calendar",
        allowed_tools: ["calendar.read"],
        secret_refs: [{
          id: "secret_calendar",
          source: "env" as const,
          provider: "calendar",
          key: "CALENDAR_TOKEN"
        }]
      }]
    };

    const result = await executeMcpToolInvocation(
      boundary,
      { server_name: "calendar", tool_name: "calendar.write" },
      {
        async invoke() {
          throw new Error("adapter_should_not_run");
        }
      },
      { env: { CALENDAR_TOKEN: "calendar-secret" } }
    );

    expect(result).toMatchObject({
      status: "blocked",
      reason: "tool_not_allowed",
      secret_ref_ids: ["secret_calendar"],
      resolved_secret_ref_ids: [],
      secret_resolution: {
        secret_ref_ids: ["secret_calendar"],
        resolved_secret_ref_ids: [],
        unresolved_secret_ref_ids: [],
        unresolved_reasons: {}
      }
    });
    expect(JSON.stringify(result)).not.toContain("calendar-secret");
    expect(JSON.stringify(result)).not.toContain("CALENDAR_TOKEN");
  });
});
