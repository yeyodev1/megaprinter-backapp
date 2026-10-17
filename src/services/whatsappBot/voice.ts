import { geminiJson } from "../gemini.service";
import { botName, casualMarks } from "./router";
import { Persona, bannedPhrases, personaForPrompt } from "./persona";

/**
 * VOZ DE MILA CON IA.
 *
 * El router decide QUE decir (datos, pasos, listas); aqui Gemini lo reescribe
 * para que suene natural y variado, sin repetir lo que Mila ya dijo. Los datos
 * no se tocan: cada linea con datos debe salir identica, si no se envia el
 * borrador original. Si la IA tarda o falla, tambien el borrador.
 */

/** Lineas estructuradas que la IA copia tal cual: listas, viñetas, datos de cuenta, resumen. */
const STRUCTURED = /^(\*\d+\.\*|•|🏦|👤|📧|📍|💳|_|N\.º|A nombre de|RUC|Cuenta |https?:\/\/)/u;

export const protectedLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && STRUCTURED.test(line));

/** Datos sueltos dentro del texto libre: pedidos, montos, numeros largos, links y correos. */
export const protectedTokens = (text: string) =>
  [...new Set(text.match(/MP-\d+|\$\d[\d,]*(?:\.\d+)?|https?:\/\/\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\d{4,}/g) || [])];

/**
 * Lo que el cliente debe leer o escribir tal cual: todo lo que va en *negrita*
 * (*sí*, *retiro*, *catálogo*, productos, *Mila*, *Megaprinter*) y la
 * presentacion como agente (transparencia que pide Meta).
 */
export const protectedPhrases = (text: string) => [
  ...new Set([
    ...(text.match(/\*[^*\n]+\*/g) || []),
    // Transparencia: si el borrador dice que es un bot, la IA no puede borrarlo.
    ...(/\bbot\b/.test(text) ? ["bot"] : []),
    ...(text.includes("tu agente") ? ["agente", "lo que necesites", "siempre"] : []),
  ]),
];

/** Saludo o presentacion al inicio ("Hola de nuevo!", "Qué gusto saludarte", "Soy *Mila*"). */
const OPENS_WITH_GREETING = /^\W*(hola|holi|buen(os|as)|qu[eé] gusto|qu[eé] bueno (verte|saludarte|leerte)|soy \*?mila|te saluda)/i;

/** La IA agrega datos que no estaban: "tu pedido MP-2024-0042", "equipo de ventas", precios o numeros nuevos. */
const NEW_FACTS = /MP-|\$\d|\b(pedido|compra|ventas|entrega inmediata|en stock|disponibles? (hoy|ya)|ultimas unidades|últimas unidades)\b/i;

/** El borrador y la version de la IA conservan exactamente los mismos datos. */
export function keepsData(draft: string, rewritten: string) {
  const output = rewritten.split("\n").map((line) => line.trim());
  // ~100 respuestas de oct-15 abrian con "Hola de nuevo" o "Soy Mila" a mitad de la charla.
  if (OPENS_WITH_GREETING.test(rewritten) && !OPENS_WITH_GREETING.test(draft)) return false;
  const newFacts = (rewritten.match(new RegExp(NEW_FACTS, "gi")) || []).filter((token) => !draft.toLowerCase().includes(token.toLowerCase()));
  if (newFacts.length) return false;
  const newNumbers = (rewritten.match(/\d+/g) || []).filter((number) => !draft.includes(number));
  if (newNumbers.length) return false;
  // Si el borrador pregunta algo, la version de la IA tambien (oct-15 se comio "A nombre de quién la registro?").
  if (draft.includes("?") && !rewritten.includes("?")) return false;
  return (
    protectedLines(draft).every((line) => output.includes(line)) &&
    protectedTokens(draft).every((token) => rewritten.includes(token)) &&
    protectedPhrases(draft).every((phrase) => rewritten.includes(phrase))
  );
}

/** Muletillas que el cliente pidio quitar (oct-2026): si la IA las usa, va el borrador. */
export const BANNED = /ch[eé]vere|qu[eé] onda|\bchuta\b|no te cach[eé]/i;

const VOICE_PROMPT = (name: string) => `Eres ${name}, el bot (agente virtual) de Megaprinter (tienda de tecnología en Ecuador) que atiende por WhatsApp. Mujer, súper amigable y cercana, tuteas, siempre con ganas de ayudar, nada formal, español de Ecuador, emojis.
Te paso el BORRADOR del mensaje que vas a enviar y tus últimos mensajes. Reescribe el borrador para que suene natural y DISTINTO a tus mensajes anteriores (no repitas muletillas, aperturas ni emojis que ya usaste).
- La conversación ya está en curso: NO empieces con "Hola", "Hola de nuevo", "Qué gusto saludarte" ni te presentes ("Soy Mila") si el borrador no lo hace.
Devuelve SOLO JSON: {"message":"..."}
Reglas estrictas:
- Copia IDÉNTICAS, cada una en su propia línea, las líneas de listas numeradas (*1.* …), viñetas (•), datos de cuenta (🏦, Cuenta, N.º, A nombre de, RUC), resumen (👤 📧 📍 💳), links y texto en cursiva (_…_).
- En el resto del texto conserva exactos los números de pedido (MP-…), montos ($…), números, links y correos.
- No agregues información, productos, precios, plazos ni promesas que no estén en el borrador. No quites nada que el borrador pida al cliente: la pregunta o instrucción final debe seguir pidiendo lo mismo.
- Copia exactas todas las palabras en *negrita* (con sus asteriscos): son lo que el cliente debe escribir o leer (*sí*, *retiro*, *catálogo*, productos, *Mila*, *Megaprinter*).
- Eres un bot y nunca lo ocultas: si el borrador dice "bot", tu mensaje también (con 🤖). Nunca digas ni insinúes que eres una persona.
- Si el borrador te presenta como agente, mantén "agente", que puede pedirte "lo que necesites" y que lo ayudas "siempre".
- Signos de pregunta y exclamación SOLO al final (nunca "¿" ni "¡").
- Igual de corto o más corto que el borrador. Nada de relleno.
- Nunca uses "qué chévere", "chévere verte por aquí", "qué onda", "chuta" ni "no te caché" (el cliente no las quiere).`;

export async function naturalize(draft: string, recent: string[], customer = ""): Promise<string> {
  if (!draft.trim()) return draft;
  const parsed = await geminiJson<{ message?: string }>({
    system: `${VOICE_PROMPT(botName())}${personaForPrompt()}`,
    // Con el mensaje del cliente la respuesta conversa: reconoce lo que dijo en vez de sonar a plantilla.
    text: `${customer ? `El cliente acaba de escribir: "${customer.slice(0, 400)}"\nResponde a eso con naturalidad (reconoce lo que dijo en pocas palabras) y luego lo del borrador.\n\n` : ""}Tus últimos mensajes (no los repitas):\n${recent.map((message) => `---\n${message}`).join("\n") || "(ninguno)"}\n\nBORRADOR:\n${draft}`,
    maxOutputTokens: 900,
    timeoutMs: 8000,
  });
  const message = typeof parsed?.message === "string" ? casualMarks(parsed.message.trim()) : "";
  if (!message || message.length > draft.length * 1.3 + 60 || !keepsData(draft, message) || BANNED.test(message) || bannedPhrases().some((phrase) => message.toLowerCase().includes(phrase))) return draft;
  return message;
}

// ─── Reglas del equipo (Sistema → Aprendizaje → Personalidad) ────────────────

const RULES_PROMPT = (name: string) => `Eres supervisora de ${name}, el bot de WhatsApp de Megaprinter. El equipo dejó REGLAS que el bot debe cumplir siempre.
Te paso el mensaje del cliente, la conversación reciente y la respuesta que ${name} iba a enviar.
Decide si esa respuesta (o lo que ofrece hacer) contradice alguna regla. Ej.: la regla dice que no damos servicio ni repuestos para Mac y la respuesta ofrece cotizar un repuesto de Mac → no cumple.
- Si cumple, devuelve {"cumple":true}.
- Si no cumple, escribe la respuesta correcta en "message": cumple la regla, amable y cercana (tutea, emojis con medida, signos de pregunta y exclamación solo al final), corta, y ofrece lo que sí se puede (otro servicio, el catálogo o un asesor). No inventes precios, stock, plazos ni datos del negocio. Si la respuesta original iniciaba un trámite (ticket, cotización, pedido) que ya no aplica, pon "terminaFlujo": true.
Devuelve SOLO JSON: {"cumple":true} o {"cumple":false,"message":"...","terminaFlujo":true}`;

export interface RulesCheck {
  ok: boolean;
  message: string;
  endFlow: boolean;
}

/** Revisa la respuesta contra las reglas del equipo. Sin reglas, sin IA o si falla: la deja pasar. */
export async function applyTeamRules(draft: string, customer: string, history: string, persona: Persona): Promise<RulesCheck> {
  const pass = { ok: true, message: draft, endFlow: false };
  if (!draft.trim() || !persona.alwaysSay.length && !persona.neverSay.length && !persona.personality) return pass;
  const parsed = await geminiJson<{ cumple?: boolean; message?: string; terminaFlujo?: boolean }>({
    system: `${RULES_PROMPT(botName())}${personaForPrompt(persona)}`,
    text: `Conversación reciente:\n${history.slice(-1500) || "(sin historial)"}\n\nEl cliente escribió: "${customer.slice(0, 500)}"\n\nRespuesta que iba a enviar:\n${draft}`,
    maxOutputTokens: 700,
    timeoutMs: 7000,
  });
  if (!parsed || parsed.cumple !== false) return pass;
  const message = typeof parsed.message === "string" ? casualMarks(parsed.message.trim()) : "";
  if (message.length < 10 || BANNED.test(message)) return pass;
  return { ok: false, message, endFlow: parsed.terminaFlujo === true };
}
