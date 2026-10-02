/**
 * Bitacora del bot desde la terminal (la misma que ve /admin/bot).
 *
 *   pnpm bot:logs                    ultimos 60 pasos de todos los numeros
 *   pnpm bot:logs -- 0991234567      solo ese numero
 *   pnpm bot:logs -- --errors        solo errores
 *   pnpm bot:logs -- --limit 200
 */
import "dotenv/config";
import mongoose from "mongoose";
import { dbConnect } from "../src/config/mongo";
import { BotEventModel } from "../src/models/botEvent.model";
import { phoneVariants, toE164 } from "../src/controllers/whatsappBot.controller";

async function main() {
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) || 60 : 60;
  const phoneArg = args.find((arg) => /^\+?\d{7,}$/.test(arg));
  const filter: Record<string, unknown> = {};
  if (phoneArg) filter.phone = { $in: phoneVariants(toE164(phoneArg)) };
  if (args.includes("--errors")) filter.kind = "error";

  await dbConnect();
  const events: any[] = await BotEventModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  for (const event of events.reverse()) {
    const time = new Date(event.createdAt).toLocaleString("es-EC", { timeZone: "America/Guayaquil" });
    const head = `${time} ${event.phone} /${event.endpoint} ${event.kind === "decision" ? "decide" : "responde"} → ${event.route || "-"} ${event.decision || ""} ${event.durationMs}ms`;
    console.log(head);
    if (event.message) console.log(`   👤 ${event.message.replace(/\s+/g, " ").slice(0, 300)}`);
    if (event.reply) console.log(`   🤖 ${event.reply.replace(/\s+/g, " ").slice(0, 300)}`);
    if (event.error) console.log(`   ❌ ${event.error}`);
  }
  console.log(`\n${events.length} pasos${phoneArg ? ` de ${phoneArg}` : ""}`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
