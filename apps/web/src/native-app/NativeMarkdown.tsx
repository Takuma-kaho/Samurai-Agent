import { useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ResourceRef } from "@samurai-agent/core-schemas";

export interface NativeMarkdownProps {
  value: string;
  attachmentRefs?: ResourceRef[];
  onOpenAttachment?: (ref: ResourceRef) => void;
}

function isSafeMarkdownUrl(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  if (normalized.startsWith("#") || normalized.startsWith("//")) return false;
  if (normalized.startsWith("/") || normalized.startsWith("./") || normalized.startsWith("../")) return true;
  try {
    const url = new URL(normalized, "https://samurai.invalid");
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function codeText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(codeText).join("");
  return "";
}

function NativeMarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const child = Array.isArray(children) ? children[0] : children;
  const element = child && typeof child === "object" && "props" in child
    ? child as ReactElement<{ className?: string; children?: ReactNode }>
    : undefined;
  const language = element?.props.className?.match(/language-([\w+-]+)/)?.[1] ?? "code";
  const text = codeText(element?.props.children ?? children);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="native-markdown-code-block">
      <div className="native-markdown-code-toolbar">
        <span>{language}</span>
        <button type="button" onClick={() => void copy()} aria-label="コードをコピー">{copied ? "コピー済み" : "コピー"}</button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

export function NativeMarkdown({ value, attachmentRefs = [], onOpenAttachment }: NativeMarkdownProps) {
  const attachmentByUri = new Map(
    attachmentRefs
      .filter((ref) => ref.kind === "file" && typeof ref.uri === "string")
      .map((ref) => [ref.uri, ref])
  );
  return (
    <div className="native-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => isSafeMarkdownUrl(url) ? url : ""}
        components={{
          a: ({ href, children, ...props }) => {
            const ref = href ? attachmentByUri.get(href) : undefined;
            if (ref && onOpenAttachment) {
              return <button type="button" className="native-markdown-attachment-link" onClick={() => onOpenAttachment(ref)}>{children}</button>;
            }
            if (href?.startsWith("attachments/")) return <span>{children}</span>;
            if (!href || !isSafeMarkdownUrl(href)) return <span>{children}</span>;
            return <a href={href} target="_blank" rel="noreferrer noopener" {...props}>{children}</a>;
          },
          pre: ({ children }) => <NativeMarkdownCodeBlock>{children}</NativeMarkdownCodeBlock>
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}

export default NativeMarkdown;
