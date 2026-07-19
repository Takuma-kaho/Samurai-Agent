import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestAttachment } from "../../packages/runtime/src/attachments/ingestion";

const root = await mkdtemp(path.join(tmpdir(), "samurai-attachments-"));
try {
  const files = {
    image: path.join(root, "image.png"), pdf: path.join(root, "sample.pdf"), text: path.join(root, "sample.txt"),
    docx: path.join(root, "sample.docx"), xlsx: path.join(root, "sample.xlsx"), pptx: path.join(root, "sample.pptx")
  };
  const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(320, 16); png.writeUInt32BE(200, 20);
  await writeFile(files.image, png);
  await writeFile(files.text, "Text attachment source trace");
  const pdfStream = "BT /F1 12 Tf (PDF attachment text) Tj ET";
  await writeFile(files.pdf, `%PDF-1.4\n1 0 obj << /Length ${pdfStream.length} >>\nstream\n${pdfStream}\nendstream\nendobj\n%%EOF`);
  await writeFile(files.docx, zipStored({ "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>DOCX attachment text</w:t></w:r></w:p></w:body></w:document>" }));
  await writeFile(files.xlsx, zipStored({
    "xl/sharedStrings.xml": "<sst><si><t>XLSX shared text</t></si></sst>",
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c></row></sheetData></worksheet>'
  }));
  await writeFile(files.pptx, zipStored({
    "ppt/slides/slide1.xml": "<p:sld><a:t>PPTX first slide</a:t></p:sld>",
    "ppt/slides/slide2.xml": "<p:sld><a:t>PPTX second slide</a:t></p:sld>"
  }));

  const image = await ingestAttachment({ filePath: files.image });
  const pdf = await ingestAttachment({ filePath: files.pdf });
  const text = await ingestAttachment({ filePath: files.text });
  const docx = await ingestAttachment({ filePath: files.docx });
  const xlsx = await ingestAttachment({ filePath: files.xlsx });
  const pptx = await ingestAttachment({ filePath: files.pptx });
  assert.deepEqual(image.metadata, { format: "png", width: 320, height: 200, extraction: "metadata_only" });
  assert.match(pdf.extracted_text, /PDF attachment text/);
  assert.match(text.extracted_text, /source trace/);
  assert.match(docx.extracted_text, /DOCX attachment text/);
  assert.match(xlsx.extracted_text, /XLSX shared text\t42/);
  assert.match(pptx.extracted_text, /PPTX first slide\nPPTX second slide/);
  for (const record of [image, pdf, text, docx, xlsx, pptx]) {
    assert.equal(record.source_hash.length, 64);
    assert.ok(record.source_ref.uri.length > 0);
  }

  const corruptions = [
    { filePath: path.join(root, "broken.png"), bytes: Buffer.from("not an image"), error: /attachment_image_invalid/ },
    { filePath: path.join(root, "broken.pdf"), bytes: Buffer.from("not a pdf"), error: /attachment_pdf_invalid/ },
    { filePath: path.join(root, "broken.txt"), bytes: Buffer.from([0xc3, 0x28]), error: /attachment_text_invalid_utf8/ },
    { filePath: path.join(root, "broken.docx"), bytes: Buffer.from("not a zip"), error: /attachment_zip_invalid/ },
    { filePath: path.join(root, "broken.xlsx"), bytes: Buffer.from("not a zip"), error: /attachment_zip_invalid/ },
    { filePath: path.join(root, "broken.pptx"), bytes: Buffer.from("not a zip"), error: /attachment_zip_invalid/ }
  ];
  for (const corruption of corruptions) { await writeFile(corruption.filePath, corruption.bytes); await assert.rejects(ingestAttachment({ filePath: corruption.filePath }), corruption.error); }
  for (const filePath of Object.values(files)) await assert.rejects(ingestAttachment({ filePath, maxSourceBytes: 2 }), /attachment_source_too_large/);

  const truncated = await ingestAttachment({ filePath: files.text, maxExtractedCharacters: 10 });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.extracted_text.length, 10);
  await assert.rejects(ingestAttachment({ filePath: files.text, maxSourceBytes: 2 }), /attachment_source_too_large/);
  let reads = 0;
  const retried = await ingestAttachment({
    filePath: files.text,
    read: async () => {
      reads += 1;
      if (reads < 3) throw new Error("transient_read_failure");
      return Buffer.from("retry success");
    }
  });
  assert.equal(retried.attempts, 3);
  assert.equal(retried.extracted_text, "retry success");

  process.stdout.write(`${JSON.stringify({
    status: "passed", formats: [image, pdf, text, docx, xlsx, pptx].map((item) => item.media_type),
    extraction: { pdf: pdf.extracted_text, docx: docx.extracted_text, xlsx: xlsx.extracted_text, pptx: pptx.extracted_text },
    limits: { source_rejected: true, all_formats_oversize_rejected: true, text_truncated: truncated.truncated }, corrupt_formats_rejected: corruptions.length, source_trace: true, retry_attempts: retried.attempts
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function zipStored(entries: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    chunks.push(header, nameBuffer, data);
  }
  return Buffer.concat(chunks);
}
