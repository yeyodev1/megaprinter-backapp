/**
 * Lo que el equipo le enseño a Mila desde el panel (Sistema → Aprendizaje):
 * personalidad, "siempre", "nunca" y las lecciones activas o pendientes.
 *
 *   pnpm bot:rules
 */
import "dotenv/config";
import mongoose from "mongoose";
import { dbConnect } from "../src/config/mongo";
import { BotPersonaModel } from "../src/models/botPersona.model";
import { BotLessonModel } from "../src/models/botLesson.model";

async function main() {
  await dbConnect();
  const persona: any = await BotPersonaModel.findById("persona").lean();
  console.log("PERSONALIDAD:", persona ? JSON.stringify({ personality: persona.personality, alwaysSay: persona.alwaysSay, neverSay: persona.neverSay, updatedBy: persona.updatedBy, updatedAt: persona.updatedAt }, null, 2) : "(vacía)");
  const lessons: any[] = await BotLessonModel.find({ status: { $in: ["activa", "pendiente"] } }).sort({ updatedAt: -1 }).limit(60).lean();
  console.log(`\nLECCIONES (${lessons.length}):`);
  for (const lesson of lessons) console.log(`- [${lesson.status}/${lesson.kind}/${lesson.source}${lesson.updatedBy ? ` ${lesson.updatedBy}` : ""}] ${lesson.text}`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
