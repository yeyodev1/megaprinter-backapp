/**
 * Reporte diario de atencion por WhatsApp (solo lectura; con --send manda el correo):
 *
 *   pnpm report:attention -- [YYYY-MM-DD] [--send]
 */
import "dotenv/config";
import mongoose from "mongoose";
import { dbConnect } from "../src/config/mongo";
import { buildAttentionReport, ecuadorDate, sendAttentionReportEmail } from "../src/services/attentionReport.service";

async function main() {
  const args = process.argv.slice(2);
  const date = args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)) || ecuadorDate(1);
  await dbConnect();
  const report = args.includes("--send") ? (await sendAttentionReportEmail(date)).report : await buildAttentionReport(date);
  console.log(JSON.stringify({ date: report.date, crm: report.crm, totals: report.totals, hourly: report.hourly }, null, 2));
  for (const item of report.handoffs) console.log(`🙋 ${item.at.slice(11, 16)}Z ${item.name || item.phone} · ${item.status} · "${item.reason.slice(0, 80)}" (+${item.followUps})`);
  for (const item of report.notUnderstood) console.log(`🤔 ${item.name || item.phone}: "${item.message.slice(0, 90)}"`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
