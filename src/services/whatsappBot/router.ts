import { BankDetails, bankText } from "../transfer.service";
import { BotProduct, catalogOverview, money, normalize, productLine, searchProducts } from "./catalog";
import { Extraction, Extractor } from "./extractor";
import { detectPaymentMethod, extractChoice, extractEmail, isGreeting, isNo, isYes, orderNumberIn, wantsCancel, wantsCatalog, wantsHuman, wantsTracking } from "./intents";

/**
 * MAQUINA DE ESTADOS DEL BOT DE WHATSAPP.
 *
 * Funcion pura: recibe el estado guardado y el mensaje, devuelve el estado
 * nuevo y la respuesta. Todo lo externo (Mongo, Gemini, Cloudinary) entra por
 * `BotDeps`, asi las pruebas corren sin red. El backend decide cada paso;
 * BuilderBot solo envia `{message}` y enruta por `intencion`.
 *
 * Reglas, en orden: R0 control · R1 comprobante · R2 humano · R3 pedidos ·
 * R4 cancelar · R5 eleccion · R6 datos del paso · R7 confirmar · R8 catalogo y
 * preguntas · R9 siguiente paso.
 */

export type Stage = "idle" | "choosing" | "name" | "email" | "address" | "payment" | "confirm" | "ordered";

export interface CartLine {
  productId: string;
  name: string;
  price: number;
  quantity: number;
}

export interface BotState {
  stage: Stage;
  cart: CartLine[];
  /** Opciones numeradas que el bot acaba de mostrar (para "la 2"). */
  options: Array<{ productId: string; name: string; price: number }>;
  customerName: string;
  customerEmail: string;
  address: string;
  paymentMethod: "card" | "transfer" | null;
  orderId: string;
  orderNumber: string;
  lastQuestion: string;
}

export const createInitialState = (): BotState => ({
  stage: "idle",
  cart: [],
  options: [],
  customerName: "",
  customerEmail: "",
  address: "",
  paymentMethod: null,
  orderId: "",
  orderNumber: "",
  lastQuestion: "",
});

/** Intencion para las Rules de BuilderBot. */
export type Intent = "conversar" | "menu" | "dudas" | "consultar_pedido" | "orden_creada" | "comprobante_recibido";
/**
 * Decision para las Rules de BuilderBot (campo `route`). El mensaje ya viene
 * listo en `message`; la ruta solo dice a que flow saltar despues de enviarlo.
 * Ver docs/whatsapp-bot.md (seccion "Flujos").
 */
export const ROUTES = [
  "conversation", // seguir conversando (sin Rule)
  "catalog", // mostro el resumen del catalogo
  "confirmOrder", // mostro el resumen del pedido y espera "si"
  "checkoutCard", // pedido creado, pago con tarjeta (link en paymentLink)
  "checkoutTransfer", // pedido creado, pago por transferencia (espera comprobante)
  "checkoutAdvisor", // pedido creado sin metodo de pago: lo cierra un asesor
  "awaitingReceipt", // pedido por transferencia abierto: se pidio la foto del comprobante
  "receiptReceived", // llego el comprobante, queda en revision
  "searchOrder", // respondio el estado de sus pedidos
  "human", // pidio una persona: silenciar el bot
] as const;
export type Route = (typeof ROUTES)[number];

export interface TurnResult {
  state: BotState;
  reply: string;
  route: Route;
  intent: Intent;
  step: Stage;
  decision: string;
  orderNumber?: string;
  paymentLink?: string;
  paymentMethod?: "card" | "transfer" | null;
  total?: number;
}

export interface TurnInput {
  message: string;
  /** URL del archivo que mando el cliente (comprobante). */
  mediaUrl?: string;
  /** Llego una imagen/audio pero BuilderBot no mando su URL. */
  mediaWithoutUrl?: boolean;
  history?: string;
}

export interface CreatedOrder {
  orderId: string;
  orderNumber: string;
  total: number;
  paymentLink: string;
}

export type ReceiptOutcome =
  | { status: "stored"; orderNumber: string; total: number; detectedAmount: number | null; amountMatches: boolean | null; isReceipt: boolean | null }
  | { status: "no_order"; image?: { kind: "receipt" | "product" | "other"; description: string; searchQuery: string } }
  | { status: "unsupported" | "error" };

export interface OrderSummary {
  id: string;
  orderNumber: string;
  status: string;
  source: string;
  total: number;
  transferStatus: string;
  paymentLink: string;
  createdAt: Date;
}

export interface BotDeps {
  loadCatalog: () => Promise<BotProduct[]>;
  extract: Extractor;
  createOrder: (state: BotState) => Promise<CreatedOrder>;
  receiveReceipt: (orderId: string, mediaUrl: string) => Promise<ReceiptOutcome>;
  /** Pedidos del telefono del chat, o el pedido con ese numero ("MP-00012"). */
  findOrders: (orderNumber?: string) => Promise<OrderSummary[]>;
  bank: BankDetails | null;
  cardEnabled: boolean;
  supportPhone: string;
  storeUrl: string;
}

// ─── Textos ──────────────────────────────────────────────────────────────────

const QUESTIONS: Record<Exclude<Stage, "idle" | "choosing" | "confirm" | "ordered">, string> = {
  name: "¿A nombre de quién va el pedido? (nombre y apellido)",
  email: "¿Me compartes tu correo? Ahí te llega la confirmación 📧",
  address: "¿A qué dirección y ciudad te lo enviamos? Si prefieres retirar en tienda, escribe *retiro*",
  payment: "¿Cómo prefieres pagar?\n*1.* Tarjeta (te mando un link seguro de Payphone)\n*2.* Transferencia bancaria",
};

const ASK_PRODUCT = "¿Qué estás buscando? 💻🖨️ Escríbeme algo como \"laptop i7 16GB\", \"impresora de tinta continua\" o pídeme el *catálogo*";

export const FALLBACK_MESSAGE = ASK_PRODUCT;

const paymentLabel = (method: BotState["paymentMethod"]) =>
  method === "card" ? "Tarjeta (link de Payphone)" : method === "transfer" ? "Transferencia bancaria" : "Por definir";

export const cartTotal = (cart: CartLine[]) => Math.round(cart.reduce((sum, line) => sum + line.price * line.quantity, 0) * 100) / 100;

const cartLines = (cart: CartLine[]) =>
  cart.map((line) => `• ${line.quantity} × ${line.name} — ${money(line.price * line.quantity)}`).join("\n");

export function formatSummary(state: BotState) {
  return [
    "Revisa tu pedido 🧾",
    "",
    cartLines(state.cart),
    `*Total: ${money(cartTotal(state.cart))}*`,
    "",
    `👤 ${state.customerName}`,
    `📧 ${state.customerEmail}`,
    `📍 ${state.address}`,
    `💳 ${paymentLabel(state.paymentMethod)}`,
    "",
    "¿Confirmo el pedido? Responde *sí* o dime qué cambio",
  ].join("\n");
}

function transferInstructions(order: CreatedOrder, bank: BankDetails) {
  return [
    `¡Listo! Tu pedido *${order.orderNumber}* quedó registrado 🎉`,
    "",
    `Transfiere *${money(order.total)}* a esta cuenta:`,
    bankText(bank),
    "",
    "Cuando hagas la transferencia, envíame por aquí la *foto del comprobante* 📸 y nuestro equipo la valida.",
  ].join("\n");
}

function cardInstructions(order: CreatedOrder) {
  return [
    `¡Listo! Tu pedido *${order.orderNumber}* quedó registrado 🎉`,
    "",
    `Paga *${money(order.total)}* con tarjeta en este link seguro de Payphone:`,
    order.paymentLink,
    "",
    "Apenas se apruebe el pago te confirmamos y coordinamos la entrega 🚚",
  ].join("\n");
}

const STATUS_TEXT: Record<string, string> = {
  pending: "pendiente de pago",
  whatsapp: "registrado, un asesor te contacta",
  paid: "pagado ✅",
  processing: "en preparación 📦",
  delivered: "entregado ✅",
  cancelled: "cancelado",
};

export function orderStatusLine(order: OrderSummary) {
  let status = STATUS_TEXT[order.status] || order.status;
  if (order.source === "transfer" && order.status === "pending") {
    status =
      order.transferStatus === "in_review"
        ? "comprobante en revisión 🔎"
        : order.transferStatus === "rejected"
          ? "comprobante no válido, envíanos uno nuevo"
          : "esperando el comprobante de transferencia";
  }
  return `• *${order.orderNumber}* — ${money(order.total)} — ${status}`;
}

// ─── Helpers de estado ───────────────────────────────────────────────────────

function addToCart(state: BotState, product: { productId: string; name: string; price: number }, quantity: number) {
  const existing = state.cart.find((line) => line.productId === product.productId);
  if (existing) existing.quantity = Math.min(existing.quantity + quantity, 20);
  else state.cart.push({ ...product, quantity: Math.min(quantity, 20) });
}

const toOption = (product: BotProduct) => ({ productId: product.id, name: product.name, price: product.price });

/** Primer dato que falta para cerrar el pedido. */
function missingStage(state: BotState, deps: BotDeps): Stage {
  if (!state.cart.length) return "idle";
  if (!state.customerName) return "name";
  if (!state.customerEmail) return "email";
  if (!state.address) return "address";
  if (!state.paymentMethod) {
    // Con un solo metodo disponible no se pregunta.
    if (deps.cardEnabled && !deps.bank) state.paymentMethod = "card";
    else if (!deps.cardEnabled && deps.bank) state.paymentMethod = "transfer";
    else if (deps.cardEnabled && deps.bank) return "payment";
  }
  return "confirm";
}

const looksLikeName = (text: string) => {
  const value = text.trim();
  return /^[\p{L}][\p{L}' .-]{1,60}$/u.test(value) && value.split(/\s+/).length <= 5 && !isYes(value) && !isNo(value) && !isGreeting(value);
};

/** Aplica los datos que el cliente haya dado en cualquier momento (suelen mandar todo junto). */
function applyCustomerData(state: BotState, extraction: Extraction, message: string) {
  if (extraction.customerName) state.customerName = extraction.customerName;
  const email = extractEmail(message) || extraction.customerEmail;
  if (email) state.customerEmail = email;
  if (extraction.address) state.address = extraction.address;
  if (extraction.paymentMethod) state.paymentMethod = extraction.paymentMethod;
}

/** Datos del paso actual, con reglas (sirven aunque la IA este caida). */
function applyStageAnswer(state: BotState, message: string, deps: BotDeps): boolean {
  const text = message.trim();
  switch (state.stage) {
    case "name": {
      // "Luis Mora luis@mail.com": el correo ya se guardo, el resto es el nombre.
      const withoutEmail = text.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "").replace(/[,;]/g, " ").trim();
      if (!state.customerName && looksLikeName(withoutEmail)) state.customerName = withoutEmail.replace(/\s+/g, " ");
      return Boolean(state.customerName);
    }
    case "email":
      return Boolean(state.customerEmail);
    case "address":
      if (!state.address) {
        if (/\bretir/i.test(normalize(text))) state.address = "Retiro en tienda";
        else if (text.length >= 6 && !isYes(text) && !isNo(text)) state.address = text.slice(0, 300);
      }
      return Boolean(state.address);
    case "payment": {
      if (!state.paymentMethod) {
        const choice = extractChoice(text, 2);
        state.paymentMethod = detectPaymentMethod(text) || (choice === 1 ? "card" : choice === 2 ? "transfer" : null);
      }
      if (state.paymentMethod === "transfer" && !deps.bank) state.paymentMethod = null;
      if (state.paymentMethod === "card" && !deps.cardEnabled) state.paymentMethod = null;
      return Boolean(state.paymentMethod);
    }
    default:
      return false;
  }
}

function reply(state: BotState, text: string, decision: string, extra: Partial<TurnResult> = {}): TurnResult {
  state.lastQuestion = text.slice(-300);
  return { state, reply: text, route: "conversation", intent: "conversar", step: state.stage, decision, ...extra };
}

/** Pregunta por lo que falta (o muestra el resumen), con un prefijo opcional. */
function askNext(state: BotState, deps: BotDeps, decision: string, prefix = ""): TurnResult {
  state.stage = missingStage(state, deps);
  const join = (text: string) => (prefix ? `${prefix}\n\n${text}` : text);
  if (state.stage === "idle") return reply(state, join(ASK_PRODUCT), decision);
  if (state.stage === "confirm") return reply(state, join(formatSummary(state)), decision, { route: "confirmOrder" });
  const question = QUESTIONS[state.stage as keyof typeof QUESTIONS];
  return reply(state, join(question), decision);
}

function showOptions(state: BotState, products: BotProduct[], decision: string, intro?: string): TurnResult {
  state.options = products.map(toOption);
  state.stage = "choosing";
  const list = products.map((product, index) => productLine(product, index + 1)).join("\n");
  const ask = products.length === 1 ? "¿Te lo agrego al pedido? Responde *sí* o *1*" : "¿Cuál te agrego? Responde con el número";
  return reply(state, `${intro || "Mira estas opciones 👇"}\n\n${list}\n\n${ask}`, decision);
}

// ─── Turno ───────────────────────────────────────────────────────────────────

export async function handleTurn(previous: BotState, input: TurnInput, deps: BotDeps): Promise<TurnResult> {
  const state: BotState = JSON.parse(JSON.stringify({ ...createInitialState(), ...previous }));
  const message = input.message.trim();

  // R1: comprobante de transferencia (imagen o PDF).
  if (input.mediaUrl) {
    const outcome = await deps.receiveReceipt(state.orderId, input.mediaUrl);
    if (outcome.status === "stored") {
      const warning =
        outcome.isReceipt === false
          ? "\n\nOjo: la imagen no parece un comprobante bancario. Si te equivocaste, envíame la foto correcta 🙏"
          : outcome.amountMatches === false && outcome.detectedAmount !== null
            ? `\n\nOjo: leí un monto de ${money(outcome.detectedAmount)} y tu pedido es de ${money(outcome.total)}. Si falta una parte, envíame también ese comprobante.`
            : "";
      return reply(
        state,
        `¡Gracias! Recibí tu comprobante del pedido *${outcome.orderNumber}* 🙌 Nuestro equipo lo revisa y te confirmamos por aquí apenas se valide el pago.${warning}`,
        "R1:comprobante",
        { intent: "comprobante_recibido", route: "receiptReceived", orderNumber: outcome.orderNumber, paymentMethod: "transfer", total: outcome.total },
      );
    }
    if (outcome.status === "no_order" && outcome.image?.kind === "product") {
      const catalog = await deps.loadCatalog();
      const found = searchProducts(catalog, outcome.image.searchQuery || outcome.image.description);
      if (found.length) {
        return showOptions(state, found, "R1:foto_producto", `Veo ${outcome.image.description} 👀 Esto es lo más parecido que tenemos:`);
      }
      return reply(
        state,
        `Veo ${outcome.image.description} 👀 No lo encuentro en el catálogo ahora mismo. Escribe *asesor* y una persona te confirma si lo conseguimos, o dime qué buscas y te muestro opciones.`,
        "R1:foto_producto_sin_resultados",
      );
    }
    if (outcome.status === "no_order" && outcome.image?.kind === "other") {
      return reply(state, `Recibí tu imagen (${outcome.image.description}) 📎 ¿En qué te ayudo? Puedo mostrarte productos o el estado de tu pedido.`, "R1:imagen");
    }
    if (outcome.status === "no_order") {
      return reply(
        state,
        "Recibí tu archivo 📎 pero no encuentro un pedido pendiente de transferencia con este número. Si hiciste el pedido por la web, escríbeme tu número de pedido (empieza con *MP-*).",
        "R1:comprobante_sin_pedido",
      );
    }
    if (outcome.status === "unsupported") {
      return reply(state, "Solo puedo recibir el comprobante como *foto* o *PDF* 🙏 ¿Me lo reenvías?", "R1:archivo_no_soportado");
    }
    return reply(state, "No pude guardar tu comprobante ahorita 😕 ¿Me lo reenvías en un momento?", "R1:comprobante_error");
  }

  if (input.mediaWithoutUrl && !message) {
    return reply(
      state,
      state.stage === "ordered" && state.paymentMethod === "transfer"
        ? "No logré abrir tu archivo 😕 ¿Me reenvías la foto del comprobante?"
        : "Por aquí solo puedo leer texto y comprobantes de pago 🙏 Cuéntame qué buscas",
      "R0:media_sin_url",
    );
  }

  // R0: mensaje vacio.
  if (!message) return askNext(state, deps, "R0:mensaje_vacio");

  // R2: pedir una persona.
  if (wantsHuman(message)) {
    const contact = deps.supportPhone ? ` También puedes escribir directo al ${deps.supportPhone}.` : "";
    return reply(state, `Te paso con un asesor del equipo de Megaprinter 🙌 En breve te escribe por aquí.${contact}`, "R2:humano", {
      intent: "dudas",
      route: "human",
    });
  }

  // R3: consultar pedidos (o "ya transferí" con el pedido abierto).
  if (wantsTracking(message) || orderNumberIn(message)) {
    if (state.stage === "ordered" && state.paymentMethod === "transfer" && /transfer|pague|deposit/.test(normalize(message))) {
      return reply(state, "¡Genial! Envíame por aquí la *foto del comprobante* 📸 para que el equipo valide tu pago.", "R3:pedir_comprobante", {
        route: "awaitingReceipt",
        orderNumber: state.orderNumber,
        paymentMethod: "transfer",
      });
    }
    const wanted = orderNumberIn(message);
    const orders = await deps.findOrders(wanted ? `MP-${wanted.padStart(5, "0")}` : undefined);
    const awaiting = (order: OrderSummary) => order.source === "transfer" && order.status === "pending" && order.transferStatus !== "in_review";
    // Pedido de la web pagado por transferencia: el cliente da el numero y el comprobante siguiente se guarda en ese pedido.
    if (wanted && orders[0] && awaiting(orders[0])) {
      state.orderId = orders[0].id;
      return reply(state, `Encontré tu pedido *${orders[0].orderNumber}* por ${money(orders[0].total)} 👍 Envíame por aquí la *foto del comprobante* 📸 y el equipo valida tu pago.`, "R3:pedido_por_numero", {
        intent: "consultar_pedido",
        route: "awaitingReceipt",
        orderNumber: orders[0].orderNumber,
        paymentMethod: "transfer",
      });
    }
    if (!orders.length) {
      return reply(state, "No encuentro pedidos con este número de WhatsApp 🤔 Si compraste por la web con otro número, escríbeme tu número de pedido (MP-…) o pídeme un *asesor*.", "R3:sin_pedidos", {
        intent: "consultar_pedido",
        route: "searchOrder",
      });
    }
    const pendingTransfer = orders.find(awaiting);
    const extra = pendingTransfer ? `\n\nPara el pedido *${pendingTransfer.orderNumber}* envíame la foto del comprobante 📸` : "";
    return reply(state, `Estos son tus pedidos:\n\n${orders.slice(0, 3).map(orderStatusLine).join("\n")}${extra}`, "R3:consultar_pedido", {
      intent: "consultar_pedido",
      route: "searchOrder",
      orderNumber: orders[0].orderNumber,
    });
  }

  // R4: cancelar el carrito (antes de crear la orden).
  if (wantsCancel(message) && state.stage !== "ordered" && state.cart.length) {
    state.cart = [];
    state.options = [];
    state.stage = "idle";
    return reply(state, "Listo, vacié tu carrito 🗑️ Si quieres ver otra cosa, dime qué buscas.", "R4:vaciar_carrito");
  }

  const catalog = await deps.loadCatalog();
  const byId = new Map(catalog.map((product) => [product.id, product]));

  // R5: eleccion entre las opciones mostradas ("2", "la segunda", "sí" con una sola opcion).
  if (state.stage === "choosing" && state.options.length) {
    const choice = extractChoice(message, state.options.length) || (state.options.length === 1 && isYes(message) ? 1 : null);
    if (choice) {
      const option = state.options[choice - 1];
      const current = byId.get(option.productId);
      // Precio vigente del catalogo, no el que se mostro hace horas.
      addToCart(state, current ? toOption(current) : option, 1);
      state.options = [];
      return askNext(state, deps, `R5:eleccion_${choice}`, `Agregué *${option.name}* ✅\n\n${cartLines(state.cart)}\nTotal: *${money(cartTotal(state.cart))}*`);
    }
  }

  // Desde aqui se necesita entender el mensaje.
  const extraction = await deps.extract(message, {
    stage: state.stage,
    lastQuestion: state.lastQuestion,
    cart: state.cart,
    history: input.history || "",
    catalog,
  });

  // Despues de una orden, un producto nuevo arranca otro pedido (se conservan los datos del cliente).
  if (state.stage === "ordered" && (extraction.items.length || extraction.intent === "comprar")) {
    Object.assign(state, { cart: [], options: [], paymentMethod: null, orderId: "", orderNumber: "", stage: "idle" });
  }

  if (state.stage === "ordered") {
    if (state.paymentMethod === "transfer" && /transfer|pague|deposit/.test(normalize(message))) {
      return reply(state, "¡Genial! Envíame por aquí la *foto del comprobante* 📸 para que el equipo valide tu pago.", "R3:pedir_comprobante", {
        route: "awaitingReceipt",
        orderNumber: state.orderNumber,
        paymentMethod: "transfer",
      });
    }
    // Un saludo despues de la orden es una conversacion nueva (el pedido pudo
    // pagarse hace dias): no se repite la instruccion de pago.
    if (isGreeting(message)) {
      Object.assign(state, { cart: [], options: [], paymentMethod: null, orderId: "", orderNumber: "", stage: "idle" });
      return reply(state, `¡Hola de nuevo! 👋 ${ASK_PRODUCT}

Para ver el estado de tu pedido escribe *mi pedido*.`, "R9:saludo");
    }
    if (extraction.intent !== "pregunta" && extraction.intent !== "catalogo") {
      return reply(
        state,
        `Tu pedido *${state.orderNumber}* ya está registrado ✅ Para ver cómo va escribe *mi pedido*. ¿Te ayudo con algo más?`,
        "R7:ya_registrado",
        { orderNumber: state.orderNumber },
      );
    }
  }

  // R6: datos del cliente y cambios al carrito.
  const dataBefore = JSON.stringify([state.customerName, state.customerEmail, state.address, state.paymentMethod]);
  applyCustomerData(state, extraction, message);
  if (state.paymentMethod === "transfer" && !deps.bank) state.paymentMethod = null;
  if (state.paymentMethod === "card" && !deps.cardEnabled) state.paymentMethod = null;

  for (const productId of extraction.remove) state.cart = state.cart.filter((line) => line.productId !== productId);
  const added: string[] = [];
  for (const item of extraction.items) {
    const product = byId.get(item.productId);
    if (!product) continue;
    addToCart(state, toOption(product), item.quantity);
    added.push(`${item.quantity} × ${product.name}`);
  }
  if (added.length) {
    state.options = [];
    return askNext(state, deps, "R6:agregado", `Agregué ${added.join(", ")} ✅\n\n${cartLines(state.cart)}\nTotal: *${money(cartTotal(state.cart))}*`);
  }
  if (extraction.remove.length) {
    return askNext(state, deps, "R6:quitado", state.cart.length ? `Listo, lo quité 👍\n\n${cartLines(state.cart)}\nTotal: *${money(cartTotal(state.cart))}*` : "Listo, lo quité 👍 Tu carrito quedó vacío.");
  }

  // R7: confirmacion del resumen.
  if (state.stage === "confirm") {
    if (isYes(message) && missingStage(state, deps) === "confirm") {
      const order = await deps.createOrder(state);
      state.orderId = order.orderId;
      state.orderNumber = order.orderNumber;
      state.stage = "ordered";
      const text =
        state.paymentMethod === "transfer" && deps.bank
          ? transferInstructions(order, deps.bank)
          : state.paymentMethod === "card" && order.paymentLink
            ? cardInstructions(order)
            : `¡Listo! Tu pedido *${order.orderNumber}* quedó registrado 🎉 Un asesor te escribe para coordinar el pago y la entrega.`;
      return reply(state, text, "R7:orden_creada", {
        intent: "orden_creada",
        route:
          state.paymentMethod === "transfer" && deps.bank
            ? "checkoutTransfer"
            : state.paymentMethod === "card" && order.paymentLink
              ? "checkoutCard"
              : "checkoutAdvisor",
        orderNumber: order.orderNumber,
        paymentLink: state.paymentMethod === "card" ? order.paymentLink : "",
        paymentMethod: state.paymentMethod,
        total: order.total,
      });
    }
    if (isNo(message)) {
      return reply(state, "¿Qué cambio? Escríbeme el dato nuevo (nombre, correo, dirección o forma de pago) o el producto que quieres agregar o quitar.", "R7:pedir_cambio");
    }
  }

  // Respuesta al paso pendiente (nombre, correo, direccion, pago) con reglas.
  if (["name", "email", "address", "payment"].includes(state.stage) && applyStageAnswer(state, message, deps)) {
    return askNext(state, deps, `R6:dato_${state.stage}`);
  }
  const dataChanged = dataBefore !== JSON.stringify([state.customerName, state.customerEmail, state.address, state.paymentMethod]);
  if (state.stage === "confirm" && dataChanged) {
    return askNext(state, deps, "R7:dato_cambiado", "Actualizado 👍");
  }
  // Dio un dato que no era el que se pidio (ej. el correo cuando se pedia el nombre): se guarda y se sigue.
  if (dataChanged && state.cart.length && extraction.intent !== "pregunta") {
    return askNext(state, deps, "R6:datos");
  }

  // R8: catalogo, preguntas y busquedas.
  const pending = state.cart.length && state.stage !== "choosing" ? missingStage(state, deps) : "idle";
  const resume = (text: string) => {
    if (pending === "idle") return text;
    state.stage = pending;
    return `${text}\n\n${pending === "confirm" ? "¿Seguimos con tu pedido? Responde *sí* para confirmarlo" : QUESTIONS[pending as keyof typeof QUESTIONS]}`;
  };

  if (extraction.intent === "catalogo") {
    return reply(state, resume(catalogOverview(catalog, deps.storeUrl)), "R8:catalogo", { intent: "menu", route: "catalog" });
  }

  const suggested = extraction.suggestions.map((id) => byId.get(id)).filter((product): product is BotProduct => Boolean(product));
  if (extraction.intent === "pregunta" && extraction.answer) {
    if (suggested.length && pending === "idle") {
      return showOptions(state, suggested, "R8:pregunta_con_opciones", extraction.answer);
    }
    return reply(state, resume(extraction.answer), "R8:pregunta");
  }

  if (extraction.intent === "comprar" || extraction.intent === "pregunta" || (extraction.intent === "otro" && state.stage === "idle")) {
    const found = suggested.length ? suggested : searchProducts(catalog, extraction.searchQuery || message);
    if (found.length) return showOptions(state, found, "R8:busqueda");
    if (extraction.intent !== "otro") {
      return reply(
        state,
        resume(`No encontré eso en el catálogo 🤔 Prueba con otras palabras (marca, procesador, tipo de impresora) o pídeme el *catálogo*. Si buscas algo especial, escribe *asesor* y te ayuda una persona.`),
        "R8:sin_resultados",
      );
    }
  }

  // R9: saludo o algo que no se entendio: se retoma el paso pendiente.
  if (isGreeting(message) && !state.cart.length) {
    return reply(state, `¡Hola! 👋 Soy el asistente de *Megaprinter*. ${ASK_PRODUCT}`, "R9:saludo");
  }
  if (state.stage === "choosing") {
    return reply(state, "No te entendí 🙏 Responde con el número de la opción que quieres, o dime qué otra cosa buscas.", "R9:eleccion_no_entendida");
  }
  return askNext(state, deps, "R9:siguiente_paso");
}

// ─── Decision del flujo principal (/brain) ───────────────────────────────────

/** Rutas que decide /brain: a que flujo de BuilderBot va el mensaje. */
export const DECISIONS = [
  "conversation",
  "catalog",
  "checkoutCard",
  "checkoutTransfer",
  "checkoutAdvisor",
  "searchOrder",
  "receipt",
  "human",
] as const;
export type Decision = (typeof DECISIONS)[number];

/**
 * Decide el flujo SIN procesar el mensaje: no cambia el carrito, no crea
 * pedidos, no llama a la IA. Usa los mismos detectores que handleTurn, asi el
 * endpoint del flujo destino responde lo mismo que se predijo. Si alguna vez
 * difieren, el destino igual responde bien porque corre el turno completo.
 */
export function decideRoute(
  previous: Partial<BotState> | null,
  input: { message: string; mediaUrl?: string },
  options: { bank: boolean; cardEnabled: boolean },
): { route: Decision; reason: string } {
  const state = { ...createInitialState(), ...(previous || {}) };
  const message = input.message.trim();

  if (input.mediaUrl) return { route: "receipt", reason: "archivo adjunto" };
  if (!message) return { route: "conversation", reason: "mensaje vacio" };
  if (wantsHuman(message)) return { route: "human", reason: "pide una persona" };
  if (wantsTracking(message) || orderNumberIn(message)) return { route: "searchOrder", reason: "consulta de pedido" };
  if (state.stage === "confirm" && isYes(message)) {
    if (state.paymentMethod === "transfer" && options.bank) return { route: "checkoutTransfer", reason: "confirma pedido por transferencia" };
    if (state.paymentMethod === "card" && options.cardEnabled) return { route: "checkoutCard", reason: "confirma pedido con tarjeta" };
    return { route: "checkoutAdvisor", reason: "confirma pedido sin metodo de pago" };
  }
  if (wantsCatalog(message) && state.stage !== "choosing") return { route: "catalog", reason: "pide el catalogo" };
  return { route: "conversation", reason: "conversacion" };
}
