import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NativeMarkdown } from "./NativeMarkdown";

describe("NativeMarkdown", () => {
  it("renders GFM structure without executing raw HTML", () => {
    const html = renderToStaticMarkup(<NativeMarkdown value={'# 見出し\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [ ] 未完了\n\n```ts\nconst answer = 42;\n```\n\n<script>alert("x")</script>'} />);
    expect(html).toContain("見出し");
    expect(html).toContain("<table>");
    expect(html).toContain("type=\"button\"");
    expect(html).toContain("ts");
    expect(html).toContain("const answer = 42;");
    expect(html).not.toContain("<script>");
  });

  it("does not expose unsafe or unauthorised attachment links", () => {
    const html = renderToStaticMarkup(<NativeMarkdown value={'[危険](javascript:alert(1)) [相対外部](//example.com) [添付](attachments/secret.txt)'} />);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('href="//example.com"');
    expect(html).not.toContain('href="attachments/secret.txt"');
  });
});
