import { normalize } from "./catalog";

/**
 * Detectores deterministas (regex). Deciden lo que no puede quedar en manos
 * de la IA: si/no al confirmar, correo, eleccion por numero, pedir persona.
 */

const has = (text: string, pattern: RegExp) => pattern.test(normalize(text));

export const isYes = (text: string) =>
  has(text, /^(si+|sii+|ok+|okey|dale|listo|claro|correcto|confirmo|confirmado|de una|va|vale|perfecto|asi es|esta bien|todo bien|exacto)\b/);

export const isNo = (text: string) => has(text, /^(no+|nop|nel|todavia no|aun no|espera|cambiar|corregir)\b/);

/** "no me ha llegado la informacion" empieza con "no" pero no es un "no" al resumen. */
export const isShortNo = (text: string) => isNo(text) && normalize(text).split(" ").length <= 3;

export const wantsHuman = (text: string) =>
  has(text, /\b(asesor|humano|persona|agente|alguien real|hablar con alguien|vendedor|reclamo|queja|estafa|devolucion|garantia)\b/) ||
  // Chats reales (oct-2026): "puedo hablar no con un bot jeje", "Me puede atender".
  has(text, /\b(no (con )?(un |el )?bot|no quiero (hablar con )?(un |el )?bot|me (puede|pueden|podria|podrian) atender|atiendame|atenderme)\b/);

export const wantsCatalog = (text: string) =>
  has(text, /\b(catal[oa]gos?|que (productos )?tienen|que venden|productos|ofertas|lista de precios|menu|proforma)\b/);

export const wantsTracking = (text: string) =>
  has(text, /\b(mi pedido|mis pedidos|estado de(l)? pedido|mi orden|ya pague|ya transferi|cuando llega|seguimiento|numero de pedido|mp-?\d+)\b/);

export const wantsCancel = (text: string) =>
  has(text, /\b(cancela(r)?|ya no (lo )?quiero|olvidalo|vaciar( el)? carrito|borra(r)? (todo|el carrito))\b/);

// Chats reales (oct-2026): "estimada buenas tardes", "Ola buenas tarde", "hola amiga como esta", "Bendiciones", "👋👋".
const GREETING = /^((hola+|ola+|estimad[oa]s?|senor(a|ita)?|amig[oa]|muy|que tal)\s+)*(hola+|ola+|buen(os|as)?( (dias?|tardes?|noches?))?|buen dia|saludos|hey|que tal|bendiciones|como (esta|estas|le va))\b/;
export const isGreeting = (text: string) =>
  (has(text, GREETING) && normalize(text).split(" ").length <= 6) || /^[\s👋🙋🙌🤝😊🙂.!?‍♀♂️]+$/u.test(text.trim()) && /[👋🙋]/u.test(text);

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

/** "pagado", "ya pagué", "listo, pagué", "ya hice el pago": dice que ya pagó. */
export const claimsPaid = (text: string) =>
  has(text, /\b(pagado|ya pague+|ya pagamos|listo pague+|ya hice el pago|ya realice el pago|ya cancele|pago hecho|ya esta pagado|acabo de pagar)\b/);

/** Quiere servicio tecnico: reparar, mantenimiento, formateo, algo que falla. */
export const wantsService = (text: string) =>
  !has(text, MAINTENANCE_PART) &&
  (has(text, /\b(servicio tecnico|soporte tecnico|tecnico|reparar|reparacion|arreglar|mantenimiento|formatear|formateo|se (me )?dano|esta danad[ao]|no imprime|no enciende|no prende|no carga|no funciona|falla|revisen|revisar mi|diagnostico|tiene problemas?|no detecta|no sale(n)? (todos )?(los )?colores)\b/) ||
  // "ha tenido problemas para imprimir los colores y salen distorsionados" (chat real).
  has(text, /\b((ha|han|habia) tenido problemas?|tuvo problemas?|(esta|estan) dando problemas?|da problemas?|salen? (distorsionad|borros|manchad|rayad|corrid|en blanco)\w*|imprime (mal|borroso|corrido|manchado))\b/));

/** Kit o caja de mantenimiento: es una pieza que se vende (suministro), no la revision del tecnico. */
export const MAINTENANCE_PART = /\b(kit|caja|cajas|tanque) de mantenimiento|almohadillas?\b/;

/** Quiere suministros: tinta, toner, cartuchos, papel, repuestos. */
export const wantsSupplies = (text: string) =>
  has(text, /\b(suministro|suministros|tinta|tintas|toner|cartucho|cartuchos|botella de tinta|cinta|papel|resmas?|repuesto|repuestos|consumible|consumibles|cargador|adaptador|cabezal(es)?|encoder|bateria|parlantes?|bisagra|fuente de poder)\b/) || has(text, MAINTENANCE_PART);

/** Repuestos y accesorios que no estan en el catalogo: se cotizan como suministros. */
export const PARTS = /\b(repuestos?|cargador(es)?|adaptador(es)?|cabezal(es)?|encoder|bateria|parlantes?|bisagra|fuente de poder|(kit|caja|cajas|tanque) de mantenimiento|almohadillas?)\b/;

/** Donde queda la tienda / horarios. "direccion" sola tambien (fuera del paso de direccion). */
export const asksStoreInfo = (text: string) =>
  has(text, /\b(ubicacion|ubicaciones|ubican|ubicados|donde (estan|quedan|queda|se encuentran|los encuentro)|direccion (de la tienda|del local|de su local|de sus locales|de ustedes)|su local|sus locales|sucursal(es)?|horarios?|a que hora (abren|cierran|atienden)|abren|cierran|atienden (los )?(sabados|domingos|hoy))\b/) ||
  has(text, /^(la )?direccion\??$/);

/** Va a ir a la tienda o ya le mando datos a una persona: "ya seria para ir en 1 hora a realizar la compra", "envie direccion". */
export const coordinatesVisit = (text: string) =>
  has(text, /\b((para|voy a|vamos a|puedo|podemos) ir (a|al|en|hoy|manana|ahorita)|ir en \d+|envie (la |mi )?(direccion|ubicacion))\b/);

/** Horario sin mas (para responder solo eso). */
export const asksOnlyHours = (text: string) => has(text, /\b(horarios?|a que hora|abren|cierran)\b/) && !has(text, /\b(ubica|donde|direccion|local|sucursal)/);

/**
 * Sigue un caso que ya lleva una persona: equipo en el taller, "me confirma",
 * "alguna novedad", codigo de orden. El bot no tiene esa informacion: pasa a un asesor.
 */
export const followsUpCase = (text: string) =>
  has(
    text,
    /\b(deje (mi|el|la|una|un)|que deje|dejo mi|el tecnico dejo|retirar (el|la|mi) (equipo|maquina|laptop|impresora|computadora)|retiro de mi|alguna novedad|hay novedad(es)?|no me (han|ha) (dicho|respondido|contestado|escrito)|me dej(o|e) en visto|nome deje en visto|ya esta (lista|listo|reparad[ao])|cuanto(s)? dias (tarda|demora)|cuanto (tiempo )?(tarda|demora) la reparacion|codigo \d+|orden de (ingreso|servicio|trabajo)|quedara bien|esa contrasena|cancelar la diferencia)\b/,
  ) ||
  // "q novedad me tiene", "no me dan respuesta sobre mi maquina", "lleve mi impresora a un arreglo",
  // "el dia lunes compre una impresora canon", "Orden 1241" (chats reales oct-2026).
  has(
    text,
    /\b(novedad(es)?|no me (dan|dieron|han dado) (respuesta|razon)|(lleve|llevamos|deje|dejamos) (mi|la|el|una|un|nuestra) (impresora|laptop|maquina|equipo|computadora|pc|monitor|camara)|orden (n[or]?\.? ?)?\d{3,}|(mi|la) orden de)\b/,
  ) ||
  // Compra pasada sin contar una falla ("el dia lunes compre una impresora canon"); si cuenta la falla es servicio tecnico.
  (has(text, /\b(le |la |lo )?(compre|compramos) (una|un|la|el|mi)? ?(impresora|laptop|equipo|maquina|monitor|camara|computadora)\b/) && !wantsService(text)) ||

  // "me confirma amiga", "me avisa", "me indica porfavor": solos, sin pedir un producto.
  (has(text, /^(me (confirma|avisa|indica)n?|confirmeme|me avisa para ir)\b/) && normalize(text).split(" ").length <= 5 && !has(text, /\b(precio|cuanto|tienen|hay)\b/));

/** Mensajes de relleno: "ok", "bueno", "gracias", "deme un momento", "Mmm, entiendo. Continúa." (solo esas palabras). */
const ACK_WORDS = new Set(
  "si sii ok okey okay bueno listo dale gracias muchas mil vale perfecto entiendo entendido ya ah mmm mm continua continue deme un momento espere espera vuelvo estamos a la orden por favor porfa amiga amigo genial chevere excelente de nada".split(" "),
);
export const isAck = (text: string) => {
  // "A4", "L3250": con numeros es un dato, no relleno (chat real: "A4" respondia "De una 😊").
  if (/\d/.test(text)) return false;
  const words = normalize(text).replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 6 && words.every((word) => ACK_WORDS.has(word) || /^m+$/.test(word) || /^o+k+$/.test(word));
};

/** Duda o "lo pienso": no es un dato para el pedido. */
export const isHesitation = (text: string) =>
  has(text, /\b(averiguar|averiguando|lo pienso|pensarlo|pensar|mas tarde|luego te|despues te|primero voy|todavia no|aun no se|deme un momento|un momento|en una hora)\b/);

/** Pago en efectivo (por aqui solo hay tarjeta o transferencia). */
export const wantsCash = (text: string) => has(text, /\b(efectivo|cash|pago en (el )?local|pagar en (el )?local|pago al retirar|contra ?entrega)\b/);

/** Pregunta el precio de la revision / reparacion (el diagnostico es sin costo). */
export const asksServicePrice = (text: string) =>
  !has(text, MAINTENANCE_PART) &&
  has(text, /\b(precio|costo|cuanto|vale|cobran)\b.*\b(revision|diagnostico|reparacion|mantenimiento|arreglo|limpieza)\b|\b(revision|diagnostico|reparacion|mantenimiento)\b.*\b(precio|costo|cuanto|vale|cobran)\b/);

/** "me quedo con la opcion 1" cuando el bot no mostro opciones: se las dio un asesor. */
export const refersToOption = (text: string) => has(text, /\b(opcion|la numero|el numero)\s*\d\b/);

/** Pide un numero de telefono para llamar o escribir ("me ayudas con el numero", "cual es el numero?"). */
export const asksContactNumber = (text: string) =>
  // "me pasas el numero de cuenta" son los datos para transferir, no un telefono.
  !has(text, /\b(cuentas?|pedido|orden|ticket|cedula|ruc|serie)\b/) &&
  (has(text, /\b(numero (de )?(telefono|celular|contacto|whatsapp|del cliente|de ustedes|de la tienda|del local|para llamar)|telefono (de|del) (la tienda|ustedes|local)|a que numero (llamo|escribo|me comunico)|me (ayuda|ayudas|da|das|pasa|pasas) (con )?(el|un|su) numero)\b/) ||
  has(text, /^(y )?(cual|cual es) (el|su) numero\??$/));

/** Escribe en ingles (proveedores, spam): el bot solo atiende en espanol, pasa a una persona. */
export const looksEnglish = (text: string) =>
  normalize(text).split(" ").filter((word) => /^(the|and|your|you|with|would|like|company|our|we|are|is|from|which|good|day|how|please|send|more|details|interested|cooperation)$/.test(word)).length >= 3;
