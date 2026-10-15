/**
 * Aprendizaje diario de Mila a mano (lo mismo que el cron de cada mañana):
 *
 *   pnpm bot:learn -- [YYYY-MM-DD] [--dry] [--email]
 *
 * --dry no guarda nada (solo muestra lo que aprenderia).
 */
import "dotenv/config";
import mongoose from "mongoose";
import { dbConnect } from "../src/config/mongo";
import { ecuadorDate } from "../src/services/attentionReport.service";
import { runDailyLearning } from "../src/services/botLearning.service";

async function main() {
  const args = process.argv.slice(2);
  const date = args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)) || ecuadorDate(1);
  await dbConnect();
  const result = await runDailyLearning(date, { dryRun: args.includes("--dry"), email: args.includes("--email") });
  console.log(JSON.stringify({ date: result.date, metrics: result.metrics, error: result.error }, null, 2));
  console.log(`\n${result.summary}\n`);
  for (const item of result.added) console.log(`${item.status === "activa" ? "✅" : "⏳"} [${item.kind}] ${item.text}${item.reason ? ` (${item.reason})` : ""}`);
  for (const item of result.devSuggestions) console.log(`🛠️  ${item}`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
