import { ReplitConnectors } from "@replit/connectors-sdk";
import type { AiNews } from "@workspace/db";
import { logger } from "./logger.js";

const connectors = new ReplitConnectors();
const DRIVE_FOLDER_ID = "1hV93JXt9gMKOeU-B9uO99CVeSRyjg39N";

function formatNewsText(items: Array<Partial<AiNews>>): string {
  const lines: string[] = [];
  lines.push(`GPNEWS AI NEWS BACKUP — ${new Date().toISOString()}`);
  lines.push(`Total items: ${items.length}`);
  lines.push("=".repeat(60));
  for (const n of items) {
    lines.push("");
    lines.push(`[${n.category}] ${n.titleMl ?? ""}`);
    if (n.titleEn) lines.push(`EN: ${n.titleEn}`);
    if (n.summaryMl) lines.push(`Summary: ${n.summaryMl}`);
    if (n.contentMl) lines.push(n.contentMl);
    if (n.sourceName || n.sourceUrl) lines.push(`Source: ${n.sourceName ?? ""} ${n.sourceUrl ?? ""}`);
    lines.push("-".repeat(40));
  }
  return lines.join("\n");
}

// Upload a plain-text backup file into the shared Google Drive folder.
export async function backupNewsToDrive(items: Array<Partial<AiNews>>): Promise<string | null> {
  if (items.length === 0) return null;
  const content = formatNewsText(items);
  const fileName = `gpnews-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;

  const boundary = "gpnews_boundary_" + Date.now();
  const metadata = { name: fileName, parents: [DRIVE_FOLDER_ID], mimeType: "text/plain" };

  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  try {
    const res = await connectors.proxy(
      "google-drive",
      "/upload/drive/v3/files?uploadType=multipart&fields=id",
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    const data = (await res.json()) as any;
    if (data.error) {
      logger.error({ err: data.error }, "Drive backup upload error");
      return null;
    }
    logger.info({ fileId: data.id, fileName }, "AI news backed up to Google Drive");
    return data.id ?? null;
  } catch (err) {
    logger.error({ err }, "Drive backup request failed");
    return null;
  }
}

export async function backupTextToDrive(name: string, content: string): Promise<string | null> {
  const boundary = "gpnews_boundary_" + Date.now();
  const metadata = { name, parents: [DRIVE_FOLDER_ID], mimeType: "text/plain" };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;
  try {
    const res = await connectors.proxy(
      "google-drive",
      "/upload/drive/v3/files?uploadType=multipart&fields=id",
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    const data = (await res.json()) as any;
    return data.id ?? null;
  } catch (err) {
    logger.error({ err }, "Drive text backup failed");
    return null;
  }
}
