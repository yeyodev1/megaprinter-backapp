import { geminiJson } from "../gemini.service";
import { botName, casualMarks } from "./router";

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

/** El borrador y la version de la IA conservan exactamente los mismos datos. */
export function keepsData(draft: string, rewritten: string) {
  const output = rewritten.split("\n").map((line) => line.trim());
  return protectedLines(draft).every((line) => output.includes(line)) && protectedTokens(draft).every((token) => rewritten.includes(token));
}

const VOICE_PROMPT = (name: string) => `Eres ${name}, la agente de Megaprinter (tienda de tecnología en Ecuador) que atiende por WhatsApp. Mujer, súper amigable y cercana, tuteas, siempre con ganas de ayudar, nada formal, español de Ecuador, emojis.
Te paso el BORRADOR del mensaje que vas a enviar y tus últimos mensajes. Reescribe el borrador para que suene natural y DISTINTO a tus mensajes anteriores (no repitas saludos, muletillas, aperturas ni emojis que ya usaste).
Devuelve SOLO JSON: {"message":"..."}
Reglas estrictas:
- Copia IDÉNTICAS, cada una en su propia línea, las líneas de listas numeradas (*1.* …), viñetas (•), datos de cuenta (🏦, Cuenta, N.º, A nombre de, RUC), resumen (👤 📧 📍 💳), links y texto en cursiva (_…_).
- En el resto del texto conserva exactos los números de pedido (MP-…), montos ($…), números, links y correos.
- No agregues información, productos, precios, plazos ni promesas que no estén en el borrador. No quites nada que el borrador pida al cliente: la pregunta o instrucción final debe seguir pidiendo lo mismo.
- Mantén las *negritas* de WhatsApp. Signos de pregunta y exclamación SOLO al final (nunca "¿" ni "¡").
- Largo parecido al borrador; si el borrador es corto, el tuyo también.`;

export async function naturalize(draft: string, recent: string[]): Promise<string> {
  if (!draft.trim()) return draft;
  const parsed = await geminiJson<{ message?: string }>({
    system: VOICE_PROMPT(botName()),
    text: `Tus últimos mensajes (no los repitas):\n${recent.map((message) => `---\n${message}`).join("\n") || "(ninguno)"}\n\nBORRADOR:\n${draft}`,
    maxOutputTokens: 900,
    timeoutMs: 8000,
  });
  const message = typeof parsed?.message === "string" ? casualMarks(parsed.message.trim()) : "";
  if (!message || message.length > draft.length * 1.8 + 200 || !keepsData(draft, message)) return draft;
  return message;
}
