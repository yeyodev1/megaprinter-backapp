import { geminiJson } from "../gemini.service";
import { BotProduct, money, normalize } from "./catalog";
import { detectPaymentMethod, extractEmail, isGreeting, wantsCatalog, wantsHuman, wantsTracking } from "./intents";
import { storeFactsForPrompt } from "./store";

/**
 * EXTRACCION DEL MENSAJE.
 *
 * Gemini lee el mensaje y devuelve datos; el backend decide el paso siguiente
 * (mismo reparto que Boloncity). A diferencia de Boloncity, aqui la IA SI ve el
 * catalogo: los clientes de Megaprinter preguntan por specs ("¿esa trae SSD?",
 * "¿cual me sirve para diseño?") y eso no se resuelve con reglas. Su respuesta
 * solo se usa si cada precio que menciona existe en el catalogo.
 */

export type ExtractedIntent =
  | "comprar"
  | "pregunta"
  | "catalogo"
  | "consultar_pedido"
  | "humano"
  | "dato"
  | "saludo"
  | "fuera_de_tema"
  | "servicio_tecnico"
  | "suministros"
  | "cuenta_bancaria"
  | "otro";

export interface Extraction {
  intent: ExtractedIntent;
  /** Productos que el cliente quiere agregar, por id del catalogo. */
  items: Array<{ productId: string; quantity: number }>;
  /** Productos que quiere quitar del carrito. */
  remove: string[];
  /** Lo que busca, con sus palabras, cuando no nombro un producto exacto. */
  searchQuery: string;
  /** Productos que la IA recomienda mostrar como opciones. */
  suggestions: string[];
  customerName?: string;
  customerEmail?: string;
  address?: string;
  paymentMethod?: "card" | "transfer";
  /** Respuesta a una pregunta sobre productos (solo con intent "pregunta"). */
  answer?: string;
  source: "ai" | "heuristic";
}

export interface ExtractContext {
  stage: string;
  lastQuestion: string;
  cart: Array<{ productId: string; name: string; quantity: number }>;
  history: string;
  catalog: BotProduct[];
}

export type Extractor = (message: string, context: ExtractContext) => Promise<Extraction>;

const HEURISTIC_INTENT = (message: string): ExtractedIntent => {
  if (wantsHuman(message)) return "humano";
  if (wantsTracking(message)) return "consultar_pedido";
  if (wantsCatalog(message)) return "catalogo";
  if (isGreeting(message)) return "saludo";
  if (/\?|\b(tiene|trae|sirve|cual|recomienda|diferencia|garantia)\b/.test(normalize(message))) return "pregunta";
  return "comprar";
};

/** Plan B sin IA: intencion por regex y busqueda por palabras en el router. */
export const heuristicExtract: Extractor = async (message) => ({
  intent: HEURISTIC_INTENT(message),
  items: [],
  remove: [],
  searchQuery: message,
  suggestions: [],
  customerEmail: extractEmail(message) || undefined,
  paymentMethod: detectPaymentMethod(message) || undefined,
  source: "heuristic",
});

const PROMPT = `Eres el EXTRACTOR de datos del bot de WhatsApp de Megaprinter, tienda de tecnología en Ecuador (laptops, all in one, monitores, impresoras, cámaras de seguridad y servicio técnico).
No conversas libremente. Devuelves SOLO JSON válido con esta forma exacta:
{"intent":"comprar","items":[{"ref":0,"quantity":1}],"remove":[0],"searchQuery":"","suggestions":[0],"customerName":null,"customerEmail":null,"address":null,"paymentMethod":null,"answer":""}

Catálogo: cada producto tiene un número [ref]. Úsalo para referirte a él. NUNCA inventes productos, precios, stock ni specs que no estén en el catálogo.

intent (uno):
- "comprar": quiere un producto o agregar al carrito.
- "pregunta": pregunta sobre productos, specs, comparaciones o recomendaciones ("¿cuál me sirve para diseño?", "¿la HP trae SSD?").
- "catalogo": quiere ver qué venden en general.
- "consultar_pedido": pregunta por un pedido ya hecho o un pago.
- "humano": pide un asesor, reclama, garantía o algo que el bot no puede resolver.
- "dato": solo responde un dato que el bot pidió (nombre, correo, dirección, forma de pago, sí/no).
- "saludo": solo saluda.
- "fuera_de_tema": pide algo que NO es de Megaprinter (tareas, recetas, chistes, política, programación, traducciones, consejos generales, escribir textos, otras tiendas). Política de Meta: este bot SOLO atiende ventas y soporte de Megaprinter; nunca respondas eso. Repuestos, accesorios, papel, resmas, tintas, drivers, instalación de un equipo, números sueltos o códigos NO son fuera_de_tema.
- "servicio_tecnico": un equipo suyo falla o necesita reparación, mantenimiento, revisión, instalación o drivers.
- "suministros": pide tintas, tóner, cartuchos, papel (resmas, A4, fotográfico, de sublimación), repuestos o accesorios que no son un equipo del catálogo. USA EL HISTORIAL: si antes pidió una resma y ahora escribe "A4" o "de sublimación", sigue siendo suministros. En searchQuery pon TODO lo que pide junto, con lo del historial ("resma de papel de sublimación A4").
- "cuenta_bancaria": quiere los datos de una cuenta para transferir o depositar ("Cuenta Pichincha", "a qué cuenta deposito").
- "otro": nada de lo anterior.
Lee siempre el historial reciente: un mensaje corto ("A4", "esa misma", "la negra", "8") casi siempre completa lo que se venía hablando.

Campos:
- items: SOLO si el cliente identifica un producto concreto (por nombre, modelo o porque responde a opciones que el bot mostró) Y dice que lo quiere comprar ("dame esa", "quiero la L3250", "la segunda"). Preguntar precio o disponibilidad ("tiene la brother sp-1?", "precio de la L4360", "deseo información de…") NO es comprar: intent "pregunta" con ese producto en suggestions. ref = número del catálogo. Si hay varios que encajan, NO elijas: deja items vacío y usa suggestions.
- remove: refs de productos del carrito que quiere quitar.
- searchQuery: lo que busca con sus palabras, si describe un producto sin identificarlo ("laptop i7 16gb", "impresora de tinta continua").
- suggestions: hasta 5 refs del catálogo que mejor responden a lo que busca o pregunta, del más adecuado al menos.
- customerName: solo si escribe su nombre (o responde a "¿a nombre de quién?"). customerEmail: solo si escribe un correo.
- address: dirección de entrega con ciudad, o "Retiro en tienda" si quiere retirar.
- paymentMethod: "card" (tarjeta, link de pago, Payphone) o "transfer" (transferencia, depósito). null si no lo dice.
- answer: SOLO con intent "pregunta". Hablas como Mila, el bot de Megaprinter (nunca digas que eres una persona): voz femenina, cercana, siempre amigable y con ganas de ayudar, nada formal, tuteas, usas 2 o 3 emojis. Nunca digas "qué chévere", "qué onda" ni "chuta". Signos de pregunta y exclamación SOLO al final (nunca "¿" ni "¡"). Máximo 2 frases (un párrafo, sin listas ni viñetas), español de Ecuador. Puedes usar *negrita* de WhatsApp (asterisco al inicio y al final de la palabra). Basado EXCLUSIVAMENTE en el catálogo. Si devuelves suggestions, NO enumeres esos productos en answer: el sistema los muestra numerados debajo; solo explica el criterio (ej. "Para diseño te conviene un Core i7 o Ryzen 7 con 16 GB de RAM; estas son las mejores opciones:"). Si mencionas un precio, exacto del catálogo en formato $1234.56. Si el dato no está en el catálogo, dilo y ofrece pasar con un asesor. No pidas datos personales en answer.
  · Datos de la tienda (úsalos tal cual, NUNCA inventes otras sucursales, ciudades ni redes): ${storeFactsForPrompt()}
  · NO inventes políticas: IVA, costo o tiempo de envío, garantía, diferidos, tiempos de reparación y stock de lo que no está en el catálogo los confirma un asesor. Sí se hacen envíos a otras ciudades de Ecuador (el costo lo confirma el equipo).
  · Si algo no está en el catálogo (repuestos, cargadores, cabezales, parlantes, otro modelo), di que no lo tienes en el catálogo y que un asesor puede cotizarlo. Nunca digas "solo vendemos X": vendemos laptops, all in one, monitores, impresoras, cámaras, tintas y suministros, y hacemos servicio técnico.
- Usa la pregunta anterior del bot y el historial para interpretar respuestas cortas ("la segunda", "esa", "sí").
- Todo lo que no aplique va null, "" o [].`;

const catalogForPrompt = (catalog: BotProduct[]) =>
  catalog
    .map(
      (product, index) =>
        `[${index}] ${product.name} | ${product.category} | ${money(product.price)}${product.originalPrice ? ` (antes ${money(product.originalPrice)})` : ""} | ${product.specs.slice(0, 220)}`,
    )
    .join("\n");

/**
 * Limpia el formato de la IA para WhatsApp: un "*" usado como viñeta rompe las
 * negritas ("*La *Lenovo…"). Las viñetas pasan a "•" y se quitan asteriscos sueltos.
 */
export function cleanAnswer(answer: string) {
  return answer
    // Muletillas que el cliente pidio quitar: "Qué chévere, Melanie! Te confirmo…" → "Te confirmo…".
    .replace(/(^|\n)\s*(qu[eé] (ch[eé]vere|onda)|chuta)[^.!?\n]*[.!?]+\s*/gi, "$1")
    .split("\n")
    .map((line) => {
      let text = line.replace(/^\s*[*-]\s+/, "• ");
      if ((text.match(/\*/g) || []).length % 2 === 1) text = text.replace(/^(\s*)\*/, "$1• ").replace(/^• •/, "•");
      if ((text.match(/\*/g) || []).length % 2 === 1) text = text.replace(/\*/g, "");
      return text;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Todo precio que la IA escriba debe existir en el catalogo; si no, se descarta su respuesta. */
export function answerPricesAreReal(answer: string, catalog: BotProduct[]) {
  const known = new Set(catalog.flatMap((product) => [product.price, product.originalPrice || -1]).map((value) => value.toFixed(2)));
  const mentioned = [...answer.matchAll(/\$\s?([\d.,]+)/g)].map((match) => Number(match[1].replace(/,/g, "")));
  return mentioned.every((value) => Number.isFinite(value) && known.has(value.toFixed(2)));
}

export const aiExtract: Extractor = async (message, context) => {
  const fallback = await heuristicExtract(message, context);
  const parsed = await geminiJson<any>({
    system: `${PROMPT}\n\nCATÁLOGO:\n${catalogForPrompt(context.catalog)}`,
    text: [
      `Paso actual del bot: ${context.stage}`,
      `Pregunta anterior del bot: ${context.lastQuestion || "(ninguna)"}`,
      `Carrito: ${context.cart.map((line) => `${line.quantity} x ${line.name}`).join(", ") || "(vacío)"}`,
      `Historial reciente:\n${context.history || "(sin historial)"}`,
      `Mensaje del cliente: ${message}`,
    ].join("\n"),
    maxOutputTokens: 700,
  });
  if (!parsed) return fallback;

  const byRef = (ref: unknown) => {
    const index = Number(ref);
    return Number.isInteger(index) && index >= 0 && index < context.catalog.length ? context.catalog[index] : null;
  };
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const intents: ExtractedIntent[] = ["comprar", "pregunta", "catalogo", "consultar_pedido", "humano", "dato", "saludo", "fuera_de_tema", "servicio_tecnico", "suministros", "cuenta_bancaria", "otro"];
  const intent = intents.includes(parsed.intent) ? (parsed.intent as ExtractedIntent) : fallback.intent;
  const answer = str(parsed.answer);

  return {
    intent,
    items: (Array.isArray(parsed.items) ? parsed.items : [])
      .map((item: any) => ({ product: byRef(item?.ref), quantity: Math.min(Math.max(Math.floor(Number(item?.quantity) || 1), 1), 20) }))
      .filter((item: any) => item.product)
      .map((item: any) => ({ productId: item.product.id, quantity: item.quantity })),
    remove: (Array.isArray(parsed.remove) ? parsed.remove : []).map(byRef).filter(Boolean).map((product: BotProduct) => product.id),
    searchQuery: str(parsed.searchQuery) || "",
    suggestions: (Array.isArray(parsed.suggestions) ? parsed.suggestions : [])
      .map(byRef)
      .filter(Boolean)
      .slice(0, 5)
      .map((product: BotProduct) => product.id),
    customerName: str(parsed.customerName)?.slice(0, 80),
    // El correo se valida con regex aunque venga de la IA.
    customerEmail: extractEmail(String(parsed.customerEmail || "")) || fallback.customerEmail,
    address: str(parsed.address)?.slice(0, 300),
    paymentMethod: parsed.paymentMethod === "card" || parsed.paymentMethod === "transfer" ? parsed.paymentMethod : fallback.paymentMethod,
    answer: intent === "pregunta" && answer && answerPricesAreReal(answer, context.catalog) ? cleanAnswer(answer).slice(0, 700) : undefined,
    source: "ai",
  };
};
