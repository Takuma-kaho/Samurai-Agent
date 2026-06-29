#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
loadEnvFile(path.join(rootDir, ".env"));
loadEnvFile(path.join(rootDir, ".env.local"));

const options = parseArgs(process.argv.slice(2));
const dispatchEnabled = envBoolean("SAMURAI_EXTERNAL_SEND_DISPATCH", false);
const channels = [
  genericWebhookReadiness(dispatchEnabled),
  slackReadiness(dispatchEnabled),
  telegramReadiness(dispatchEnabled),
  lineReadiness(dispatchEnabled),
  emailReadiness(dispatchEnabled)
];
const configuredChannels = channels.filter((channel) => channel.configured);
const credentialBackedChannels = configuredChannels.filter((channel) => channel.channel !== "webhook");
const summary = {
  checked_at: new Date().toISOString(),
  require_configured: options.requireConfigured,
  external_effects_confirmed: false,
  dispatch_enabled: dispatchEnabled,
  ok: !options.requireConfigured || credentialBackedChannels.length > 0,
  configured_channel_count: configuredChannels.length,
  credential_channel_count: credentialBackedChannels.length,
  channels,
  manual_gates: [
    {
      id: "external-channel-service-e2e",
      label: "External channel service E2E",
      status: "manual_opt_in_required",
      effect: "external_channel_service",
      reason: "Requires real Slack, Telegram, LINE, or Email provider credentials and may send or receive live messages.",
      command: "manual: run the channel service E2E checklist in plans/backend-external-e2e-runbook.md",
      confirmation_flag: "--confirm-external-effects",
      runbook: "plans/backend-external-e2e-runbook.md"
    }
  ]
};

if (options.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  printSummary(summary);
}

process.exitCode = summary.ok ? 0 : 1;

function parseArgs(args) {
  const options = {
    json: false,
    requireConfigured: process.env.SAMURAI_EXTERNAL_CHANNEL_E2E_REQUIRE_CONFIGURED === "true"
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--require-configured") {
      options.requireConfigured = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function genericWebhookReadiness(dispatchEnabled) {
  return {
    channel: "webhook",
    configured: true,
    inbound: {
      endpoint_available: true,
      verification: "pairing_policy"
    },
    outbound: {
      configured: true,
      dispatch_enabled: dispatchEnabled,
      target_source: "per_send_target_url",
      status: dispatchEnabled ? "dispatch_ready" : "dry_run_only"
    },
    production_e2e: manualE2E("webhook")
  };
}

function slackReadiness(dispatchEnabled) {
  const signingSecret = envConfigured("SAMURAI_SLACK_SIGNING_SECRET");
  const botToken = envConfigured("SAMURAI_SLACK_BOT_TOKEN");
  return {
    channel: "slack",
    configured: signingSecret || botToken,
    inbound: {
      endpoint_available: true,
      verification_configured: signingSecret,
      verification_env_keys: signingSecret ? ["SAMURAI_SLACK_SIGNING_SECRET"] : []
    },
    outbound: {
      configured: botToken,
      dispatch_enabled: dispatchEnabled,
      api_token_configured: botToken,
      api_base_configured: envConfigured("SAMURAI_SLACK_API_URL"),
      target_source: botToken ? "channel_id" : "per_send_webhook_url_or_bot_token",
      status: outboundStatus(botToken, dispatchEnabled, "token_or_target_required")
    },
    production_e2e: manualE2E("slack")
  };
}

function telegramReadiness(dispatchEnabled) {
  const webhookSecret = envConfigured("SAMURAI_TELEGRAM_WEBHOOK_SECRET");
  const botToken = envConfigured("SAMURAI_TELEGRAM_BOT_TOKEN");
  return {
    channel: "telegram",
    configured: webhookSecret || botToken,
    inbound: {
      endpoint_available: true,
      verification_configured: webhookSecret,
      verification_env_keys: webhookSecret ? ["SAMURAI_TELEGRAM_WEBHOOK_SECRET"] : []
    },
    outbound: {
      configured: botToken,
      dispatch_enabled: dispatchEnabled,
      api_token_configured: botToken,
      api_base_configured: envConfigured("SAMURAI_TELEGRAM_API_BASE_URL"),
      target_source: "chat_id",
      status: outboundStatus(botToken, dispatchEnabled, "bot_token_required")
    },
    production_e2e: manualE2E("telegram")
  };
}

function lineReadiness(dispatchEnabled) {
  const channelSecret = envConfigured("SAMURAI_LINE_CHANNEL_SECRET");
  const accessToken = envConfigured("SAMURAI_LINE_CHANNEL_ACCESS_TOKEN");
  return {
    channel: "line",
    configured: channelSecret || accessToken,
    inbound: {
      endpoint_available: true,
      verification_configured: channelSecret,
      verification_env_keys: channelSecret ? ["SAMURAI_LINE_CHANNEL_SECRET"] : []
    },
    outbound: {
      configured: accessToken,
      dispatch_enabled: dispatchEnabled,
      api_token_configured: accessToken,
      api_base_configured: envConfigured("SAMURAI_LINE_API_BASE_URL"),
      target_source: "reply_token_or_to",
      status: outboundStatus(accessToken, dispatchEnabled, "channel_access_token_required")
    },
    production_e2e: manualE2E("line")
  };
}

function emailReadiness(dispatchEnabled) {
  const smtpConfigured = envConfigured("SAMURAI_EMAIL_SMTP_HOST") && (envConfigured("SAMURAI_EMAIL_FROM") || envConfigured("SAMURAI_EMAIL_SMTP_FROM"));
  const imapConfigured = envConfigured("SAMURAI_EMAIL_IMAP_HOST") && envConfigured("SAMURAI_EMAIL_IMAP_USER") && envConfigured("SAMURAI_EMAIL_IMAP_PASSWORD");
  const providerVerification = emailProviderVerificationProviders();
  return {
    channel: "email",
    configured: smtpConfigured || imapConfigured || providerVerification.length > 0 || envConfigured("SAMURAI_EMAIL_ADDRESS"),
    inbound: {
      endpoint_available: true,
      message_endpoint_available: true,
      imap_configured: imapConfigured,
      provider_webhook_verification_configured: providerVerification.length > 0,
      provider_webhook_verification_providers: providerVerification
    },
    outbound: {
      configured: smtpConfigured,
      dispatch_enabled: dispatchEnabled,
      smtp_configured: smtpConfigured,
      target_source: "to_cc_bcc",
      status: outboundStatus(smtpConfigured, dispatchEnabled, "smtp_config_required")
    },
    production_e2e: manualE2E("email")
  };
}

function emailProviderVerificationProviders() {
  const providers = [];
  if (envConfigured("SAMURAI_EMAIL_POSTMARK_WEBHOOK_USERNAME") || envConfigured("SAMURAI_EMAIL_POSTMARK_WEBHOOK_PASSWORD")) {
    providers.push("postmark");
  }
  if (envConfigured("SAMURAI_EMAIL_MAILGUN_SIGNING_KEY")) {
    providers.push("mailgun");
  }
  if (envConfigured("SAMURAI_EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY")) {
    providers.push("sendgrid");
  }
  return providers;
}

function outboundStatus(configured, dispatchEnabled, missingReason) {
  if (!configured) {
    return missingReason;
  }
  return dispatchEnabled ? "dispatch_ready" : "dry_run_only";
}

function manualE2E(channel) {
  return {
    status: "manual_opt_in_required",
    channel,
    runbook: "plans/backend-external-e2e-runbook.md",
    confirmation_flag: "--confirm-external-effects"
  };
}

function envConfigured(key) {
  return Boolean(process.env[key]?.trim());
}

function envBoolean(key, fallback) {
  const value = process.env[key]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value);
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(filePath);
      return;
    } catch {
      // Fall through to the lightweight parser for older Node behavior.
    }
  }
}

function printSummary(summary) {
  console.log("External channel verification");
  console.log(`dispatch=${summary.dispatch_enabled ? "enabled" : "dry-run"} configured_channels=${summary.configured_channel_count} credential_channels=${summary.credential_channel_count}`);
  for (const channel of summary.channels) {
    console.log(`- ${channel.channel}: configured=${channel.configured ? "yes" : "no"} outbound=${channel.outbound.status}`);
  }
  console.log("manual gates:");
  for (const gate of summary.manual_gates) {
    console.log(`- ${gate.id}: ${gate.command}`);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/verify-external-channels.mjs [options]

Checks external channel readiness without sending or receiving live messages.

Options:
  --json                Output machine-readable JSON.
  --require-configured  Exit non-zero if no external channel credentials/config are present.
`);
}
