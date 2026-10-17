import { BotLessonModel } from "../../models/botLesson.model";
import { normalize } from "./catalog";

/**
 * APRENDIZAJE DIARIO DE MILA.
 *
 * Cada mañana se revisan los chats de ayer (services/botLearning.service.ts) y
 * salen lecciones cortas. Las activas se suman al prompt del extractor: cambian
 * como interpreta y responde la IA, nunca los datos (precios, cuentas,
 * sucursales) ni las reglas fijas del router, que siguen mandando.
 */

export type LessonKind = "frase" | "respuesta" | "evitar";
export const LESSON_KINDS: LessonKind[] = ["frase", "respuesta", "evitar"];

export interface Lesson {
  kind: LessonKind;
  text: string;
  example: string;
}

/** Tope de lecciones en el prompt: las mas recientes primero. */
export const MAX_PROMPT_LESSONS = 40;
const CACHE_MS = 60 * 1000;

let active: Lesson[] = [];
let loadedAt = 0;

/** Lecciones activas (cache 5 min). Nunca lanza: si la base falla quedan las ultimas leidas. */
export async function loadLessons(force = false): Promise<Lesson[]> {
  if (!force && Date.now() - loadedAt < CACHE_MS) return active;
  try {
    const docs: any[] = await BotLessonModel.find({ status: "activa" }).sort({ updatedAt: -1 }).limit(MAX_PROMPT_LESSONS).lean();
    active = docs.map((doc) => ({ kind: doc.kind, text: doc.text, example: doc.example || "" }));
    loadedAt = Date.now();
  } catch (error) {
    console.error("[aprendizaje] no se pudieron leer las lecciones:", error instanceof Error ? error.message : error);
  }
  return active;
}

/** Despues de editar en el panel: la proxima llamada vuelve a leer la base. */
export const lessonsChanged = () => {
  loadedAt = 0;
};

const TITLES: Record<LessonKind, string> = {
  frase: "Cómo lo dicen los clientes (úsalo para entender la intención)",
  respuesta: "Cómo responder preguntas frecuentes (aprobado por el equipo)",
  evitar: "Errores que ya cometiste y no debes repetir",
};

/** Bloque para el prompt del extractor ("" si no hay lecciones). */
export function lessonsForPrompt(lessons: Lesson[] = active) {
  if (!lessons.length) return "";
  const groups = LESSON_KINDS.map((kind) => {
    const items = lessons.filter((lesson) => lesson.kind === kind);
    if (!items.length) return "";
    return `${TITLES[kind]}:\n${items.map((lesson) => `- ${lesson.text}${lesson.example ? ` (ej.: "${lesson.example}")` : ""}`).join("\n")}`;
  }).filter(Boolean);
  return `\n\nAPRENDIZAJES DE CHATS REALES (aplícalos; si chocan con las reglas de arriba, mandan las reglas):\n${groups.join("\n\n")}`;
}

// ─── Revision de lo que propone la IA ────────────────────────────────────────

/** Precios de reparaciones o repuestos: regla de Johnny (15-oct), nunca se aprende. */
const REPAIR_PRICE = /(\$\s?\d|\bprecio|\bcuesta|\bvale\b|\bcosto|\bcobr)/i;
const REPAIR_WORDS = /(repar|repuest|revisi|mantenim|diagn|servicio t[eé]cnico|arregl|cambio de (pantalla|bater|teclado))/i;
/** Muletillas que el cliente pidio quitar. */
const BANNED = /ch[eé]vere|qu[eé] onda|\bchuta\b|no te cach[eé]/i;
/** Datos concretos (montos, numeros, links, correos): los confirma una persona antes de usarlos. */
const HARD_FACTS = /\$|\d|https?:\/\/|@|www\./i;

const words = (text: string) => new Set(normalize(text).split(/\s+/).filter((word) => word.length > 3));

/** Parecido entre dos lecciones (0 a 1) por palabras en comun. */
export function similarity(a: string, b: string) {
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return normalize(a) === normalize(b) ? 1 : 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.min(left.size, right.size);
}

export interface ProposedLesson {
  tipo?: unknown;
  leccion?: unknown;
  ejemplo?: unknown;
  confirmar?: unknown;
}

/**
 * Decide que hacer con una leccion que propuso la IA: null si se descarta
 * (mal formada, repetida o prohibida), "pendiente" si afirma algo del negocio
 * y "activa" si solo enseña a entender o a no repetir un error.
 */
export function reviewLesson(raw: ProposedLesson, known: string[]): { lesson: Lesson; status: "activa" | "pendiente"; reason: string } | null {
  const kind = LESSON_KINDS.includes(raw?.tipo as LessonKind) ? (raw.tipo as LessonKind) : null;
  const text = typeof raw?.leccion === "string" ? raw.leccion.replace(/\s+/g, " ").trim() : "";
  const example = typeof raw?.ejemplo === "string" ? raw.ejemplo.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  if (!kind || text.length < 15 || text.length > 320) return null;
  if (BANNED.test(text)) return null;
  if (REPAIR_PRICE.test(text) && REPAIR_WORDS.test(text) && !/nunca|no (des|digas|menciones)/i.test(text)) return null;
  if (known.some((other) => similarity(text, other) >= 0.7)) return null;
  const lesson = { kind, text, example };
  if (kind === "respuesta") return { lesson, status: "pendiente", reason: "Dice cómo responder: lo aprueba el equipo" };
  if (raw.confirmar === true) return { lesson, status: "pendiente", reason: "Afirma algo del negocio" };
  if (HARD_FACTS.test(text)) return { lesson, status: "pendiente", reason: "Trae montos, números o links" };
  return { lesson, status: "activa", reason: "" };
}
