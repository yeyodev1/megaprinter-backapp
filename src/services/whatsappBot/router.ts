import { BankDetails, bankText } from "../transfer.service";
import { detectBank } from "../banks";
import { DEVICES, ServiceEstimate, detectDevice, deviceEmoji, deviceLabel, estimateService, priceText } from "./serviceCatalog";
import { BotProduct, catalogOverview, money, normalize, productLine, searchProducts } from "./catalog";
import { Extraction, Extractor } from "./extractor";
import { detectPaymentMethod, extractChoice, extractEmail, isGreeting, isNo, isYes, orderNumberIn, wantsCancel, wantsCatalog, wantsHuman, wantsOptOut, wantsTracking, asksIfBot, claimsPaid, wantsService, wantsSupplies } from "./intents";

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

export type Stage = "idle" | "choosing" | "name" | "email" | "address" | "payment" | "bank" | "confirm" | "ordered" | "ticket_name" | "ticket_device" | "ticket_issue" | "ticket_confirm";

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
  /** Solicitud de servicio tecnico o suministros en curso (la termina un asesor). */
  ticket: { type: "servicio_tecnico" | "suministros" | ""; device: string; issue: string; stageBefore: Stage };
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
  ticket: { type: "", device: "", issue: "", stageBefore: "idle" },
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
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  status: string;
  source: string;
  total: number;
  transferStatus: string;
  paymentLink: string;
  createdAt: Date;
}

/** Resultado de verificar con Payphone un pago con tarjeta que el cliente dice haber hecho. */
export interface CardCheck {
  outcome: "already_paid" | "paid_now" | "pending" | "rejected" | "mismatch" | "error";
  orderNumber: string;
  total: number;
  paymentLink: string;
}

export interface TicketDraft {
  type: "servicio_tecnico" | "suministros";
  customerName: string;
  device: string;
  issue: string;
  estimate: ServiceEstimate | null;
}

export interface BotDeps {
  loadCatalog: () => Promise<BotProduct[]>;
  extract: Extractor;
  createOrder: (state: BotState) => Promise<CreatedOrder>;
  receiveReceipt: (orderId: string, mediaUrl: string) => Promise<ReceiptOutcome>;
  /** Verifica con Payphone el pago con tarjeta del pedido del chat (o el ultimo del telefono). null si no hay. */
  checkCardPayment: (orderId: string) => Promise<CardCheck | null>;
  /** Registra el ticket de servicio tecnico o suministros y avisa al equipo. */
  createTicket: (draft: TicketDraft) => Promise<{ ticketNumber: string }>;
  /** Pedidos del telefono del chat, o el pedido con ese numero ("MP-00012"). */
  findOrders: (orderNumber?: string) => Promise<OrderSummary[]>;
  /** Cuentas activas para transferir (vacio = transferencias apagadas). */
  banks: BankDetails[];
  cardEnabled: boolean;
  supportPhone: string;
  storeUrl: string;
}

// ─── Textos ──────────────────────────────────────────────────────────────────

const QUESTIONS: Partial<Record<Stage, string>> = {
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

const ASK_PRODUCT = "Cuéntame qué buscas hoy 💻🖨️ Puedes escribirme algo como \"laptop i7 16GB\" o \"impresora de tinta continua\", pedirme *servicio técnico* 🛠️ o *suministros* 🧴, mandarme una foto 📸 o pedirme el *catálogo* 📚";

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
    "Cuando termines de pagar, regresa aquí y escríbeme *pagado* ✅ o mándame la captura del pago 📸 y lo confirmo al toque 💙",
  ].join("\n");
}

const STATUS_TEXT: Record<string, string> = {
  pending: "pendiente de pago",
  whatsapp: "registrado, un asesor te contacta",
  paid: "pagado ✅",
  processing: "en preparación 📦",
  shipped: "enviado 🚚",
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
  const guide = order.status === "shipped" && order.trackingNumber ? ` · guía ${order.carrier ? `${order.carrier} ` : ""}${order.trackingNumber}` : "";
  return `• *${order.orderNumber}* — ${money(order.total)} — ${status}${guide}${order.trackingUrl ? `\n  ${order.trackingUrl}` : ""}`;
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
        // Ciudades cortas ("Loja", "Quito") tambien valen; una forma de pago no es una direccion.
        else if (text.length >= 3 && /\p{L}/u.test(text) && !isYes(text) && !isNo(text) && !detectPaymentMethod(text)) state.address = text.slice(0, 300);
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
  // El catalogo completo es una opcion mas de la lista.
  const list = [...products.map((product, index) => productLine(product, index + 1)), `*${products.length + 1}.* 📚 Ver el catálogo completo`].join("\n");
  const ask = `${products.length === 1 ? "Te lo agrego al pedido? 🛒 Respóndeme *sí* o *1*" : "Cuál te agrego? 🛒 Respóndeme con el número"}\nSi prefieres hablar con una persona, escribe *asesor* 🙋`;
  return reply(state, `${intro || "Mira estas opciones que tengo para ti 👇✨"}\n\n${list}\n\n${ask}`, decision);
}

/** Respuesta segun lo que dijo Payphone del pago con tarjeta ("pagado" o captura del pago). */
function cardCheckReply(state: BotState, check: CardCheck): TurnResult {
  const extra = { intent: "consultar_pedido" as const, orderNumber: check.orderNumber, paymentMethod: "card" as const, total: check.total };
  if (check.outcome === "paid_now" || check.outcome === "already_paid") {
    return reply(
      state,
      `Listo! ✅ Tu pago de *${money(check.total)}* del pedido *${check.orderNumber}* está confirmado 💙 Te llega la confirmación a tu correo y el equipo te escribe para coordinar la entrega 🚚✨`,
      check.outcome === "paid_now" ? "R3:pago_confirmado" : "R3:pago_ya_confirmado",
      extra,
    );
  }
  if (check.outcome === "rejected") {
    return reply(
      state,
      `Uy, el pago del pedido *${check.orderNumber}* salió rechazado 😕 Puedes intentarlo otra vez con otra tarjeta aquí 👇\n${check.paymentLink}\n\nSi prefieres, también puedes pagar por *transferencia* 🏦`,
      "R3:pago_rechazado",
      extra,
    );
  }
  if (check.outcome === "mismatch") {
    return reply(state, `Recibimos un pago para el pedido *${check.orderNumber}*, pero el monto no coincide 🤔 Te paso con una persona del equipo para revisarlo 🙌`, "R3:pago_monto_distinto", {
      ...extra,
      intent: "dudas",
      route: "human",
    });
  }
  return reply(
    state,
    `Todavía no me aparece el pago del pedido *${check.orderNumber}* 🤔 Si ya lo hiciste, dame un minutito y escríbeme *pagado* otra vez. Si aún no, aquí tienes tu link seguro 👇\n${check.paymentLink}`,
    check.outcome === "error" ? "R3:pago_error_verificando" : "R3:pago_pendiente",
    extra,
  );
}

// ─── Tickets de servicio tecnico y suministros ──────────────────────────────

const TICKET_STAGES: Stage[] = ["ticket_name", "ticket_device", "ticket_issue", "ticket_confirm"];
const isTicketStage = (stage: Stage) => TICKET_STAGES.includes(stage);

const FILLER = new Set(
  "hola buenas buenos dias tardes noches necesito quiero busco servicio soporte tecnico tecnica suministro suministros ayuda ayudar ayudan por favor porfa para mi mis el la los las de del con un una que me se y o tengo hay esta es un su sus al".split(" "),
);
const DEVICE_WORDS = new Set(DEVICES.flatMap((device) => device.words as readonly string[]));

/** Quedan al menos 2 palabras que no son saludo, relleno ni el nombre del equipo. */
function describesProblem(message: string) {
  return normalize(message).split(" ").filter((word) => word && !FILLER.has(word) && !DEVICE_WORDS.has(word)).length >= 2;
}

function startTicket(state: BotState, type: "servicio_tecnico" | "suministros", message: string) {
  const device = type === "servicio_tecnico" ? detectDevice(message) : "";
  // Si el mensaje ya cuenta el problema ("mi impresora no imprime"), se usa como descripcion.
  // "necesito servicio tecnico para mi impresora" no cuenta ningun problema.
  const issue = describesProblem(message) ? message.trim().slice(0, 500) : "";
  state.ticket = { type, device, issue, stageBefore: isTicketStage(state.stage) ? state.ticket.stageBefore : state.stage };
}

function ticketMissing(state: BotState): Stage {
  if (!state.customerName) return "ticket_name";
  if (state.ticket.type === "servicio_tecnico" && !state.ticket.device) return "ticket_device";
  if (!state.ticket.issue) return "ticket_issue";
  return "ticket_confirm";
}

function ticketSummary(state: BotState, deps: BotDeps, catalog: BotProduct[]) {
  if (state.ticket.type === "suministros") {
    return [
      "Perfecto, armé tu solicitud 🧴",
      "",
      "🧾 *Suministros*",
      `📝 Necesitas: ${state.ticket.issue}`,
      `👤 ${state.customerName}`,
      "💲 Te cotizamos según la marca y el modelo",
      "",
      "La registro y te paso con un asesor? Respóndeme *sí* ✅",
    ].join("\n");
  }
  const estimate = estimateService(state.ticket.device, state.ticket.issue, catalog);
  return [
    "Perfecto, armé tu solicitud 🛠️",
    "",
    "🧾 *Servicio técnico*",
    `${deviceEmoji(state.ticket.device)} Equipo: ${deviceLabel(state.ticket.device)}`,
    `📝 Problema: ${state.ticket.issue}`,
    `👤 ${state.customerName}`,
    `💲 Precio referencial: ${priceText(estimate)} (${estimate.label.toLowerCase()})`,
    "_El diagnóstico es sin costo y el técnico te confirma el precio._",
    "",
    "La registro y te paso con un asesor? Respóndeme *sí* ✅",
  ].join("\n");
}

async function askTicketNext(state: BotState, deps: BotDeps, decision: string, prefix = ""): Promise<TurnResult> {
  state.stage = ticketMissing(state);
  const join = (text: string) => (prefix ? `${prefix}\n\n${text}` : text);
  if (state.stage === "ticket_name") return reply(state, join("Para registrar tu solicitud, a nombre de quién la pongo? 😊 Pásame tu nombre y apellido"), decision);
  if (state.stage === "ticket_device") {
    const list = DEVICES.map((device, index) => `*${index + 1}.* ${device.emoji} ${device.label}`).join("\n");
    return reply(state, join(`Con qué equipo te ayudamos? 🛠️\n${list}`), decision);
  }
  if (state.stage === "ticket_issue") {
    return reply(
      state,
      join(
        state.ticket.type === "suministros"
          ? "Qué suministro necesitas? 🧴 Cuéntame la marca y el modelo de tu impresora y qué buscas (tinta, tóner, cartucho, papel)"
          : `Cuéntame más o menos qué problema tiene tu ${deviceLabel(state.ticket.device).toLowerCase()} 📝 (por ejemplo: no imprime, no enciende, está lenta)`,
      ),
      decision,
    );
  }
  return reply(state, join(ticketSummary(state, deps, await deps.loadCatalog())), decision);
}

/** Respuesta a un paso del ticket. Devuelve null si el mensaje no es para el ticket. */
async function handleTicketStep(state: BotState, message: string, deps: BotDeps): Promise<TurnResult | null> {
  const text = message.trim();
  if (wantsCancel(text) || /^(cancelar|olvidalo|ya no)$/i.test(normalize(text))) {
    state.stage = state.ticket.stageBefore === "ordered" ? "idle" : state.ticket.stageBefore || "idle";
    state.ticket = createInitialState().ticket;
    return reply(state, "Listo, cancelé la solicitud 👍 Si necesitas algo más, aquí estoy 😊", "R10:ticket_cancelado");
  }
  if (state.stage === "ticket_name") {
    if (!looksLikeName(text)) return reply(state, "Me pasas tu nombre y apellido? 😊", "R10:ticket_nombre_invalido");
    state.customerName = text.replace(/\s+/g, " ");
    return askTicketNext(state, deps, "R10:ticket_nombre");
  }
  if (state.stage === "ticket_device") {
    const choice = extractChoice(text, DEVICES.length);
    state.ticket.device = choice ? DEVICES[choice - 1].key : detectDevice(text) || text.slice(0, 60);
    if (!state.ticket.issue && detectDevice(text) && describesProblem(text)) state.ticket.issue = text.slice(0, 500);
    return askTicketNext(state, deps, "R10:ticket_equipo");
  }
  if (state.stage === "ticket_issue") {
    if (text.length < 3) return askTicketNext(state, deps, "R10:ticket_detalle_corto");
    state.ticket.issue = text.slice(0, 500);
    return askTicketNext(state, deps, "R10:ticket_detalle");
  }
  if (state.stage === "ticket_confirm") {
    if (isYes(text)) {
      const catalog = await deps.loadCatalog();
      const estimate = state.ticket.type === "servicio_tecnico" ? estimateService(state.ticket.device, state.ticket.issue, catalog) : null;
      const { ticketNumber } = await deps.createTicket({
        type: state.ticket.type as "servicio_tecnico" | "suministros",
        customerName: state.customerName,
        device: state.ticket.device,
        issue: state.ticket.issue,
        estimate,
      });
      const kind = state.ticket.type === "suministros" ? "solicitud de suministros" : "ticket de servicio técnico";
      state.stage = "idle";
      state.ticket = createInitialState().ticket;
      return reply(
        state,
        `Listo! ✅ Tu ${kind} *${ticketNumber}* quedó registrado 🙌\n\nEn breve un asesor tomará el chat para ayudarte 💙`,
        "R10:ticket_creado",
        { intent: "dudas", route: "human" },
      );
    }
    // "no" / "no, está mal" corrige; "no imprime, sale con rayas" es mas detalle del problema.
    if (isNo(text) && normalize(text).split(" ").length <= 3 && !describesProblem(text.replace(/^no\b/i, ""))) {
      state.ticket.issue = "";
      return askTicketNext(state, deps, "R10:ticket_corregir", "Claro! ✏️ Volvamos a contarlo");
    }
    // Agrega detalle y vuelve a mostrar el resumen.
    state.ticket.issue = `${state.ticket.issue}. ${text}`.slice(0, 500);
    return askTicketNext(state, deps, "R10:ticket_mas_detalle", "Anotado 📝");
  }
  return null;
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
      // Captura del pago con tarjeta: se verifica con Payphone como un "pagado".
      const check = await deps.checkCardPayment(state.orderId);
      if (check) return cardCheckReply(state, check);
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

  // Transparencia: si pregunta si es un bot o una persona, se le dice la verdad.
  if (asksIfBot(message)) {
    return reply(
      state,
      `Sí, soy un bot 🤖 Soy *${botName()}*, el bot de *Megaprinter*, y te ayudo con productos, pagos y pedidos las 24 horas 💙 Si prefieres hablar con una persona del equipo, escríbeme *asesor* 🙌`,
      "R2:soy_un_bot",
    );
  }

  // R2: pedir una persona.
  if (wantsHuman(message)) {
    const contact = deps.supportPhone ? ` También puedes escribir directo al ${deps.supportPhone}.` : "";
    return reply(state, `Claro! Te paso con una persona real del equipo de Megaprinter 🙌💙 En un ratito te escribe por aquí.${contact}`, "R2:humano", {
      intent: "dudas",
      route: "human",
    });
  }

  // R10: servicio tecnico y suministros (los atiende un asesor).
  if (isTicketStage(state.stage)) {
    const ticketReply = await handleTicketStep(state, message, deps);
    if (ticketReply) return ticketReply;
  }
  const normalized = normalize(message);
  // "no funciona el link de pago" es del pago, no servicio tecnico.
  const aboutPayment = /\b(link|pago|pagar|tarjeta|transferencia|comprobante|pedido|payphone)\b/.test(normalized);
  const serviceAsked = wantsService(message) && !claimsPaid(message) && !aboutPayment;
  // "impresora de tinta continua" es un producto; "tinta para mi Epson" o "toner" son suministros.
  const explicitSupplies = /\b(suministros?|toner|cartuchos?|botellas?|repuestos?|consumibles?)\b/.test(normalized);
  const suppliesAsked = !serviceAsked && wantsSupplies(message) && state.stage !== "choosing" && (explicitSupplies || !/\b(impresoras?|multifuncion|laptop|monitor|camara)\b/.test(normalized));
  if (serviceAsked || suppliesAsked) {
    startTicket(state, serviceAsked ? "servicio_tecnico" : "suministros", message);
    const intro = serviceAsked ? "Claro! Te ayudo con el servicio técnico 🛠️" : "Claro! Te ayudo con los suministros 🧴";
    return askTicketNext(state, deps, serviceAsked ? "R10:servicio_tecnico" : "R10:suministros", intro);
  }

  // R3: "pagado" con un pedido de tarjeta: se verifica con Payphone y se confirma.
  if (claimsPaid(message) && state.paymentMethod !== "transfer") {
    const check = await deps.checkCardPayment(state.orderId);
    if (check) return cardCheckReply(state, check);
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
    if (extractChoice(message, state.options.length + 1) === state.options.length + 1) {
      const catalogItems = await deps.loadCatalog();
      state.options = [];
      state.stage = state.cart.length ? missingStage(state, deps) : "idle";
      return reply(state, catalogOverview(catalogItems, deps.storeUrl), "R5:catalogo_completo", { intent: "menu", route: "catalog" });
    }
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

  // "tarjeta" / "transferencia" con carrito es la forma de pago, nunca una busqueda
  // de producto (antes "tarjeta" en el resumen agregaba una impresora al pedido).
  const namedMethod = detectPaymentMethod(message);
  if (namedMethod && state.cart.length && state.stage !== "choosing" && extraction.intent !== "pregunta") {
    const available = namedMethod === "card" ? deps.cardEnabled : deps.banks.length > 0;
    if (!available) {
      const other = namedMethod === "card" ? "transferencia bancaria 🏦" : "tarjeta con link de Payphone 💳";
      return askNext(state, deps, "R6:pago_no_disponible", `Por ahora ese medio no lo tenemos activo 🙏 Puedes pagar con ${other}`);
    }
    state.paymentMethod = namedMethod;
    return askNext(state, deps, "R6:pago", "Perfecto 👍");
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

  // "también una impresora" cuando se pide el nombre es un producto, no un nombre.
  const asksProduct =
    /\b(tambien|ademas|otra|otro|agrega|agregame|anade|quiero|busco|necesito)\b/.test(normalize(message)) && searchProducts(catalog, message).length > 0;
  // Respuesta al paso pendiente (nombre, correo, direccion, pago) con reglas.
  if (!asksProduct && ["name", "email", "address", "payment", "bank"].includes(state.stage) && applyStageAnswer(state, message, deps)) {
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
      resume(`Uy, eso se me escapa 🙈 Pero en todo lo de *Megaprinter* cuenta conmigo siempre: equipos, impresoras, cámaras, servicio técnico y tus pedidos 💻🖨️✨`),
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
    return reply(state, `Hola! Soy *${botName()}* 🤖, la bot de *Megaprinter* y tu agente para lo que necesites. Aquí estoy para ayudarte siempre!\n\n${ASK_PRODUCT}`, "R9:saludo");
  }
  if (state.stage === "choosing") {
    return reply(state, "No te entendí 🙏 Responde con el número de la opción que quieres, o dime qué otra cosa buscas.", "R9:eleccion_no_entendida");
  }
  return askNext(state, deps, "R9:siguiente_paso");
}

// ─── Decision del flujo principal (/brain) ───────────────────────────────────

/** Rutas que decide /brain: a que flujo de BuilderBot va el mensaje. */
/**
 * Rutas que decide /brain: una por flujo de BuilderBot (6 flujos: Principal,
 * Conversacion, Catalogo, Checkout tarjeta, Checkout transferencia, Asesor humano).
 * Todos los endpoints procesan el turno completo, asi que pedidos, consultas y
 * fotos se atienden bien aunque no tengan un flujo propio.
 */
export const DECISIONS = ["conversation", "catalog", "checkoutCard", "checkoutTransfer", "human"] as const;
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

  // Fotos: al flujo de transferencia, que en BuilderBot tiene el evento IMAGEN O VIDEO.
  if (input.mediaUrl || (input.mediaEvent && !message)) return { route: "checkoutTransfer", reason: "archivo adjunto" };
  if (!message) return { route: "conversation", reason: "mensaje vacio" };
  // "hablo con una persona?" es una pregunta (se responde que es un bot), no un pedido de asesor.
  if (asksIfBot(message)) return { route: "conversation", reason: "pregunta si es un bot" };
  if (wantsHuman(message)) return { route: "human", reason: "pide una persona" };
  if (wantsTracking(message) || orderNumberIn(message)) return { route: "conversation", reason: "consulta de pedido" };
  // "sí" al resumen del ticket: se registra y el chat pasa a un asesor (el flujo silencia el bot).
  if (state.stage === "ticket_confirm" && isYes(message)) return { route: "human", reason: "confirma ticket de servicio" };
  if (state.stage === "confirm" && isYes(message)) {
    if (state.paymentMethod === "transfer" && options.bank) return { route: "checkoutTransfer", reason: "confirma pedido por transferencia" };
    if (state.paymentMethod === "card" && options.cardEnabled) return { route: "checkoutCard", reason: "confirma pedido con tarjeta" };
    return { route: "conversation", reason: "confirma pedido sin metodo de pago" };
  }
  if (wantsCatalog(message) && state.stage !== "choosing") return { route: "catalog", reason: "pide el catalogo" };
  return { route: "conversation", reason: "conversacion" };
}
