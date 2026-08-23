import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("backend release readiness verification script", () => {
  it("lists the non-destructive gate plan and manual external gates", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/verify-backend-release-readiness.mjs",
      "--list",
      "--json"
    ], {
      cwd: process.cwd(),
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    });

    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      planned_only: true,
      external_effects_confirmed: false,
      ok: true
    });
    expect(result.gates.map((gate: { id: string }) => gate.id)).toEqual([
      "typecheck",
      "full-tests",
      "i18n-check",
      "web-build",
      "desktop-verify",
      "desktop-build",
      "architecture-static",
      "doctor",
      "doctor-syntax",
      "public-naming-scan",
      "gateway-recovery-probe",
      "external-channel-probe",
      "external-backend-status",
      "sandbox-capabilities",
      "sandbox-host-run"
    ]);
    expect(result.gates.find((gate: { id: string }) => gate.id === "doctor")).toMatchObject({
      command: "node scripts/doctor.mjs --strict"
    });
    expect(result.gates.every((gate: { status: string }) => gate.status === "planned")).toBe(true);
    expect(result.manual_gates.map((gate: { id: string }) => gate.id)).toEqual([
      "external-backend-run-resume",
      "external-sandbox-run",
      "external-channel-service-e2e"
    ]);
    expect(result.manual_gates.every((gate: { status: string; confirmation_flag: string }) =>
      gate.status === "manual_opt_in_required" && gate.confirmation_flag === "--confirm-external-effects"
    )).toBe(true);
    expect(result.manual_gates.every((gate: { runbook: string }) =>
      gate.runbook === "plans/backend-external-e2e-runbook.md"
    )).toBe(true);
    expect(result.profiles.map((profile: { id: string }) => profile.id)).toEqual(["local_oss", "production_ops"]);
    expect(result.profiles.find((profile: { id: string }) => profile.id === "production_ops")).toMatchObject({
      status: "manual_opt_in_required",
      manual_gate_ids: ["external-backend-run-resume", "external-sandbox-run", "external-channel-service-e2e"]
    });
  });

  it("reports external channel readiness without leaking configured secrets", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/verify-external-channels.mjs",
      "--json"
    ], {
      cwd: process.cwd(),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        SAMURAI_EXTERNAL_SEND_DISPATCH: "true",
        SAMURAI_SLACK_SIGNING_SECRET: "slack-signing-secret",
        SAMURAI_TELEGRAM_BOT_TOKEN: "telegram-bot-token",
        SAMURAI_LINE_CHANNEL_SECRET: "line-channel-secret",
        SAMURAI_EMAIL_SMTP_HOST: "smtp.example.test",
        SAMURAI_EMAIL_FROM: "assistant@example.test",
        SAMURAI_EMAIL_MAILGUN_SIGNING_KEY: "mailgun-signing-secret"
      }
    });

    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      ok: true,
      dispatch_enabled: true,
      credential_channel_count: 4
    });
    expect(result.channels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        channel: "slack",
        inbound: expect.objectContaining({ verification_configured: true })
      }),
      expect.objectContaining({
        channel: "telegram",
        outbound: expect.objectContaining({ status: "dispatch_ready" })
      }),
      expect.objectContaining({
        channel: "email",
        inbound: expect.objectContaining({
          provider_webhook_verification_providers: ["mailgun"]
        }),
        outbound: expect.objectContaining({ status: "dispatch_ready" })
      })
    ]));
    expect(result.manual_gates.map((gate: { id: string }) => gate.id)).toEqual(["external-channel-service-e2e"]);
    expect(stdout).not.toContain("slack-signing-secret");
    expect(stdout).not.toContain("telegram-bot-token");
    expect(stdout).not.toContain("line-channel-secret");
    expect(stdout).not.toContain("mailgun-signing-secret");
  });
});
