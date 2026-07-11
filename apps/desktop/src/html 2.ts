import type { DesktopConfig } from "./config.js";

export function statusPageHtml(input: {
  title: string;
  message: string;
  detail?: string;
  config: DesktopConfig;
}): string {
  return page("Samurai Agent", `
    <main class="panel">
      <p class="eyebrow">Desktop Shell</p>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.message)}</p>
      ${input.detail ? `<pre>${escapeHtml(input.detail)}</pre>` : ""}
      <div class="actions">
        <button id="retry" type="button">Retry</button>
        <button id="quit" type="button" class="ghost">Quit</button>
      </div>
      <dl>
        <div><dt>API</dt><dd>${escapeHtml(input.config.apiBaseUrl)}</dd></div>
        <div><dt>Web</dt><dd>${escapeHtml(input.config.mode === "development" ? input.config.webDevUrl : input.config.packagedWebEntryPath)}</dd></div>
      </dl>
    </main>
    <script>
      document.querySelector("#retry").addEventListener("click", async () => {
        await window.samuraiDesktop.reloadMainWindow();
      });
      document.querySelector("#quit").addEventListener("click", () => {
        window.samuraiDesktop.quitApp();
      });
    </script>
  `);
}

export function quickAskHtml(input: {
  initialContent?: string;
  statusText?: string;
  sourceFeature?: string;
} = {}): string {
  const initialContent = input.initialContent ?? "";
  const statusText = input.statusText ?? "送信前に内容を確認できます。";
  const sourceFeature = input.sourceFeature ?? "quick_ask";
  return page("Quick Ask", `
    <main class="quick-ask">
      <header>
        <p class="eyebrow">Quick Ask</p>
        <button id="close" type="button" aria-label="Close">Esc</button>
      </header>
      <form id="form">
        <textarea id="content" name="content" autofocus maxlength="8000" placeholder="Samuraiに頼むことを書く">${escapeHtml(initialContent)}</textarea>
        <footer>
          <p id="status">${escapeHtml(statusText)}</p>
          <button id="submit" type="submit">Send</button>
        </footer>
      </form>
    </main>
    <script>
      const form = document.querySelector("#form");
      const content = document.querySelector("#content");
      const status = document.querySelector("#status");
      const submit = document.querySelector("#submit");
      const sourceFeature = ${JSON.stringify(sourceFeature)};
      document.querySelector("#close").addEventListener("click", () => window.samuraiDesktop.closeQuickAsk());
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape") window.samuraiDesktop.closeQuickAsk();
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") form.requestSubmit();
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const value = content.value.trim();
        if (!value) return;
        submit.disabled = true;
        status.textContent = "送信中...";
        try {
          await window.samuraiDesktop.submitQuickAsk({ content: value, sourceFeature });
          status.textContent = "送信しました。";
          content.value = "";
          await window.samuraiDesktop.openMainWindow();
          window.samuraiDesktop.closeQuickAsk();
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "送信できませんでした。";
          submit.disabled = false;
        }
      });
    </script>
  `);
}

export function appShotHtml(input: {
  sources: Array<{ id: string; name: string; thumbnailDataUrl: string }>;
  error?: string;
}): string {
  const sourceItems = input.sources.map((source, index) => `
    <label class="source-card">
      <input type="radio" name="source" value="${escapeHtml(source.id)}" ${index === 0 ? "checked" : ""} />
      <img src="${escapeHtml(source.thumbnailDataUrl)}" alt="" />
      <span>${escapeHtml(source.name)}</span>
    </label>
  `).join("");
  return page("AppShot", `
    <main class="app-shot">
      <header>
        <p class="eyebrow">AppShot</p>
        <button id="close" type="button" aria-label="Close">Esc</button>
      </header>
      ${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ""}
      <form id="form">
        <div class="source-grid">${sourceItems || `<p class="empty">共有できる画面が見つかりません。</p>`}</div>
        <textarea id="content" name="content" maxlength="2000" placeholder="この画面についてSamuraiに頼むことを書く"></textarea>
        <footer>
          <p id="status">スクショは一時contextとして扱われます。</p>
          <button id="submit" type="submit" ${input.sources.length === 0 ? "disabled" : ""}>Send</button>
        </footer>
      </form>
    </main>
    <script>
      const form = document.querySelector("#form");
      const content = document.querySelector("#content");
      const status = document.querySelector("#status");
      const submit = document.querySelector("#submit");
      document.querySelector("#close").addEventListener("click", () => window.samuraiDesktop.closeAppShot());
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape") window.samuraiDesktop.closeAppShot();
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") form.requestSubmit();
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const source = document.querySelector("input[name='source']:checked");
        const value = content.value.trim();
        if (!source || !value) return;
        submit.disabled = true;
        status.textContent = "送信中...";
        try {
          await window.samuraiDesktop.submitAppShot({ sourceId: source.value, content: value });
          status.textContent = "送信しました。";
          await window.samuraiDesktop.openMainWindow();
          window.samuraiDesktop.closeAppShot();
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "送信できませんでした。";
          submit.disabled = false;
        }
      });
    </script>
  `);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #000;
        --panel: #070808;
        --ink: #f0f0ed;
        --muted: #a4a7a3;
        --soft: #737874;
        --line: #292d30;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: radial-gradient(circle at top, #171918, var(--bg) 45%);
        color: var(--ink);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .panel, .quick-ask {
        width: min(560px, calc(100vw - 32px));
        border: 1px solid var(--line);
        border-radius: 14px;
        background: color-mix(in srgb, var(--panel) 92%, transparent);
        padding: 22px;
      }
      .quick-ask {
        width: 100vw;
        min-height: 100vh;
        border-radius: 0;
        border: 0;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .app-shot {
        width: min(820px, calc(100vw - 28px));
        max-height: calc(100vh - 28px);
        border: 1px solid var(--line);
        border-radius: 12px;
        background: color-mix(in srgb, var(--panel) 94%, transparent);
        padding: 18px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      header, footer, .actions, dl div {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      h1 { margin: 8px 0 10px; font-size: 24px; letter-spacing: 0; }
      p { color: var(--muted); line-height: 1.6; }
      .error { color: #ffb4a8; }
      .eyebrow { margin: 0; color: var(--soft); font-size: 12px; text-transform: uppercase; letter-spacing: 0; }
      pre {
        white-space: pre-wrap;
        overflow: auto;
        padding: 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
        color: var(--muted);
      }
      textarea {
        width: 100%;
        min-height: 168px;
        resize: none;
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 14px;
        background: #020303;
        color: var(--ink);
        font: inherit;
        line-height: 1.5;
        outline: none;
      }
      textarea:focus { border-color: #747a77; }
      .source-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 10px;
        max-height: 300px;
        overflow: auto;
      }
      .source-card {
        display: grid;
        gap: 8px;
        padding: 8px;
        border: 1px solid var(--line);
        border-radius: 8px;
        color: var(--muted);
        cursor: pointer;
      }
      .source-card:has(input:checked) { border-color: #eef0eb; color: var(--ink); }
      .source-card input { position: absolute; opacity: 0; pointer-events: none; }
      .source-card img {
        width: 100%;
        aspect-ratio: 16 / 9;
        object-fit: cover;
        border-radius: 6px;
        background: #020303;
      }
      .source-card span {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        font-size: 12px;
      }
      .empty { margin: 0; }
      button {
        border: 0;
        border-radius: 999px;
        padding: 9px 14px;
        color: #050505;
        background: var(--ink);
        font: inherit;
        cursor: pointer;
      }
      button.ghost, header button {
        color: var(--ink);
        background: #171918;
      }
      button:disabled {
        cursor: wait;
        opacity: .6;
      }
      dl { margin: 18px 0 0; color: var(--muted); font-size: 12px; }
      dt { color: var(--soft); }
      dd { margin: 0; overflow-wrap: anywhere; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
