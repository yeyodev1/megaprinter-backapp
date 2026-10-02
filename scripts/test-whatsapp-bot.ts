/**
 * Pruebas del bot de WhatsApp sin red ni Mongo: router real, catalogo fijo,
 * extractor por reglas (Gemini apagado) y dependencias falsas.
 *
 *   pnpm test:bot            (VERBOSE=1 para ver las conversaciones)
 */
import assert from "assert/strict";
import { BotProduct } from "../src/services/whatsappBot/catalog";
import { aiExtract, cleanAnswer, heuristicExtract, answerPricesAreReal } from "../src/services/whatsappBot/extractor";
import * as gemini from "../src/services/gemini.service";
import axios from "axios";
import { decideFromSale, paymentAttempts, settleCardPayment } from "../src/services/payphone.service";
import { keepsData, naturalize } from "../src/services/whatsappBot/voice";
import { BotDeps, BotState, CardCheck, OrderSummary, ReceiptOutcome, TurnResult, createInitialState, decideRoute, handleTurn } from "../src/services/whatsappBot/router";
import { builderBotHistory, latestUserMessage, phoneVariants, readMediaUrl, toE164 } from "../src/controllers/whatsappBot.controller";
import { extractChoice, extractQuantity, detectPaymentMethod, wantsOptOut } from "../src/services/whatsappBot/intents";
import { estimateService } from "../src/services/whatsappBot/serviceCatalog";

const CATALOG: BotProduct[] = [
  { id: "p1", name: "Laptop HP 15 Core i5 16GB RAM 512GB SSD", price: 649, originalPrice: 749, category: "Laptops", kind: "product", description: "Laptop para trabajo y estudio", specs: "Procesador: Intel Core i5; RAM: 16GB; Almacenamiento: 512GB SSD" },
  { id: "p2", name: "Laptop Dell Inspiron Core i7 16GB RAM 1TB SSD", price: 899, originalPrice: null, category: "Laptops", kind: "product", description: "Rendimiento para diseño", specs: "Procesador: Intel Core i7; RAM: 16GB; Almacenamiento: 1TB SSD" },
  { id: "p3", name: "Impresora Epson L3250 tinta continua WiFi", price: 229, originalPrice: 259, category: "Impresoras", kind: "product", description: "Multifunción", specs: "Tipo: Tinta continua; Conectividad: WiFi" },
  { id: "p4", name: "Monitor AOC 24 pulgadas Full HD", price: 139, originalPrice: null, category: "Monitores", kind: "product", description: "Monitor IPS", specs: "Tamaño: 24 pulgadas; Resolución: 1920x1080" },
];

const account = (id: string, bankCode: string, bank: string, accountType: string, accountNumber: string) => ({
  id, bankCode, bank, accountType, accountNumber, accountHolder: "Selena Mendoza Marcillo", holderId: "1314709419", logoUrl: "",
});
const BANK = { ...account("b0", "pichincha", "Banco Pichincha", "corriente", "2100123456"), accountHolder: "Megaprinter S.A.", holderId: "0999999999001" };
const FOUR_BANKS = [
  account("b1", "guayaquil", "Banco Guayaquil", "de ahorros", "4386056"),
  account("b2", "pacifico", "Banco del Pacífico", "corriente", "8091250"),
  account("b3", "produbanco", "Produbanco", "de ahorros", "12040641835"),
  account("b4", "pichincha", "Banco Pichincha", "de ahorros", "2203005219"),
];

interface Fake {
  deps: BotDeps;
  created: BotState[];
  tickets: any[];
  receipts: Array<{ orderId: string; url: string }>;
}

function fakeDeps(options: { bank?: boolean; banks?: typeof FOUR_BANKS; card?: boolean; receipt?: ReceiptOutcome; orders?: OrderSummary[]; cardCheck?: CardCheck | null } = {}): Fake {
  const created: BotState[] = [];
  const receipts: Array<{ orderId: string; url: string }> = [];
  const tickets: any[] = [];
  return {
    created,
    receipts,
    tickets,
    deps: {
      loadCatalog: async () => CATALOG,
      extract: heuristicExtract,
      createOrder: async (state) => {
        created.push(JSON.parse(JSON.stringify(state)));
        const total = state.cart.reduce((sum, line) => sum + line.price * line.quantity, 0);
        return { orderId: `o${created.length}`, orderNumber: `MP-0000${created.length}`, total, paymentLink: state.paymentMethod === "card" ? "https://megaprinter.ec/pagar/tok" : "" };
      },
      receiveReceipt: async (orderId, url) => {
        receipts.push({ orderId, url });
        return options.receipt || { status: "stored", orderNumber: "MP-00001", total: 649, detectedAmount: 649, amountMatches: true, isReceipt: true };
      },
      findOrders: async () => options.orders || [],
      checkCardPayment: async () => (options.cardCheck === undefined ? null : options.cardCheck),
      createTicket: async (draft) => {
        tickets.push(draft);
        return { ticketNumber: `ST-0000${tickets.length}` };
      },
      banks: options.bank === false ? [] : options.banks || [BANK],
      cardEnabled: options.card !== false,
      supportPhone: "",
      storeUrl: "https://megaprinter.ec",
    },
  };
}

async function conversation(fake: Fake, messages: Array<string | { media: string }>, initial = createInitialState()) {
  let state = initial;
  const results: TurnResult[] = [];
  for (const entry of messages) {
    const input = typeof entry === "string" ? { message: entry } : { message: "", mediaUrl: entry.media };
    const result = await handleTurn(state, input, fake.deps);
    if (process.env.VERBOSE) console.log(`  👤 ${typeof entry === "string" ? entry : "[imagen]"}\n  🤖 ${result.reply.replace(/\n/g, "\n     ")}  [${result.decision} · ${result.step}]\n`);
    results.push(result);
    state = result.state;
  }
  return results;
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`❌ ${name}\n   ${error instanceof Error ? error.message : error}`);
  }
}

async function main() {
  await test("compra completa por transferencia: datos bancarios y comprobante", async () => {
    const fake = fakeDeps();
    const results = await conversation(fake, [
      "hola",
      "busco una impresora de tinta continua",
      "1",
      "Ana Pérez",
      "ana@correo.com",
      "Av. 9 de Octubre 123, Guayaquil",
      "transferencia",
      "si",
      { media: "https://files.builderbot.app/tmp/abc.jpg" },
    ]);
    const [, search, chosen, , , , payment, confirmed, receipt] = results;
    assert.equal(search.decision, "R8:busqueda");
    assert.match(search.reply, /Epson L3250/);
    assert.equal(chosen.state.cart[0].productId, "p3");
    assert.equal(payment.step, "confirm");
    assert.match(payment.reply, /Transferencia bancaria/);
    assert.equal(confirmed.intent, "orden_creada");
    assert.equal(confirmed.route, "checkoutTransfer");
    assert.equal(payment.route, "confirmOrder");
    assert.equal(receipt.route, "receiptReceived");
    assert.match(confirmed.reply, /2100123456/);
    assert.match(confirmed.reply, /comprobante/);
    assert.equal(confirmed.paymentLink, "");
    assert.equal(fake.created[0].paymentMethod, "transfer");
    assert.equal(fake.created[0].customerEmail, "ana@correo.com");
    assert.equal(receipt.intent, "comprobante_recibido");
    assert.deepEqual(fake.receipts[0], { orderId: "o1", url: "https://files.builderbot.app/tmp/abc.jpg" });
  });

  await test("compra con tarjeta: devuelve el link de pago", async () => {
    const fake = fakeDeps();
    const results = await conversation(fake, ["laptop i7", "si", "Luis Mora", "luis@mail.com", "retiro", "tarjeta", "sí"]);
    const last = results.at(-1)!;
    assert.equal(results[0].state.options.length, 1);
    assert.equal(last.intent, "orden_creada");
    assert.equal(last.route, "checkoutCard");
    assert.equal(last.paymentLink, "https://megaprinter.ec/pagar/tok");
    assert.match(last.reply, /pagar\/tok/);
    assert.equal(fake.created[0].address, "Retiro en tienda");
    assert.equal(fake.created[0].cart[0].productId, "p2");
  });

  await test("varias cuentas: pregunta el banco SIN mandar los números y envía solo la elegida", async () => {
    const fake = fakeDeps({ banks: FOUR_BANKS });
    const results = await conversation(fake, ["monitor", "1", "Eva Ruiz", "eva@mail.com", "Quito", "transferencia", "3", "si"]);
    const ask = results[5];
    assert.equal(ask.step, "bank");
    assert.match(ask.reply, /A qué banco te queda mejor transferir\?[\s\S]*Banco Guayaquil[\s\S]*Produbanco/);
    for (const bank of FOUR_BANKS) assert.doesNotMatch(ask.reply, new RegExp(bank.accountNumber), "no manda números de cuenta al preguntar");
    assert.match(results[6].reply, /Transferencia bancaria · Produbanco/);
    const done = results[7];
    assert.equal(done.route, "checkoutTransfer");
    assert.match(done.reply, /12040641835/);
    assert.doesNotMatch(done.reply, /4386056|8091250|2203005219/, "solo la cuenta elegida");
    assert.equal(fake.created[0].bankId, "b3");
  });

  await test("nombrar el banco elige transferencia y esa cuenta", async () => {
    const results = await conversation(fakeDeps({ banks: FOUR_BANKS }), ["monitor", "1", "Eva Ruiz", "eva@mail.com", "Quito", "te pago por pichincha"]);
    assert.equal(results.at(-1)!.state.paymentMethod, "transfer");
    assert.equal(results.at(-1)!.state.bankId, "b4");
    assert.equal(results.at(-1)!.step, "confirm");
  });

  await test("'Guayaquil' en la dirección o 'Pichincha' como provincia no eligen banco", async () => {
    const results = await conversation(fakeDeps({ banks: FOUR_BANKS }), ["monitor", "1", "Eva Ruiz", "eva@mail.com", "Av. 9 de Octubre, Guayaquil"]);
    assert.equal(results.at(-1)!.state.bankId, "");
    const quito = await conversation(fakeDeps({ banks: FOUR_BANKS }), ["monitor", "1", "Eva Ruiz", "eva@mail.com", "Calle Larga, Quito, Pichincha"]);
    assert.equal(quito.at(-1)!.state.bankId, "");
    assert.equal(quito.at(-1)!.step, "payment");
  });

  await test("en el paso de banco, 'guayaquil' sí es Banco Guayaquil", async () => {
    const results = await conversation(fakeDeps({ banks: FOUR_BANKS }), ["monitor", "1", "Eva Ruiz", "eva@mail.com", "retiro", "transferencia", "guayaquil"]);
    assert.equal(results.at(-1)!.state.bankId, "b1");
  });

  await test("sin cuenta bancaria configurada no ofrece transferencia", async () => {
    const fake = fakeDeps({ bank: false });
    const results = await conversation(fake, ["monitor", "1", "Eva Ruiz", "eva@mail.com", "Quito centro norte"]);
    assert.equal(results.at(-1)!.step, "confirm");
    assert.match(results.at(-1)!.reply, /Tarjeta/);
    assert.doesNotMatch(results.at(-1)!.reply, /¿Cómo prefieres pagar/);
  });

  await test("sin ningún método de pago, el pedido queda para un asesor", async () => {
    const fake = fakeDeps({ bank: false, card: false });
    const results = await conversation(fake, ["monitor", "1", "Eva Ruiz", "eva@mail.com", "Quito centro norte", "si"]);
    assert.equal(results.at(-1)!.intent, "orden_creada");
    assert.match(results.at(-1)!.reply, /persona del equipo/);
    assert.equal(results.at(-1)!.route, "checkoutAdvisor");
  });

  await test("todos los datos en un mensaje no rompen el orden de preguntas", async () => {
    const fake = fakeDeps();
    const results = await conversation(fake, ["impresora epson", "1", "Carla Vera", "mi correo es carla@x.com y pago por transferencia"]);
    assert.equal(results.at(-1)!.state.customerEmail, "carla@x.com");
    assert.equal(results.at(-1)!.state.paymentMethod, "transfer");
    assert.equal(results.at(-1)!.step, "address");
  });

  await test("nombre y correo en el mismo mensaje", async () => {
    const results = await conversation(fakeDeps(), ["monitor", "1", "Luis Mora luis@mail.com"]);
    assert.equal(results.at(-1)!.state.customerName, "Luis Mora");
    assert.equal(results.at(-1)!.state.customerEmail, "luis@mail.com");
    assert.equal(results.at(-1)!.step, "address");
  });

  await test("correo cuando se pedía el nombre: se guarda y vuelve a pedir el nombre", async () => {
    const results = await conversation(fakeDeps(), ["monitor", "1", "luis@mail.com"]);
    assert.equal(results.at(-1)!.state.customerEmail, "luis@mail.com");
    assert.equal(results.at(-1)!.step, "name");
    assert.doesNotMatch(results.at(-1)!.reply, /No encontré/);
  });

  await test("saludo después de una orden empieza conversación nueva", async () => {
    const results = await conversation(fakeDeps(), ["monitor", "1", "Eva Ruiz", "eva@mail.com", "Quito", "transferencia", "si", "hola"]);
    assert.equal(results.at(-1)!.decision, "R9:saludo");
    assert.equal(results.at(-1)!.step, "idle");
    assert.doesNotMatch(results.at(-1)!.reply, /comprobante/);
  });

  await test("decir 'no' en el resumen permite cambiar un dato", async () => {
    const fake = fakeDeps();
    const results = await conversation(fake, ["monitor", "1", "Eva Ruiz", "eva@mail.com", "Quito", "tarjeta", "no", "otro@mail.com"]);
    assert.equal(results[6].decision, "R7:pedir_cambio");
    assert.equal(results[7].state.customerEmail, "otro@mail.com");
    assert.equal(results[7].step, "confirm");
    assert.equal(fake.created.length, 0);
  });

  await test("estilo Mila: ningún mensaje lleva ¿ ni ¡ al inicio", async () => {
    const fake = fakeDeps({ banks: FOUR_BANKS });
    const results = await conversation(fake, ["hola", "monitor", "1", "Eva Ruiz", "eva@mail.com", "Quito", "transferencia", "2", "no", "si", "si"]);
    for (const result of results) assert.doesNotMatch(result.reply, /[¿¡]/, result.decision);
    assert.match(results[0].reply, /^Hola! Soy \*Mila\* 🤖, la bot de \*Megaprinter\* y tu agente para lo que necesites\. Aquí estoy para ayudarte siempre![\s\S]*servicio técnico[\s\S]*suministros/);
  });

  await test("transparencia: si preguntan si es un bot, dice que sí", async () => {
    for (const question of ["eres un bot?", "hablo con una persona o con un robot?", "eres real?", "estoy hablando con una ia?"]) {
      const result = (await conversation(fakeDeps(), [question]))[0];
      assert.equal(result.decision, "R2:soy_un_bot", question);
      assert.match(result.reply, /Sí, soy un bot 🤖[\s\S]*\*asesor\*/);
    }
    assert.equal((await conversation(fakeDeps(), ["quiero hablar con un asesor"]))[0].route, "human");
    const on = { bank: true, cardEnabled: true };
    assert.equal(decideRoute(null, { message: "hablo con una persona?" }, on).route, "conversation");
    assert.equal(decideRoute(null, { message: "quiero hablar con una persona" }, on).route, "human");
    assert.equal(keepsData("Sí, soy un bot 🤖", "Claro, te ayudo 😊"), false, "la IA no puede borrar que es un bot");
  });

  await test("fuera de tema (política de Meta): no responde y vuelve a Megaprinter", async () => {
    const fake = fakeDeps();
    fake.deps.extract = async () => ({ intent: "fuera_de_tema", items: [], remove: [], searchQuery: "", suggestions: [], source: "ai" });
    const result = (await conversation(fake, ["hazme la tarea de historia"]))[0];
    assert.equal(result.decision, "R8:fuera_de_tema");
    assert.match(result.reply, /Megaprinter/);
  });

  await test("'no me escribas' se respeta y se confirma", async () => {
    const result = (await conversation(fakeDeps(), ["por favor no me escribas más"]))[0];
    assert.equal(result.decision, "R0:no_escribir");
    assert.equal(result.state.optOut, true);
    assert.equal(wantsOptOut("hola, busco una laptop"), false);
  });

  await test("'pagado' con tarjeta: Mila verifica con Payphone y responde según el estado real", async () => {
    const check = (outcome: CardCheck["outcome"]): CardCheck => ({ outcome, orderNumber: "MP-00020", total: 649, paymentLink: "https://megaprinter.ec/pagar/tok" });
    const paid = (await conversation(fakeDeps({ cardCheck: check("paid_now") }), ["ya pagué"]))[0];
    assert.equal(paid.decision, "R3:pago_confirmado");
    assert.match(paid.reply, /\$649\.00[\s\S]*MP-00020[\s\S]*confirmado/);
    const again = (await conversation(fakeDeps({ cardCheck: check("already_paid") }), ["pagado"]))[0];
    assert.equal(again.decision, "R3:pago_ya_confirmado");
    const pending = (await conversation(fakeDeps({ cardCheck: check("pending") }), ["listo pagué"]))[0];
    assert.equal(pending.decision, "R3:pago_pendiente");
    assert.match(pending.reply, /pagar\/tok/);
    const rejected = (await conversation(fakeDeps({ cardCheck: check("rejected") }), ["pagado"]))[0];
    assert.equal(rejected.decision, "R3:pago_rechazado");
    const mismatch = (await conversation(fakeDeps({ cardCheck: check("mismatch") }), ["pagado"]))[0];
    assert.equal(mismatch.route, "human");
    // Pedido por transferencia: "ya pagué" pide el comprobante, no consulta Payphone.
    const transfer = await conversation(fakeDeps({ cardCheck: check("pending") }), ["monitor", "1", "Eva Ruiz", "eva@mail.com", "Quito", "transferencia", "si", "ya pagué"]);
    assert.equal(transfer.at(-1)!.decision, "R3:pedir_comprobante");
  });

  await test("Payphone: confirma el intento aprobado (aunque sea viejo) y no toca lo pendiente", async () => {
    assert.equal(decideFromSale({ found: false }), "pending");
    assert.equal(decideFromSale({ found: true, statusCode: 3, transactionId: 99 }), "confirm");
    assert.equal(decideFromSale({ found: true, statusCode: 2 }), "rejected");
    assert.equal(decideFromSale({ found: true, statusCode: 1, transactionId: 5 }), "pending");
    assert.deepEqual(paymentAttempts({ clientTransactionId: "C", clientTransactionIds: ["A", "B"] }), ["C", "B", "A"]);

    const originalGet = axios.get;
    const originalPost = axios.post;
    const confirms: string[] = [];
    process.env.PAYPHONE_TOKEN = process.env.PAYPHONE_TOKEN || "test";
    const makeOrder = () => ({ source: "payphone", status: "pending", totalAmount: 649, clientTransactionId: "C", clientTransactionIds: ["A", "B"], saves: 0, async save() { this.saves += 1; } });
    try {
      // Pagó en el intento "A" (viejo); "C" y "B" no existen en Payphone.
      (axios as any).get = async (url: string) =>
        url.endsWith("/A") ? { status: 200, data: { statusCode: 3, transactionStatus: "Approved", transactionId: 777 } } : { status: 404, data: { message: "No existe", errorCode: 1 } };
      (axios as any).post = async (_url: string, body: any) => {
        confirms.push(body.clientTxId);
        return { data: { statusCode: 3, transactionStatus: "Approved", transactionId: 777, amount: 64900 } };
      };
      const order: any = makeOrder();
      assert.equal(await settleCardPayment(order), "paid_now");
      assert.equal(order.status, "paid");
      assert.equal(order.payphoneTransactionId, 777);
      assert.deepEqual(confirms, ["A"]);
      assert.equal(await settleCardPayment(order), "already_paid", "segundo 'pagado' no vuelve a confirmar");
      assert.equal(confirms.length, 1);

      // Monto distinto: no queda pagado.
      (axios as any).post = async () => ({ data: { statusCode: 3, transactionId: 777, amount: 100 } });
      const cheap: any = makeOrder();
      assert.equal(await settleCardPayment(cheap), "mismatch");
      assert.equal(cheap.status, "pending");

      // Todavía no paga: el pedido queda intacto.
      (axios as any).get = async () => ({ status: 404, data: { message: "No existe", errorCode: 1 } });
      const untouched: any = makeOrder();
      assert.equal(await settleCardPayment(untouched), "pending");
      assert.equal(untouched.status, "pending");
      assert.equal(untouched.saves, 0);
    } finally {
      (axios as any).get = originalGet;
      (axios as any).post = originalPost;
    }
  });

  await test("'tarjeta' en el resumen no busca productos ni agrega nada", async () => {
    const fake = fakeDeps({ bank: false });
    const results = await conversation(fake, ["monitor", "1", "Eva Ruiz", "eva@mail.com", "retiro", "tarjeta", "si"]);
    assert.equal(results[4].step, "confirm", "con un solo método pasa directo al resumen");
    assert.equal(results[5].decision, "R6:pago");
    assert.equal(results[5].state.cart.length, 1);
    assert.equal(results[6].intent, "orden_creada");
    assert.equal(fake.created[0].cart.length, 1);
    const off = (await conversation(fakeDeps({ bank: false }), ["monitor", "1", "Eva Ruiz", "eva@mail.com", "retiro", "transferencia"])).at(-1)!;
    assert.equal(off.decision, "R6:pago_no_disponible");
    assert.match(off.reply, /tarjeta/);
  });

  await test("'también una impresora' al pedir el nombre agrega otro producto", async () => {
    const results = await conversation(fakeDeps(), ["monitor", "1", "también una impresora", "1", "Lucía Vega"]);
    assert.equal(results[2].decision, "R8:busqueda");
    assert.equal(results[2].state.customerName, "");
    assert.equal(results[3].state.cart.length, 2);
    assert.equal(results[4].state.customerName, "Lucía Vega");
  });

  await test("link de tarjeta pide volver con 'pagado' y la captura del pago se verifica", async () => {
    const created = (await conversation(fakeDeps({ bank: false }), ["monitor", "1", "Eva Ruiz", "eva@mail.com", "retiro", "si"])).at(-1)!;
    assert.match(created.reply, /regresa aquí y escríbeme \*pagado\*[\s\S]*captura del pago/);
    const check: CardCheck = { outcome: "paid_now", orderNumber: "MP-00030", total: 90, paymentLink: "https://megaprinter.ec/pagar/t" };
    const screenshot = (await conversation(fakeDeps({ receipt: { status: "no_order" }, cardCheck: check }), [{ media: "https://x/captura.png" }]))[0];
    assert.equal(screenshot.decision, "R3:pago_confirmado");
  });

  await test("'mi pedido' muestra enviado con guía y el link de seguimiento", async () => {
    const orders: OrderSummary[] = [{ id: "s", orderNumber: "MP-00031", status: "shipped", source: "payphone", total: 90, transferStatus: "", paymentLink: "", carrier: "Servientrega", trackingNumber: "SV123", trackingUrl: "https://megaprinter.ec/pedido/t", createdAt: new Date() }];
    const result = (await conversation(fakeDeps({ orders }), ["estado de mi pedido"]))[0];
    assert.match(result.reply, /enviado 🚚 · guía Servientrega SV123[\s\S]*megaprinter\.ec\/pedido\/t/);
  });

  await test("servicio técnico: pide nombre, equipo y problema, muestra precio y crea ticket al confirmar", async () => {
    const fake = fakeDeps();
    const results = await conversation(fake, ["necesito servicio técnico", "Juan Pérez", "1", "no imprime, sale con rayas", "si"]);
    assert.equal(results[0].step, "ticket_name");
    assert.equal(results[1].step, "ticket_device");
    assert.match(results[1].reply, /Impresora[\s\S]*Laptop/);
    assert.equal(results[2].step, "ticket_issue");
    const summary = results[3];
    assert.equal(summary.step, "ticket_confirm");
    assert.match(summary.reply, /Servicio técnico[\s\S]*Impresora[\s\S]*no imprime[\s\S]*\$20 – \$35[\s\S]*diagnóstico es sin costo/);
    const done = results[4];
    assert.equal(done.decision, "R10:ticket_creado");
    assert.equal(done.route, "human");
    assert.match(done.reply, /ST-00001[\s\S]*En breve un asesor tomará el chat/);
    assert.equal(fake.tickets[0].device, "impresora");
    assert.equal(fake.tickets[0].estimate.priceMin, 20);
    assert.equal(decideRoute(summary.state, { message: "sí" }, { bank: true, cardEnabled: true }).route, "human", "/brain manda el sí al flujo de asesor");
  });

  await test("servicio técnico con todo en el primer mensaje va directo al resumen", async () => {
    const fake = fakeDeps();
    const results = await conversation(fake, ["mi laptop está muy lenta, necesito formatear", "Eva Ruiz"]);
    assert.equal(results[0].step, "ticket_name");
    assert.equal(results[1].step, "ticket_confirm", "ya sabía el equipo y el problema");
    assert.match(results[1].reply, /Laptop[\s\S]*\$25 – \$40/);
  });

  await test("'servicio técnico para mi impresora' no es la descripción; 'no imprime' en el resumen es detalle, no un 'no'", async () => {
    const fake = fakeDeps();
    const results = await conversation(fake, ["necesito servicio técnico para mi impresora", "Juan Pérez", "no imprime, sale con rayas", "no enciende a veces", "si"]);
    assert.equal(results[0].state.ticket.device, "impresora");
    assert.equal(results[0].state.ticket.issue, "", "todavía no contó el problema");
    assert.equal(results[1].step, "ticket_issue");
    assert.equal(results[2].step, "ticket_confirm");
    assert.equal(results[3].decision, "R10:ticket_mas_detalle", "'no enciende…' agrega detalle, no corrige");
    assert.equal(results[4].decision, "R10:ticket_creado");
    const corrected = await conversation(fakeDeps(), ["necesito servicio técnico", "Eva Ruiz", "2", "pantalla rota", "no"]);
    assert.equal(corrected.at(-1)!.decision, "R10:ticket_corregir");
  });

  await test("suministros: pide el detalle y crea la solicitud sin precio", async () => {
    const fake = fakeDeps();
    const results = await conversation(fake, ["necesito tinta", "Carla Vera", "tinta negra para Epson L3250", "sí"]);
    assert.equal(results[2].step, "ticket_confirm");
    assert.match(results[2].reply, /Suministros[\s\S]*Epson L3250[\s\S]*cotizamos/);
    assert.equal(results[3].route, "human");
    assert.equal(fake.tickets[0].type, "suministros");
  });

  await test("'impresora de tinta continua' busca productos, no suministros; 'no funciona el link' no es servicio", async () => {
    const product = (await conversation(fakeDeps(), ["busco impresora de tinta continua"]))[0];
    assert.equal(product.decision, "R8:busqueda");
    const link = (await conversation(fakeDeps(), ["no funciona el link de pago"]))[0];
    assert.doesNotMatch(link.decision, /R10/);
  });

  await test("el catálogo completo es la última opción de la lista", async () => {
    const results = await conversation(fakeDeps(), ["laptop", "3"]);
    assert.match(results[0].reply, /\*3\.\* 📚 Ver el catálogo completo[\s\S]*\*asesor\*/);
    assert.equal(results[1].decision, "R5:catalogo_completo");
    assert.equal(results[1].state.cart.length, 0);
  });

  await test("precio referencial: catálogo primero, luego tabla de Ecuador", () => {
    assert.equal(estimateService("impresora", "parpadean las luces").priceMax, 20);
    assert.equal(estimateService("laptop", "se rompió la pantalla").priceMin, 60);
    assert.equal(estimateService("camara", "quiero instalar 4 cámaras").label, "Instalación de cámaras (por cámara)");
    const withCatalog = estimateService("impresora", "mantenimiento", [{ id: "s1", name: "Mantenimiento de impresora", price: 18, originalPrice: null, category: "Servicio técnico", kind: "service", description: "", specs: "" }]);
    assert.equal(withCatalog.priceSource, "catalogo");
    assert.equal(withCatalog.priceMin, 18);
  });

  await test("pedir asesor deriva con intencion dudas", async () => {
    const result = (await conversation(fakeDeps(), ["quiero hablar con un asesor"]))[0];
    assert.equal(result.intent, "dudas");
    assert.equal(result.route, "human");
  });

  await test("catálogo responde con resumen por categoría", async () => {
    const result = (await conversation(fakeDeps(), ["catálogo"]))[0];
    assert.equal(result.intent, "menu");
    assert.equal(result.route, "catalog");
    assert.match(result.reply, /Laptops\*: 2 modelos desde \$649\.00/);
  });

  await test("comprobante sin pedido pendiente pide el número de pedido", async () => {
    const result = (await conversation(fakeDeps({ receipt: { status: "no_order" } }), [{ media: "https://x/y.jpg" }]))[0];
    assert.equal(result.decision, "R1:comprobante_sin_pedido");
    assert.match(result.reply, /MP-/);
  });

  const image = (extra: Partial<Extract<ReceiptOutcome, { status: "image" }>>): ReceiptOutcome => ({
    status: "image", kind: "product", description: "una impresora Epson L3250", searchQuery: "impresora epson l3250", productIds: [], exactMatch: false, ...extra,
  });

  await test("foto o captura de IG de un producto que SÍ tenemos", async () => {
    const result = (await conversation(fakeDeps({ receipt: image({ productIds: ["p3"], exactMatch: true }) }), [{ media: "https://x/ig.jpg" }]))[0];
    assert.equal(result.decision, "R1:foto_producto_exacto");
    assert.match(result.reply, /Sí lo tenemos![\s\S]*Epson L3250/);
    assert.equal(result.state.options.length, 1);
  });

  await test("foto de un modelo que no tenemos: muestra los parecidos", async () => {
    const result = (await conversation(fakeDeps({ receipt: image({ description: "una laptop Dell XPS", productIds: ["p2", "p1"] }) }), [{ media: "https://x/f.jpg" }]))[0];
    assert.equal(result.decision, "R1:foto_producto_parecido");
    assert.match(result.reply, /no lo tengo en tienda/);
    assert.equal(result.state.options[0].productId, "p2");
  });

  await test("foto de algo que no vendemos: ofrece cotizar con un asesor", async () => {
    const result = (await conversation(fakeDeps({ receipt: image({ description: "un plotter HP DesignJet", searchQuery: "plotter designjet" }) }), [{ media: "https://x/f.jpg" }]))[0];
    assert.equal(result.decision, "R1:foto_producto_sin_stock");
    assert.match(result.reply, /asesor/);
  });

  await test("imagen que no es comprobante con transferencia pendiente: NO se guarda como pago", async () => {
    const fake = fakeDeps({ receipt: image({ kind: "other", description: "un gato", pendingOrderNumber: "MP-00007" }) });
    const result = (await conversation(fake, [{ media: "https://x/gato.jpg" }]))[0];
    assert.equal(result.decision, "R1:imagen");
    assert.notEqual(result.intent, "comprobante_recibido");
    assert.match(result.reply, /MP-00007/);
  });

  await test("videos y audios: avisa que no se procesan", async () => {
    const video = (await conversation(fakeDeps({ receipt: { status: "video" } }), [{ media: "https://x/v.mp4" }]))[0];
    assert.match(video.reply, /no puedo ver videos[\s\S]*foto o captura/);
    const audio = (await conversation(fakeDeps({ receipt: { status: "audio" } }), [{ media: "https://x/a.ogg" }]))[0];
    assert.match(audio.reply, /escuchar audios/);
    const noUrl = await handleTurn(createInitialState(), { message: "", mediaWithoutUrl: true, mediaEvent: "video" }, fakeDeps().deps);
    assert.equal(noUrl.decision, "R0:video_sin_url");
  });

  await test("historial de BuilderBot como contexto para la IA", () => {
    const text = builderBotHistory('[{"role":"user","content":"hola"},{"role":"assistant","content":"¿qué buscas?"},{"role":"user","content":"laptop"}]');
    assert.equal(text, "Cliente: hola\nBot: ¿qué buscas?\nCliente: laptop");
    assert.equal(builderBotHistory("{history}"), "");
    assert.equal(builderBotHistory(undefined), "");
  });

  await test("monto distinto en el comprobante se avisa al cliente", async () => {
    const fake = fakeDeps({ receipt: { status: "stored", orderNumber: "MP-00009", total: 649, detectedAmount: 300, amountMatches: false, isReceipt: true } });
    const result = (await conversation(fake, [{ media: "https://x/y.jpg" }]))[0];
    assert.match(result.reply, /\$300\.00/);
    assert.equal(result.intent, "comprobante_recibido");
  });

  await test("número de pedido de la web asocia el chat a ese pedido", async () => {
    const orders: OrderSummary[] = [{ id: "web1", orderNumber: "MP-00042", status: "pending", source: "transfer", total: 229, transferStatus: "awaiting_receipt", paymentLink: "", createdAt: new Date() }];
    const fake = fakeDeps({ orders });
    const results = await conversation(fake, ["mi pedido es el MP-42", { media: "https://x/r.png" }]);
    assert.equal(results[0].decision, "R3:pedido_por_numero");
    assert.equal(fake.receipts[0].orderId, "web1");
  });

  await test("consultar pedidos lista el estado de la transferencia", async () => {
    const orders: OrderSummary[] = [{ id: "a", orderNumber: "MP-00003", status: "pending", source: "transfer", total: 139, transferStatus: "in_review", paymentLink: "", createdAt: new Date() }];
    const result = (await conversation(fakeDeps({ orders }), ["cuál es el estado de mi pedido"]))[0];
    assert.equal(result.intent, "consultar_pedido");
    assert.equal(result.route, "searchOrder");
    assert.match(result.reply, /comprobante en revisión/);
  });

  await test("después de la orden, 'ya transferí' pide la foto del comprobante", async () => {
    const fake = fakeDeps();
    const results = await conversation(fake, ["monitor", "1", "Eva Ruiz", "eva@mail.com", "Quito", "transferencia", "si", "ya transferí"]);
    assert.equal(results.at(-1)!.decision, "R3:pedir_comprobante");
    assert.equal(results.at(-1)!.route, "awaitingReceipt");
  });

  await test("vaciar carrito", async () => {
    const results = await conversation(fakeDeps(), ["monitor", "1", "vaciar carrito"]);
    assert.equal(results.at(-1)!.state.cart.length, 0);
  });

  await test("extractor con Gemini: valida refs, correo, pago y precios", async () => {
    const original = gemini.geminiJson;
    const context = { stage: "idle", lastQuestion: "", cart: [], history: "", catalog: CATALOG };
    try {
      (gemini as any).geminiJson = async () => ({
        intent: "comprar", items: [{ ref: 1, quantity: 2 }, { ref: 99, quantity: 1 }], remove: [], searchQuery: "",
        suggestions: [0, 42], customerName: "Ana", customerEmail: "no-es-correo", address: null, paymentMethod: "bitcoin", answer: "",
      });
      const buy = await aiExtract("quiero 2 dell", context);
      assert.deepEqual(buy.items, [{ productId: "p2", quantity: 2 }]);
      assert.deepEqual(buy.suggestions, ["p1"]);
      assert.equal(buy.customerEmail, undefined);
      assert.equal(buy.paymentMethod, undefined);

      (gemini as any).geminiJson = async () => ({ intent: "pregunta", items: [], suggestions: [0, 1], answer: "La *Dell* trae 1TB SSD por $899.00" });
      assert.match((await aiExtract("cual trae mas disco", context)).answer || "", /1TB/);
      (gemini as any).geminiJson = async () => ({ intent: "pregunta", items: [], suggestions: [], answer: "La Dell cuesta $799.00" });
      assert.equal((await aiExtract("precio dell", context)).answer, undefined);

      (gemini as any).geminiJson = async () => null;
      assert.equal((await aiExtract("hola", context)).source, "heuristic");
    } finally {
      (gemini as any).geminiJson = original;
    }
  });

  await test("pregunta respondida por IA muestra opciones numeradas", async () => {
    const fake = fakeDeps();
    fake.deps.extract = async () => ({ intent: "pregunta", items: [], remove: [], searchQuery: "", suggestions: ["p2", "p1"], answer: "Para diseño te recomiendo la *Dell i7* por su 1TB SSD.", source: "ai" });
    const result = (await conversation(fake, ["cual me sirve para diseño"]))[0];
    assert.equal(result.decision, "R8:pregunta_con_opciones");
    assert.match(result.reply, /Para diseño[\s\S]*\*1\.\* Laptop Dell/);
    assert.equal(result.state.options[0].productId, "p2");
  });

  await test("/brain solo devuelve las 5 rutas que tienen flujo en BuilderBot", () => {
    const messages = ["hola", "catálogo", "asesor", "mi pedido", "MP-12", "eres un bot?", "hazme la tarea", ""];
    for (const message of messages) {
      for (const stage of ["idle", "confirm", "ordered"] as const) {
        for (const paymentMethod of ["card", "transfer", null] as const) {
          const route = decideRoute({ ...createInitialState(), stage, paymentMethod }, { message, mediaUrl: message ? undefined : "https://x/f.jpg" }, { bank: false, cardEnabled: false }).route;
          assert.ok(["conversation", "catalog", "checkoutCard", "checkoutTransfer", "human"].includes(route), `${message} → ${route}`);
        }
      }
    }
  });

  await test("/brain decide la ruta sin tocar el pedido", () => {
    const on = { bank: true, cardEnabled: true };
    const confirmCard = { ...createInitialState(), stage: "confirm" as const, paymentMethod: "card" as const, cart: [{ productId: "p1", name: "HP", price: 649, quantity: 1 }] };
    assert.equal(decideRoute(null, { message: "hola" }, on).route, "conversation");
    assert.equal(decideRoute(null, { message: "quiero ver el catálogo" }, on).route, "catalog");
    assert.equal(decideRoute(null, { message: "quiero hablar con un asesor" }, on).route, "human");
    assert.equal(decideRoute(null, { message: "cuál es el estado de mi pedido" }, on).route, "conversation");
    assert.equal(decideRoute(null, { message: "", mediaUrl: "https://x/y.jpg" }, on).route, "checkoutTransfer");
    assert.equal(decideRoute(null, { message: "", mediaEvent: true }, on).route, "checkoutTransfer");
    assert.equal(decideRoute(confirmCard, { message: "sí" }, on).route, "checkoutCard");
    assert.equal(decideRoute({ ...confirmCard, paymentMethod: "transfer" }, { message: "dale" }, on).route, "checkoutTransfer");
    assert.equal(decideRoute({ ...confirmCard, paymentMethod: "transfer" }, { message: "si" }, { bank: false, cardEnabled: true }).route, "conversation");
    assert.equal(decideRoute(confirmCard, { message: "no, cambia el correo" }, on).route, "conversation");
    const before = JSON.stringify(confirmCard);
    decideRoute(confirmCard, { message: "sí" }, on);
    assert.equal(JSON.stringify(confirmCard), before, "no modifica el estado");
  });

  await test("lo que decide /brain coincide con lo que responde el flujo destino", async () => {
    for (const [method, expected] of [["tarjeta", "checkoutCard"], ["transferencia", "checkoutTransfer"]] as const) {
      const fake = fakeDeps();
      const results = await conversation(fake, ["monitor", "1", "Eva Ruiz", "eva@mail.com", "Quito", method]);
      const state = results.at(-1)!.state;
      assert.equal(decideRoute(state, { message: "si" }, { bank: true, cardEnabled: true }).route, expected);
      const turn = await handleTurn(state, { message: "si" }, fake.deps);
      assert.equal(turn.route, expected);
    }
  });

  await test("voz con IA: varía el texto pero conserva los datos exactos", async () => {
    const draft = "Listo, tu pedido *MP-00012* ya está registrado 🎉\n\nTransfiere *$190.00* a esta cuenta 👇\n🏦 *Produbanco*\nN.º *12040641835*\n\nMándame la foto del comprobante 📸";
    const original = gemini.geminiJson;
    try {
      const good = "Ya quedó tu pedido *MP-00012* 🥳\n\nTransfiere *$190.00* a esta cuenta 👇\n🏦 *Produbanco*\nN.º *12040641835*\n\nCuando transfieras, pásame la foto del comprobante 📸💙";
      (gemini as any).geminiJson = async () => ({ message: good });
      assert.equal(await naturalize(draft, []), good);
      // Cambia el número de pedido en el texto libre: se descarta.
      (gemini as any).geminiJson = async () => ({ message: good.replace("MP-00012", "MP-00013") });
      assert.equal(await naturalize(draft, []), draft);
      // Cambia un número de cuenta: se descarta y sale el borrador.
      (gemini as any).geminiJson = async () => ({ message: good.replace("12040641835", "12040641836") });
      assert.equal(await naturalize(draft, []), draft);
      // Inventa un texto larguísimo: se descarta.
      (gemini as any).geminiJson = async () => ({ message: `${good}\n${"bla ".repeat(400)}` });
      assert.equal(await naturalize(draft, []), draft);
      // Mete signos de apertura: se limpian.
      (gemini as any).geminiJson = async () => ({ message: `¡Ya quedó! ${good}` });
      assert.doesNotMatch(await naturalize(draft, []), /[¿¡]/);
      // IA caída: borrador.
      (gemini as any).geminiJson = async () => null;
      assert.equal(await naturalize(draft, []), draft);
    } finally {
      (gemini as any).geminiJson = original;
    }
    assert.equal(keepsData("Y tu correo? 📧", "Me pasas tu correo? 😊"), true, "sin datos, puede cambiar todo");
    assert.equal(keepsData("Escríbeme *retiro* si lo recoges", "Si lo recoges, escribe retiro"), false, "conserva las palabras en negrita");
    assert.equal(keepsData("Soy *Mila* 🤖, tu agente de *Megaprinter* ✨", "Hola! Soy *Mila* de *Megaprinter* 😊"), false, "mantiene la presentación de agente");
    assert.equal(keepsData("Soy *Mila* 🤖, tu agente de *Megaprinter* ✨ Pídeme lo que necesites, te ayudo siempre", "Holi! Soy *Mila* 🤖, tu agente en *Megaprinter* 💙 Pídeme lo que necesites, siempre te ayudo"), true);
  });

  await test("formato de la IA: viñetas con * no rompen las negritas", () => {
    assert.equal(cleanAnswer("*La *Lenovo* por *$870.00*."), "• La *Lenovo* por *$870.00*.");
    assert.equal(cleanAnswer("* Opción *HP*"), "• Opción *HP*");
    assert.equal(cleanAnswer("Te conviene *16 GB* de RAM."), "Te conviene *16 GB* de RAM.");
    assert.equal(cleanAnswer("precio *raro"), "precio raro");
  });

  await test("respuesta de IA con precio inventado se descarta", () => {
    assert.equal(answerPricesAreReal("La HP cuesta *$649.00* y la Dell $899.00", CATALOG), true);
    assert.equal(answerPricesAreReal("La HP cuesta $599.00", CATALOG), false);
    assert.equal(answerPricesAreReal("Sin precios", CATALOG), true);
  });

  await test("helpers de BuilderBot: teléfono, historial y URL del archivo", () => {
    assert.equal(toE164("593991234567:12@s.whatsapp.net"), "+593991234567");
    assert.equal(toE164("0991234567"), "+593991234567");
    assert.equal(toE164("{from}"), "");
    assert.equal(toE164("12345@lid"), "lid:12345");
    assert.ok(phoneVariants("+593991234567").includes("0991234567"));
    assert.equal(latestUserMessage('[{"role":"user","content":"hola"},{"role":"assistant","content":"¿qué buscas?"},{"role":"user","content":"laptop"}]'), "laptop");
    assert.equal(latestUserMessage("user: hola\nassistant: dime\nuser: impresora"), "impresora");
    assert.equal(readMediaUrl({ urlTempFile: "https://tmp.builderbot/x.jpg" }), "https://tmp.builderbot/x.jpg");
    assert.equal(readMediaUrl({ urlTempFile: "{urlTempFile}" }), "");
  });

  await test("detectores: elección, cantidad y forma de pago", () => {
    assert.equal(extractChoice("la 2", 3), 2);
    assert.equal(extractChoice("el primero", 3), 1);
    assert.equal(extractChoice("7", 3), null);
    assert.equal(extractQuantity("core i5 8 gb"), null);
    assert.equal(extractQuantity("2 laptops"), 2);
    assert.equal(detectPaymentMethod("envíenme a Guayaquil"), null);
    assert.equal(detectPaymentMethod("hago un depósito"), "transfer");
    assert.equal(detectPaymentMethod("con tarjeta de crédito"), "card");
  });

  console.log(`\n${passed} ok, ${failed} fallaron`);
  if (failed) process.exit(1);
}

main();
