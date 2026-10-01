import { normalize } from "./catalog";

/**
 * Detectores deterministas (regex). Deciden lo que no puede quedar en manos
 * de la IA: si/no al confirmar, correo, eleccion por numero, pedir persona.
 */

const has = (text: string, pattern: RegExp) => pattern.test(normalize(text));

export const isYes = (text: string) =>
  has(text, /^(si+|sii+|ok+|okey|dale|listo|claro|correcto|confirmo|confirmado|de una|va|vale|perfecto|asi es|esta bien|todo bien|exacto)\b/);

export const isNo = (text: string) => has(text, /^(no+|nop|nel|todavia no|aun no|espera|cambiar|corregir)\b/);

export const wantsHuman = (text: string) =>
  has(text, /\b(asesor|humano|persona|agente|alguien real|hablar con alguien|vendedor|reclamo|queja|estafa|devolucion|garantia)\b/);

export const wantsCatalog = (text: string) =>
  has(text, /\b(catalogo|que (productos )?tienen|que venden|productos|ofertas|lista de precios|menu)\b/);

export const wantsTracking = (text: string) =>
  has(text, /\b(mi pedido|mis pedidos|estado de(l)? pedido|mi orden|ya pague|ya transferi|cuando llega|seguimiento|numero de pedido|mp-?\d+)\b/);

export const wantsCancel = (text: string) =>
  has(text, /\b(cancela(r)?|ya no (lo )?quiero|olvidalo|vaciar( el)? carrito|borra(r)? (todo|el carrito))\b/);

export const isGreeting = (text: string) =>
  has(text, /^(hola+|buen(os|as)? (dias|tardes|noches)|buenas|saludos|hey|que tal)\b/) && normalize(text).split(" ").length <= 5;

export function detectPaymentMethod(text: string): "card" | "transfer" | null {
  const value = normalize(text);
  // Sin nombres de bancos: "Quito, Pichincha" es una direccion. El banco lo reconoce detectBank.
  if (/\b(transferencia|transfiero|transferir|deposito|depositar|banco|deuna)\b/.test(value)) return "transfer";
  if (/\b(tarjeta|credito|debito|link|enlace|payphone|visa|mastercard|diferido)\b/.test(value)) return "card";
  return null;
}

export const extractEmail = (text: string) => text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0]?.toLowerCase() || "";

/** "2", "la 2", "opcion 3", "el primero": posicion en la lista mostrada. */
export function extractChoice(text: string, max: number): number | null {
  const value = normalize(text);
  const ordinals: Record<string, number> = { primer: 1, primero: 1, primera: 1, segundo: 2, segunda: 2, tercero: 3, tercera: 3, tercer: 3, cuarto: 4, cuarta: 4, quinto: 5, quinta: 5 };
  const ordinal = Object.entries(ordinals).find(([word]) => new RegExp(`\\b${word}\\b`).test(value));
  const numeric = value.match(/^(?:(?:la|el|opcion|numero|nro|#)\s*)?(\d{1,2})$/);
  const choice = ordinal ? ordinal[1] : numeric ? Number(numeric[1]) : null;
  return choice && choice >= 1 && choice <= max ? choice : null;
}

/** Cantidad explicita: "2 laptops", "dos", "x3". */
export function extractQuantity(text: string): number | null {
  const value = normalize(text);
  const words: Record<string, number> = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 };
  // Solo al inicio ("2 laptops") o con x ("x2"): "core i5 8 gb" no es una cantidad.
  const digit = value.match(/^(\d{1,2})(?:\s|$)|\bx\s?(\d{1,2})\b/);
  if (digit) return Math.min(Number(digit[1] || digit[2]), 20) || null;
  const word = Object.entries(words).find(([key]) => new RegExp(`^${key}\\b`).test(value));
  return word ? word[1] : null;
}

export const orderNumberIn = (text: string) => text.match(/\bMP-?\s?(\d{1,6})\b/i)?.[1] || "";

/** Pide que no le escriban mas (politica de Meta: se respeta y se confirma). */
export const wantsOptOut = (text: string) =>
  has(text, /\b(no me escribas|no me vuelvas a escribir|deja de escribir(me)?|no quiero (mas )?mensajes|stop|darme de baja|no molestar|no gracias)\b/);

/** "eres un bot?", "hablo con una persona?", "eres real?": se responde con la verdad (soy un bot). */
export const asksIfBot = (text: string) =>
  has(text, /\b(eres (un |una )?(bot|robot|ia|inteligencia artificial|maquina|persona|humano|humana|real)|(hablo|estoy hablando) con (un |una )?(bot|robot|maquina|persona|humano|humana|ia)|es (un )?(bot|automatico)|sos (un )?bot)\b/);
