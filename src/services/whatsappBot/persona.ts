import { BotPersonaModel } from "../../models/botPersona.model";

/**
 * Lo que el equipo le pide a Mila desde el panel: personalidad, que decir
 * siempre y que no decir nunca. Cache de 1 min (cada instancia de Vercel lee
 * la base por su cuenta); al guardar en el panel se limpia al instante.
 */

export interface Persona {
  personality: string;
  alwaysSay: string[];
  neverSay: string[];
}

const EMPTY: Persona = { personality: "", alwaysSay: [], neverSay: [] };
const CACHE_MS = 60 * 1000;
let current: Persona = EMPTY;
let loadedAt = 0;

export async function loadPersona(force = false): Promise<Persona> {
  if (!force && Date.now() - loadedAt < CACHE_MS) return current;
  try {
    const doc: any = await BotPersonaModel.findById("persona").lean();
    current = doc ? { personality: doc.personality || "", alwaysSay: doc.alwaysSay || [], neverSay: doc.neverSay || [] } : EMPTY;
    loadedAt = Date.now();
  } catch (error) {
    console.error("[persona] no se pudo leer:", error instanceof Error ? error.message : error);
  }
  return current;
}

export const personaChanged = () => {
  loadedAt = 0;
};

/** Bloque para los prompts ("" si el equipo no configuro nada). */
export function personaForPrompt(persona: Persona = current) {
  const parts = [
    persona.personality ? `Personalidad que pidió el equipo: ${persona.personality}` : "",
    persona.alwaysSay.length ? `Siempre:\n${persona.alwaysSay.map((rule) => `- ${rule}`).join("\n")}` : "",
    persona.neverSay.length ? `Nunca digas ni hagas:\n${persona.neverSay.map((rule) => `- ${rule}`).join("\n")}` : "",
  ].filter(Boolean);
  if (!parts.length) return "";
  return `\n\nINDICACIONES DEL EQUIPO DE MEGAPRINTER (respétalas siempre; si chocan con las reglas estrictas de arriba, mandan esas reglas):\n${parts.join("\n\n")}`;
}

/** Frases entre comillas de "nunca digas…" que se pueden revisar literal en la salida de la voz. */
export function bannedPhrases(persona: Persona = current) {
  return persona.neverSay.flatMap((rule) => [...rule.matchAll(/["“”«»']([^"“”«»']{3,60})["“”«»']/g)].map((match) => match[1].toLowerCase()));
}
