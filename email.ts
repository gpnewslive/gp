import nodemailer from "nodemailer";
import type { AiNews } from "@workspace/db";
import { logger } from "./logger.js";

const MAIL_TO = process.env.MAIL_TO ?? "gpnewslive@gmail.com";

function getTransport() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user, pass },
  });
}

async function send(subject: string, text: string): Promise<boolean> {
  const transport = getTransport();
  if (!transport) {
    logger.warn("SMTP not configured; skipping email (backup still saved to DB + Drive)");
    return false;
  }
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to: MAIL_TO,
      subject,
      text,
    });
    logger.info({ to: MAIL_TO, subject }, "Email sent");
    return true;
  } catch (err) {
    logger.error({ err }, "Email send failed");
    return false;
  }
}

export async function sendBackupEmail(items: AiNews[], driveFileId: string | null): Promise<boolean> {
  const lines = items.map((n) => `[${n.category}] ${n.titleMl}`).join("\n");
  const body = `GPNEWS daily AI news backup\nItems: ${items.length}\nGoogle Drive file: ${driveFileId ?? "n/a"}\n\n${lines}`;
  return send(`GPNEWS Backup — ${items.length} news items`, body);
}

export async function sendRegistrationEmail(member: {
  name: string;
  email: string;
  phone?: string | null;
  country?: string | null;
  location?: string | null;
}): Promise<boolean> {
  const body = `New GPNEWS community member registered:\n\nName: ${member.name}\nEmail: ${member.email}\nPhone: ${member.phone ?? "-"}\nCountry: ${member.country ?? "-"}\nLocation: ${member.location ?? "-"}\nTime: ${new Date().toISOString()}`;
  return send(`GPNEWS New Member — ${member.name}`, body);
}
