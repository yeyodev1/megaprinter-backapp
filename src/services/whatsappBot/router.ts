import { BankDetails, bankText } from "../transfer.service";
import { detectBank } from "../banks";
import { BotProduct, catalogOverview, money, normalize, productLine, searchProducts } from "./catalog";
import { Extraction, Extractor } from "./extractor";
import { detectPaymentMethod, extractChoice, extractEmail, isGreeting, isNo, isYes, orderNumberIn, wantsCancel, wantsCatalog, wantsHuman, wantsOptOut, wantsTracking } from "./intents";

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

export type Stage = "idle" | "choosing" | "name" | "email" | "address" | "payment" | "bank" | "confirm" | "ordered";

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
  /** Cuenta (banco) que eligio para transferir. */
  bankId: string;
  /** Pidio que no le escriban (queda registrado en la conversacion). */
  optOut: boolean;
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
  bankId: "",
  optOut: false,
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
  /** Llego un archivo pero BuilderBot no mando su URL (tipo segun el evento). */
  mediaWithoutUrl?: boolean;
  mediaEvent?: "video" | "audio" | "file";
  history?: string;
}

export interface CreatedOrder {
  orderId: string;
  orderNumber: string;
  total: number;
  paymentLink: string;
}

/** Resultado de un archivo que mando el cliente (lo analiza la IA antes de decidir). */
export type ReceiptOutcome =
  | { status: "stored"; orderNumber: string; total: number; detectedAmount: number | null; amountMatches: boolean | null; isReceipt: boolean | null }
  | { status: "no_order" }
  | {
      status: "image";
      kind: "product" | "other";
      description: string;
      searchQuery: string;
      productIds: string[];
      exactMatch: boolean;
      /** Pedido por transferencia que sigue esperando comprobante (para recordarlo). */
      pendingOrderNumber?: string;
    }
  | { status: "video" | "audio" | "unsupported" | "error" };

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
  /** Cuentas activas para transferir (vacio = transferencias apagadas). */
  banks: BankDetails[];
  cardEnabled: boolean;
  supportPhone: string;
  storeUrl: string;
}

// ─── Textos ──────────────────────────────────────────────────────────────────

const QUESTIONS: Record<Exclude<Stage, "idle" | "choosing" | "confirm" | "ordered" | "bank">, string> = {
  name: "A nombre de quién va tu pedido? 😊 Pásame tu nombre y apellido",
  email: "Y tu correo? 📧 Ahí te llega la confirmación de tu compra",
  address: "A qué dirección y ciudad te lo enviamos? 🚚 Si prefieres retirarlo en la tienda, escríbeme *retiro* 🏪",
  payment: "Cómo prefieres pagar? 💳\n*1.* Tarjeta (te paso un link seguro de Payphone 🔒)\n*2.* Transferencia bancaria 🏦",
};

/** Pregunta del paso. En "bank" solo se nombran los bancos: la cuenta se envia cuando elige. */
function questionFor(stage: Stage, deps: BotDeps) {
  if (stage === "bank") {
    const list = deps.banks.map((account, index) => `*${index + 1}.* ${account.bank}`).join("\n");
    return `A qué banco te queda mejor transferir? 🏦✨\n${list}\n\nRespóndeme con el número o el nombre del banco 😊`;
  }
  return QUESTIONS[stage as keyof typeof QUESTIONS] || "";
}

const chosenBank = (state: BotState, deps: BotDeps) => deps.banks.find((account) => account.id === state.bankId) || null;

const ASK_PRODUCT = "Cuéntame qué estás buscando 💻🖨️✨ Puedes escribirme algo como \"laptop i7 16GB\" o \"impresora de tinta continua\", mandarme una foto 📸 o pedirme el *catálogo* 📚";

export const FALLBACK_MESSAGE = ASK_PRODUCT;

const VIDEO_REPLY =
  "Por aquí no puedo ver videos 🙏 Mándame una *foto o captura* de lo que buscas (también sirve una captura de nuestro Instagram) y te digo si lo tenemos.";
const AUDIO_REPLY = "Todavía no puedo escuchar audios 🙏 Escríbeme lo que necesitas o mándame una *foto* de lo que buscas.";

const paymentLabel = (method: BotState["paymentMethod"]) =>
  method === "card" ? "Tarjeta (link de Payphone)" : method === "transfer" ? "Transferencia bancaria" : "Por definir";

export const cartTotal = (cart: CartLine[]) => Math.round(cart.reduce((sum, line) => sum + line.price * line.quantity, 0) * 100) / 100;

const cartLines = (cart: CartLine[]) =>
  cart.map((line) => `• ${line.quantity} × ${line.name} — ${money(line.price * line.quantity)}`).join("\n");

export function formatSummary(state: BotState, deps?: BotDeps) {
  const bank = deps ? chosenBank(state, deps) : null;
  return [
    "Así va tu pedido 🛍️✨",
    "",
    cartLines(state.cart),
    `*Total: ${money(cartTotal(state.cart))}*`,
    "",
    `👤 ${state.customerName}`,
    `📧 ${state.customerEmail}`,
    `📍 ${state.address}`,
    `💳 ${paymentLabel(state.paymentMethod)}${state.paymentMethod === "transfer" && bank ? ` · ${bank.bank}` : ""}`,
    "",
    "Lo confirmo? Respóndeme *sí* 💙 o dime qué quieres cambiar",
  ].join("\n");
}

function transferInstructions(order: CreatedOrder, bank: BankDetails) {
  return [
    `Listo, tu pedido *${order.orderNumber}* ya está registrado 🎉💙`,
    "",
    `Transfiere *${money(order.total)}* a esta cuenta 👇`,
    bankText(bank),
    "",
    "Cuando hagas la transferencia, mándame por aquí la *foto del comprobante* 📸 y el equipo la valida enseguida 🙌",
  ].join("\n");
}

function cardInstructions(order: CreatedOrder) {
  return [
    `Listo, tu pedido *${order.orderNumber}* ya está registrado 🎉💙`,
    "",
    `Paga *${money(order.total)}* con tarjeta en este link seguro de Payphone 🔒👇`,
    order.paymentLink,
    "",
    "Apenas se apruebe el pago te aviso y coordinamos la entrega 🚚✨",
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
    const hasBanks = deps.banks.length > 0;
    if (deps.cardEnabled && !hasBanks) state.paymentMethod = "card";
    else if (!deps.cardEnabled && hasBanks) state.paymentMethod = "transfer";
    else if (deps.cardEnabled && hasBanks) return "payment";
  }
  if (state.paymentMethod === "transfer" && deps.banks.length && !chosenBank(state, deps)) {
    // Con una sola cuenta activa no se pregunta el banco.
    if (deps.banks.length === 1) state.bankId = deps.banks[0].id;
    else return "bank";
  }
  return "confirm";
}

const looksLikeName = (text: string) => {
  const value = text.trim();
  return /^[\p{L}][\p{L}' .-]{1,60}$/u.test(value) && value.split(/\s+/).length <= 5 && !isYes(value) && !isNo(value) && !isGreeting(value);
};

/** Aplica los datos que el cliente haya dado en cualquier momento (suelen mandar todo junto). */
function applyCustomerData(state: BotState, extraction: Extraction, message: string, deps: BotDeps) {
  // "pago por Pichincha": transferencia a esa cuenta. Solo si se habla de pago:
  // "Quito, Pichincha" en una direccion es la provincia, no el banco.
  const talksPayment = ["payment", "bank", "confirm"].includes(state.stage) || /transfer|deposit|banco|pag[oa]|cuenta/.test(normalize(message));
  const bank = talksPayment ? detectBank(message, deps.banks, state.stage === "bank") : null;
  if (bank) {
    state.paymentMethod = "transfer";
    state.bankId = bank.id;
  }
  if (extraction.customerName) state.customerName = extraction.customerName;
  const email = extractEmail(message) || extraction.customerEmail;
  if (email) state.customerEmail = email;
  if (extraction.address) state.address = extraction.address;
  if (extraction.paymentMethod && !bank) state.paymentMethod = extraction.paymentMethod;
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
      if (state.paymentMethod === "transfer" && !deps.banks.length) state.paymentMethod = null;
      if (state.paymentMethod === "card" && !deps.cardEnabled) state.paymentMethod = null;
      return Boolean(state.paymentMethod);
    }
    case "bank": {
      if (!chosenBank(state, deps)) {
        const choice = extractChoice(text, deps.banks.length);
        const bank = choice ? deps.banks[choice - 1] : detectBank(text, deps.banks, true);
        if (bank) state.bankId = bank.id;
      }
      return Boolean(chosenBank(state, deps));
    }
    default:
      return false;
  }
}

/** Nombre de la asistente (configurable con BOT_NAME). */
export const botName = () => (process.env.BOT_NAME || "Mila").trim();

/**
 * Estilo de la marca: en WhatsApp nadie escribe "¿" ni "¡" al inicio, solo el
 * signo final. Se aplica a TODO lo que sale, incluidas las respuestas de la IA.
 */
export const casualMarks = (text: string) => text.replace(/[¿¡]/g, "");

function reply(state: BotState, rawText: string, decision: string, extra: Partial<TurnResult> = {}): TurnResult {
  const text = casualMarks(rawText);
  state.lastQuestion = text.slice(-300);
  return { state, reply: text, route: "conversation", intent: "conversar", step: state.stage, decision, ...extra };
}

/** Pregunta por lo que falta (o muestra el resumen), con un prefijo opcional. */
function askNext(state: BotState, deps: BotDeps, decision: string, prefix = ""): TurnResult {
  state.stage = missingStage(state, deps);
  const join = (text: string) => (prefix ? `${prefix}\n\n${text}` : text);
  if (state.stage === "idle") return reply(state, join(ASK_PRODUCT), decision);
  if (state.stage === "confirm") return reply(state, join(formatSummary(state, deps)), decision, { route: "confirmOrder" });
  return reply(state, join(questionFor(state.stage, deps)), decision);
}

function showOptions(state: BotState, products: BotProduct[], decision: string, intro?: string): TurnResult {
  state.options = products.map(toOption);
  state.stage = "choosing";
  const list = products.map((product, index) => productLine(product, index + 1)).join("\n");
  const ask = products.length === 1 ? "Te lo agrego al pedido? 🛒 Respóndeme *sí* o *1*" : "Cuál te agrego? 🛒 Respóndeme con el número";
  return reply(state, `${intro || "Mira estas opciones que tengo para ti 👇✨"}\n\n${list}\n\n${ask}`, decision);
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
        `Gracias! 🙌 Recibí tu comprobante del pedido *${outcome.orderNumber}* 🧾 El equipo lo revisa y te confirmo por aquí apenas se valide el pago 💙${warning}`,
        "R1:comprobante",
        { intent: "comprobante_recibido", route: "receiptReceived", orderNumber: outcome.orderNumber, paymentMethod: "transfer", total: outcome.total },
      );
    }
    if (outcome.status === "image" && outcome.kind === "product") {
      const catalog = await deps.loadCatalog();
      const byId = new Map(catalog.map((product) => [product.id, product]));
      const matched = outcome.productIds.map((id) => byId.get(id)).filter((product): product is BotProduct => Boolean(product));
      const found = matched.length ? matched : searchProducts(catalog, outcome.searchQuery || outcome.description, 3);
      if (found.length && outcome.exactMatch) {
        return showOptions(state, found.slice(0, 1), "R1:foto_producto_exacto", `Sí lo tenemos! 🙌✨ Veo ${outcome.description}:`);
      }
      if (found.length) {
        return showOptions(state, found, "R1:foto_producto_parecido", `Veo ${outcome.description} 👀 Ese modelo exacto no lo tengo en tienda, pero estos son los más parecidos:`);
      }
      return reply(
        state,
        `Veo ${outcome.description} 👀 Ese equipo no lo tenemos en tienda ahora mismo, pero podemos revisar si lo conseguimos. Escribe *asesor* y te cotizan, o dime qué necesitas y te muestro opciones.`,
        "R1:foto_producto_sin_stock",
      );
    }
    if (outcome.status === "image") {
      const pending = outcome.pendingOrderNumber
        ? `\n\nSi querías enviar el comprobante del pedido *${outcome.pendingOrderNumber}*, mándame la foto del comprobante de la transferencia.`
        : "";
      return reply(
        state,
        `Recibí tu imagen (${outcome.description}) 📎 Si buscas un producto, mándame una foto o captura de él (puede ser de nuestro Instagram) y te digo si lo tenemos.${pending}`,
        "R1:imagen",
      );
    }
    if (outcome.status === "video") {
      return reply(state, VIDEO_REPLY, "R1:video");
    }
    if (outcome.status === "audio") {
      return reply(state, AUDIO_REPLY, "R1:audio");
    }
    if (outcome.status === "no_order") {
      return reply(
        state,
        "Recibí tu archivo 📎 pero no encuentro un pedido pendiente de transferencia con este número. Si hiciste el pedido por la web, escríbeme tu número de pedido (empieza con *MP-*).",
        "R1:comprobante_sin_pedido",
      );
    }
    if (outcome.status === "unsupported") {
      return reply(state, "Ese tipo de archivo no lo puedo abrir 🙏 Mándame una *foto* o *PDF* (comprobante o lo que buscas).", "R1:archivo_no_soportado");
    }
    return reply(state, "Uy, no pude abrir tu archivo ahorita 😕 Me lo reenvías en un momentito? 🙏", "R1:archivo_error");
  }

  if (input.mediaWithoutUrl && !message) {
    if (input.mediaEvent === "video") return reply(state, VIDEO_REPLY, "R0:video_sin_url");
    if (input.mediaEvent === "audio") return reply(state, AUDIO_REPLY, "R0:audio_sin_url");
    return reply(state, "Uy, no logré abrir tu archivo 😕 Me lo reenvías como *foto*? 📸", "R0:media_sin_url");
  }

  // R0: mensaje vacio.
  if (!message) return askNext(state, deps, "R0:mensaje_vacio");

  // R0: no quiere mas mensajes. Se respeta (sin seguimientos) y se lo dice.
  if (wantsOptOut(message) && !(state.stage === "confirm" || state.stage === "choosing")) {
    state.optOut = true;
    return reply(state, "Listo, no te escribo más 🙊💙 Si algún día me necesitas, aquí estoy para ayudarte ✨", "R0:no_escribir");
  }

  // R2: pedir una persona.
  if (wantsHuman(message)) {
    const contact = deps.supportPhone ? ` También puedes escribir directo al ${deps.supportPhone}.` : "";
    return reply(state, `Claro! Te paso con una persona del equipo de Megaprinter 🙌💙 En un ratito te escribe por aquí.${contact}`, "R2:humano", {
      intent: "dudas",
      route: "human",
    });
  }

  // R3: consultar pedidos (o "ya transferí" con el pedido abierto).
  if (wantsTracking(message) || orderNumberIn(message)) {
    if (state.stage === "ordered" && state.paymentMethod === "transfer" && /transfer|pague|deposit/.test(normalize(message))) {
      return reply(state, "Genial! 🙌 Mándame por aquí la *foto del comprobante* 📸 y el equipo valida tu pago enseguida 💙", "R3:pedir_comprobante", {
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
    return reply(state, "Listo, vacié tu carrito 🗑️ Si quieres ver otra cosa, cuéntame qué buscas 😊", "R4:vaciar_carrito");
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
    Object.assign(state, { cart: [], options: [], paymentMethod: null, bankId: "", orderId: "", orderNumber: "", stage: "idle" });
  }

  if (state.stage === "ordered") {
    if (state.paymentMethod === "transfer" && /transfer|pague|deposit/.test(normalize(message))) {
      return reply(state, "Genial! 🙌 Mándame por aquí la *foto del comprobante* 📸 y el equipo valida tu pago enseguida 💙", "R3:pedir_comprobante", {
        route: "awaitingReceipt",
        orderNumber: state.orderNumber,
        paymentMethod: "transfer",
      });
    }
    // Un saludo despues de la orden es una conversacion nueva (el pedido pudo
    // pagarse hace dias): no se repite la instruccion de pago.
    if (isGreeting(message)) {
      Object.assign(state, { cart: [], options: [], paymentMethod: null, bankId: "", orderId: "", orderNumber: "", stage: "idle" });
      return reply(state, `¡Hola de nuevo! 👋 ${ASK_PRODUCT}

Para ver el estado de tu pedido escribe *mi pedido*.`, "R9:saludo");
    }
    if (extraction.intent !== "pregunta" && extraction.intent !== "catalogo") {
      return reply(
        state,
        `Tu pedido *${state.orderNumber}* ya está registrado ✅ Si quieres ver cómo va, escríbeme *mi pedido* 📦 Te ayudo con algo más? 😊`,
        "R7:ya_registrado",
        { orderNumber: state.orderNumber },
      );
    }
  }

  // R6: datos del cliente y cambios al carrito.
  const dataBefore = JSON.stringify([state.customerName, state.customerEmail, state.address, state.paymentMethod, state.bankId]);
  applyCustomerData(state, extraction, message, deps);
  if (state.paymentMethod === "transfer" && !deps.banks.length) state.paymentMethod = null;
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
      const bank = chosenBank(state, deps);
      const text =
        state.paymentMethod === "transfer" && bank
          ? transferInstructions(order, bank)
          : state.paymentMethod === "card" && order.paymentLink
            ? cardInstructions(order)
            : `Listo, tu pedido *${order.orderNumber}* ya está registrado 🎉 Una persona del equipo te escribe para coordinar el pago y la entrega 💙`;
      return reply(state, text, "R7:orden_creada", {
        intent: "orden_creada",
        route:
          state.paymentMethod === "transfer" && bank
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
      return reply(state, "Claro! ✏️ Qué cambiamos? Escríbeme el dato nuevo (nombre, correo, dirección o forma de pago) o el producto que quieres agregar o quitar 😊", "R7:pedir_cambio");
    }
  }

  // Respuesta al paso pendiente (nombre, correo, direccion, pago) con reglas.
  if (["name", "email", "address", "payment", "bank"].includes(state.stage) && applyStageAnswer(state, message, deps)) {
    return askNext(state, deps, `R6:dato_${state.stage}`);
  }
  const dataChanged = dataBefore !== JSON.stringify([state.customerName, state.customerEmail, state.address, state.paymentMethod, state.bankId]);
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
    return `${text}\n\n${pending === "confirm" ? "Seguimos con tu pedido? 🛍️ Respóndeme *sí* para confirmarlo 💙" : questionFor(pending, deps)}`;
  };

  // Politica de Meta (2026): nada de asistente de proposito general. Solo Megaprinter.
  if (extraction.intent === "fuera_de_tema") {
    return reply(
      state,
      resume(`Ay, eso no lo sé responder 🙈 Yo solo te ayudo con cosas de *Megaprinter*: equipos, impresoras, cámaras, servicio técnico y tus pedidos 💻🖨️✨`),
      "R8:fuera_de_tema",
    );
  }

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
    return reply(state, `Hola! 👋💙 Soy *${botName()}*, la asistente virtual de *Megaprinter* ✨ ${ASK_PRODUCT}`, "R9:saludo");
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
  "media",
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
  input: { message: string; mediaUrl?: string; mediaEvent?: boolean },
  options: { bank: boolean; cardEnabled: boolean },
): { route: Decision; reason: string } {
  const state = { ...createInitialState(), ...(previous || {}) };
  const message = input.message.trim();

  if (input.mediaUrl || (input.mediaEvent && !message)) return { route: "media", reason: "archivo adjunto" };
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
