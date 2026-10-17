import { BotChatReviewModel } from "../models/botChatReview.model";
import { BotEventModel } from "../models/botEvent.model";
import { BotLearningRunModel } from "../models/botLearningRun.model";
import { BotLessonModel } from "../models/botLesson.model";
import { NOT_UNDERSTOOD, dayRange, ecuadorDate, isTestPhone } from "./attentionReport.service";
import { escapeHtml, sendEmail } from "./email.service";
import { geminiEnabled, geminiJson } from "./gemini.service";
import { normalize } from "./whatsappBot/catalog";
import { lessonsChanged, reviewLesson } from "./whatsappBot/learning";
import { storeFactsForPrompt } from "./whatsappBot/store";

/**
 * REVISION DIARIA DE CHATS (cron de Vercel cada mañana).
 *
 * Lee las conversaciones de ayer, mide como le fue a Mila y le pide a Gemini
 * lecciones cortas. Las que solo enseñan a entender o a no repetir un error se
 * activan solas; las que afirman algo del negocio quedan pendientes para que el
 * equipo las apruebe en el panel. Lo que necesita cambios de codigo va en el
 * correo como sugerencia para el desarrollador.
 */

const MAX_TRANSCRIPT_CHARS = 90_000;
const MAX_TURNS_PER_CHAT = 40;

export interface DayMetrics {
  conversations: number;
  messages: number;
  notUnderstood: number;
  handoffs: number;
  orders: number;
  tickets: number;
  repeated: number;
}

interface Chat {
  phone: string;
  events: any[];
  problems: number;
}

/** Metricas del dia y conversaciones ordenadas de la mas problematica a la menos. */
export async function dayChats(date: string) {
  const { start, end } = dayRange(date);
  const events: any[] = await BotEventModel.find(
    { kind: "turn", duplicated: { $ne: true }, createdAt: { $gte: start, $lt: end } },
    { phone: 1, message: 1, reply: 1, decision: 1, route: 1, createdAt: 1 },
  )
    .sort({ createdAt: 1 })
    .lean();
  const byPhone = new Map<string, any[]>();
  for (const event of events) {
    if (isTestPhone(event.phone)) continue;
    byPhone.set(event.phone, [...(byPhone.get(event.phone) || []), event]);
  }

  const metrics: DayMetrics = { conversations: byPhone.size, messages: 0, notUnderstood: 0, handoffs: 0, orders: 0, tickets: 0, repeated: 0 };
  const chats: Chat[] = [];
  for (const [phone, mine] of byPhone) {
    let problems = 0;
    metrics.messages += mine.length;
    if (mine.some((event) => event.route === "human")) {
      metrics.handoffs += 1;
      problems += 2;
    }
    for (const [index, event] of mine.entries()) {
      if (NOT_UNDERSTOOD.test(event.decision)) {
        metrics.notUnderstood += 1;
        problems += 3;
      }
      if (event.decision === "R7:orden_creada") metrics.orders += 1;
      if (/^R10:ticket_creado/.test(event.decision)) metrics.tickets += 1;
      // El cliente repite lo mismo: Mila no le contesto lo que pedia.
      const previous = mine[index - 1];
      if (previous && event.message && normalize(event.message) === normalize(previous.message)) {
        metrics.repeated += 1;
        problems += 2;
      }
    }
    chats.push({ phone, events: mine, problems });
  }
  chats.sort((a, b) => b.problems - a.problems || b.events.length - a.events.length);
  return { metrics, chats };
}

const hour = (date: Date) => new Date(date).toLocaleTimeString("es-EC", { timeZone: "America/Guayaquil", hour: "2-digit", minute: "2-digit" });

/** Conversaciones en texto para la IA, sin telefonos (Chat 1, Chat 2…), hasta un tope de caracteres. */
export function transcriptsForPrompt(chats: Chat[], maxChars = MAX_TRANSCRIPT_CHARS) {
  const blocks: string[] = [];
  let size = 0;
  for (const [index, chat] of chats.entries()) {
    const lines = chat.events.slice(-MAX_TURNS_PER_CHAT).flatMap((event) => [
      ...(event.message ? [`[${hour(event.createdAt)}] Cliente: ${String(event.message).slice(0, 300)}`] : []),
      `[${hour(event.createdAt)}] Mila (${event.decision || "?"}${event.route === "human" ? ", pasó a asesor" : ""}): ${String(event.reply || "").replace(/\s+/g, " ").slice(0, 300)}`,
    ]);
    const block = `### Chat ${index + 1}\n${lines.join("\n")}`;
    if (size + block.length > maxChars) break;
    blocks.push(block);
    size += block.length;
  }
  return blocks.join("\n\n");
}

const PROMPT = `Eres el entrenador de Mila, el bot de WhatsApp de Megaprinter (tienda de tecnología en Guayaquil, Ecuador: laptops, all in one, monitores, impresoras, cámaras, tintas y suministros, y servicio técnico).
Te paso los chats de un día (los más problemáticos primero). Entre paréntesis va el código de lo que decidió Mila: R9:no_entendido / R8:sin_resultados = no entendió; "pasó a asesor" = lo derivó a una persona.
Tu trabajo: encontrar dónde Mila falló (no entendió, respondió otra cosa, el cliente repitió, pasó a asesor algo que podía resolver, sonó robótica o rara) y escribir LECCIONES cortas para que mañana lo haga mejor.

Tipos de lección:
- "frase": cómo dicen algo los clientes y qué quieren decir. Ej.: "Cuando escriben 'la de tanque' se refieren a impresoras de tinta continua."
- "evitar": algo que Mila hizo mal y no debe repetir. Ej.: "Si el cliente manda solo 'ok' después de recibir la ubicación, no le repitas el menú."
- "respuesta": cómo responder una pregunta frecuente, SOLO con datos que ya están en la tienda o en lo que respondió Mila. Estas las aprueba el equipo.

Reglas estrictas:
- Cada lección en una o dos frases (máximo 300 caracteres), en español, dirigida a Mila ("Cuando…, …").
- Solo lecciones con evidencia en estos chats; en "ejemplo" copia el mensaje del cliente que la motiva.
- NUNCA inventes datos del negocio (precios, stock, garantías, plazos, envíos, horarios, sucursales). Si una lección afirma algo del negocio, pon "confirmar": true.
- Nunca enseñes a dar precios de reparaciones ni repuestos: el bot nunca los da (los confirma un técnico o asesor). Lo que no está en el catálogo lo atiende un asesor.
- No repitas ni contradigas las lecciones que ya existen (te las paso). Si no hay nada nuevo que aprender, devuelve "lecciones": [].
- Máximo 8 lecciones, las de más impacto primero.
- "mejorasCodigo": problemas que una lección no arregla (un flujo trabado, un mensaje que siempre sale mal, un error). Máximo 5, concretas, citando el chat.
- "resumen": 2 o 3 frases de cómo le fue a Mila ese día.

Datos de la tienda: {{STORE}}

Devuelve SOLO JSON: {"resumen":"...","lecciones":[{"tipo":"frase","leccion":"...","ejemplo":"...","confirmar":false}],"mejorasCodigo":["..."]}`;

export interface LearningResult {
  date: string;
  metrics: DayMetrics;
  summary: string;
  devSuggestions: string[];
  added: Array<{ kind: string; text: string; status: string; reason: string }>;
  analyzed: boolean;
  error: string;
}

/** Revisa los chats de `date` (ayer por defecto), guarda las lecciones y opcionalmente manda el correo. */
export async function runDailyLearning(date = ecuadorDate(1), options: { email?: boolean; dryRun?: boolean } = {}): Promise<LearningResult> {
  const { metrics, chats } = await dayChats(date);
  const result: LearningResult = { date, metrics, summary: "", devSuggestions: [], added: [], analyzed: false, error: "" };

  if (!chats.length) result.summary = "No hubo conversaciones ese día.";
  else if (!geminiEnabled()) result.error = "Falta GEMINI_API_KEY";
  else {
    const existing: any[] = await BotLessonModel.find({}, { kind: 1, text: 1, status: 1 }).sort({ updatedAt: -1 }).limit(300).lean();
    const parsed = await geminiJson<any>({
      system: PROMPT.replace("{{STORE}}", storeFactsForPrompt()),
      text: [
        `Día: ${date}`,
        `Lecciones que ya existen (no las repitas; las "descartada" el equipo no las quiso):\n${existing.map((lesson) => `- [${lesson.kind}/${lesson.status}] ${lesson.text}`).join("\n") || "(ninguna)"}`,
        `CHATS:\n${transcriptsForPrompt(chats)}`,
      ].join("\n\n"),
      maxOutputTokens: 6000,
      thinkingBudget: 2048,
      timeoutMs: 40_000,
    });
    if (!parsed) result.error = "La IA no respondió";
    else {
      result.analyzed = true;
      result.summary = typeof parsed.resumen === "string" ? parsed.resumen.trim().slice(0, 1000) : "";
      result.devSuggestions = (Array.isArray(parsed.mejorasCodigo) ? parsed.mejorasCodigo : [])
        .filter((item: unknown) => typeof item === "string" && item.trim())
        .slice(0, 5)
        .map((item: string) => item.trim().slice(0, 500));
      const known = existing.map((lesson) => String(lesson.text));
      for (const raw of (Array.isArray(parsed.lecciones) ? parsed.lecciones : []).slice(0, 8)) {
        const reviewed = reviewLesson(raw, known);
        if (!reviewed) continue;
        if (!options.dryRun) await BotLessonModel.create({ ...reviewed.lesson, status: reviewed.status, source: "auto", learnedFrom: date, reason: reviewed.reason });
        known.push(reviewed.lesson.text);
        result.added.push({ kind: reviewed.lesson.kind, text: reviewed.lesson.text, status: reviewed.status, reason: reviewed.reason });
      }
      if (result.added.length && !options.dryRun) lessonsChanged();
    }
  }

  if (options.dryRun) return result;
  await BotLearningRunModel.updateOne(
    { _id: date },
    {
      $set: {
        metrics,
        summary: result.summary,
        devSuggestions: result.devSuggestions,
        lessonsActive: result.added.filter((item) => item.status === "activa").length,
        lessonsPending: result.added.filter((item) => item.status === "pendiente").length,
        analyzed: result.analyzed,
        error: result.error,
      },
    },
    { upsert: true },
  );
  if (options.email) await sendLearningEmail(result);
  return result;
}

const pct = (part: number, total: number) => (total ? `${Math.round((part / total) * 100)}%` : "—");

/** Correo para quien mantiene el bot: como le fue, que aprendio y que falta aprobar. */
export async function sendLearningEmail(result: LearningResult) {
  const runs: any[] = await BotLearningRunModel.find({}).sort({ _id: -1 }).limit(7).lean();
  const pending = await BotLessonModel.countDocuments({ status: "pendiente" });
  const web = (process.env.PUBLIC_WEB_URL || "https://megaprinter.ec").replace(/\/$/, "");
  const m = result.metrics;
  const trend = runs
    .map(
      (run) =>
        `<tr><td style="padding:4px 8px">${escapeHtml(run._id)}</td><td style="padding:4px 8px">${run.metrics?.conversations || 0}</td><td style="padding:4px 8px">${pct(run.metrics?.notUnderstood || 0, run.metrics?.messages || 0)}</td><td style="padding:4px 8px">${pct(run.metrics?.handoffs || 0, run.metrics?.conversations || 0)}</td><td style="padding:4px 8px">${run.metrics?.repeated || 0}</td></tr>`,
    )
    .join("");
  const lessons = result.added
    .map((item) => `<li>${item.status === "activa" ? "✅" : "⏳"} <b>${escapeHtml(item.kind)}</b>: ${escapeHtml(item.text)}${item.reason ? ` <i style="color:#777">(${escapeHtml(item.reason)})</i>` : ""}</li>`)
    .join("");
  const dev = result.devSuggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:760px">
<h2 style="margin:0 0 4px">🧠 Mila aprendió de los chats del ${escapeHtml(result.date)}</h2>
<p style="color:#555">${escapeHtml(result.summary || result.error || "")}</p>
<p>${m.conversations} personas · ${m.messages} mensajes · no entendió ${m.notUnderstood} (${pct(m.notUnderstood, m.messages)}) · pasó a asesor ${m.handoffs} (${pct(m.handoffs, m.conversations)}) · repitieron ${m.repeated}</p>
<h3>Lecciones nuevas</h3>${lessons ? `<ul>${lessons}</ul>` : "<p>Nada nuevo que aprender.</p>"}
${pending ? `<p>⏳ Hay <b>${pending}</b> lecciones esperando aprobación: <a href="${web}/admin/aprendizaje">revisarlas en el panel</a>.</p>` : ""}
${dev ? `<h3>🛠️ Para el desarrollador</h3><ul>${dev}</ul>` : ""}
<h3>📈 Últimos días</h3><table style="border-collapse:collapse;font-size:14px"><tr style="background:#f3f3f1;text-align:left"><th style="padding:4px 8px">Día</th><th style="padding:4px 8px">Personas</th><th style="padding:4px 8px">No entendió</th><th style="padding:4px 8px">A asesor</th><th style="padding:4px 8px">Repitieron</th></tr>${trend}</table>
</div>`;
  const to = (process.env.LEARNING_EMAIL || "dreyes@bakano.ec").split(",").map((item) => item.trim()).filter(Boolean);
  return sendEmail(to, `🧠 Mila ${result.date}: ${result.added.length} lecciones nuevas, no entendió ${pct(m.notUnderstood, m.messages)}`, html);
}

// ─── Aprendizaje al momento (un chat) ────────────────────────────────────────

/** Tope por telefono: un chat trabado no dispara una revision por cada mensaje. */
const CHAT_REVIEW_GAP_MS = 20 * 60 * 1000;
const CHAT_WINDOW_MS = 6 * 60 * 60 * 1000;

const CHAT_PROMPT = PROMPT.replace("Te paso los chats de un día (los más problemáticos primero).", "Te paso UNA conversación que acaba de salir mal.")
  .replace("- Máximo 8 lecciones, las de más impacto primero.", "- Máximo 3 lecciones, solo si de verdad enseñan algo nuevo.")
  .replace(/- "mejorasCodigo":[^\n]*\n/, "")
  .replace('- "resumen": 2 o 3 frases de cómo le fue a Mila ese día.', '- "resumen": 1 frase de qué salió mal.')
  .replace(',"mejorasCodigo":["..."]', "");

/**
 * Revisa el chat de `phone` apenas sale mal (no entendio, repitio o paso a
 * asesor) y guarda lecciones: las que solo enseñan a entender se activan al
 * instante, las que afirman algo del negocio esperan aprobacion en el panel.
 * Nunca lanza.
 */
export async function learnFromChat(phone: string, trigger: string) {
  try {
    if (!geminiEnabled() || isTestPhone(phone)) return null;
    const recentReview = await BotChatReviewModel.exists({ phone, createdAt: { $gte: new Date(Date.now() - CHAT_REVIEW_GAP_MS) } });
    if (recentReview) return null;
    const review = await BotChatReviewModel.create({ phone, trigger });
    const events: any[] = await BotEventModel.find(
      { phone, kind: "turn", duplicated: { $ne: true }, createdAt: { $gte: new Date(Date.now() - CHAT_WINDOW_MS) } },
      { message: 1, reply: 1, decision: 1, route: 1, createdAt: 1 },
    )
      .sort({ createdAt: 1 })
      .lean();
    if (!events.length) return null;
    const existing: any[] = await BotLessonModel.find({}, { kind: 1, text: 1, status: 1 }).sort({ updatedAt: -1 }).limit(300).lean();
    const parsed = await geminiJson<any>({
      system: CHAT_PROMPT.replace("{{STORE}}", storeFactsForPrompt()),
      text: [
        `Lecciones que ya existen (no las repitas; las "descartada" el equipo no las quiso):\n${existing.map((lesson) => `- [${lesson.kind}/${lesson.status}] ${lesson.text}`).join("\n") || "(ninguna)"}`,
        `CHAT:\n${transcriptsForPrompt([{ phone, events, problems: 1 }], 20_000)}`,
      ].join("\n\n"),
      maxOutputTokens: 2000,
      thinkingBudget: 1024,
      timeoutMs: 30_000,
    });
    if (!parsed) {
      await BotChatReviewModel.updateOne({ _id: review._id }, { $set: { error: "La IA no respondió" } });
      return null;
    }
    const known = existing.map((lesson) => String(lesson.text));
    const added: LearningResult["added"] = [];
    for (const raw of (Array.isArray(parsed.lecciones) ? parsed.lecciones : []).slice(0, 3)) {
      const reviewed = reviewLesson(raw, known);
      if (!reviewed) continue;
      await BotLessonModel.create({ ...reviewed.lesson, status: reviewed.status, source: "auto", learnedFrom: ecuadorDate(0), reason: reviewed.reason || "Aprendida al momento de un chat" });
      known.push(reviewed.lesson.text);
      added.push({ kind: reviewed.lesson.kind, text: reviewed.lesson.text, status: reviewed.status, reason: reviewed.reason });
    }
    if (added.length) lessonsChanged();
    const summary = typeof parsed.resumen === "string" ? parsed.resumen.trim().slice(0, 500) : "";
    await BotChatReviewModel.updateOne({ _id: review._id }, { $set: { summary, added } });
    console.log(`[aprendizaje] ${phone} (${trigger}) → ${added.length} lecciones nuevas`);
    return { summary, added };
  } catch (error) {
    console.error("[aprendizaje] no se pudo revisar el chat:", error instanceof Error ? error.message : error);
    return null;
  }
}
