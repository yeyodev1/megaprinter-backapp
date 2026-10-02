import axios from "axios";

/**
 * Pagos con tarjeta (Payphone): confirmar una transaccion y consultar su estado.
 *
 * Payphone exige la FASE DE CONFIRMACION: si el comercio no confirma la venta en
 * los 5 minutos siguientes al pago, la revierte sola. La web la hace cuando el
 * cliente vuelve a /pay-response; si el cliente cierra la pestaña y vuelve al
 * chat, la hace el bot cuando escribe "pagado" (settleCardPayment).
 */

const CONFIRM_URL = "https://paymentbox.payphonetodoesposible.com/api/confirm";
const SALE_URL = "https://pay.payphonetodoesposible.com/api/Sale/client";
export const PAYPHONE_APPROVED = 3;

const authHeaders = () => ({ Authorization: `Bearer ${process.env.PAYPHONE_TOKEN}`, "Content-Type": "application/json" });

export async function confirmPayphoneTransaction(id: number, clientTxId: string) {
  if (!process.env.PAYPHONE_TOKEN) throw new Error("Payphone no está configurado");
  const { data } = await axios.post(CONFIRM_URL, { id: Number(id), clientTxId }, { headers: authHeaders(), timeout: 20000 });
  return data;
}

export interface PayphoneSale {
  found: boolean;
  statusCode?: number;
  transactionStatus?: string;
  transactionId?: number;
  error?: string;
}

/** Estado de una venta por clientTransactionId. Nunca lanza: si algo falla, "no encontrada". */
export async function getPayphoneSale(clientTxId: string): Promise<PayphoneSale> {
  if (!process.env.PAYPHONE_TOKEN) return { found: false, error: "Payphone no está configurado" };
  try {
    const response = await axios.get(`${SALE_URL}/${encodeURIComponent(clientTxId)}`, {
      headers: authHeaders(),
      timeout: 8000,
      validateStatus: (status) => status < 500,
    });
    const data: any = Array.isArray(response.data) ? response.data[0] : response.data;
    if (response.status >= 400 || !data || typeof data !== "object" || data.errorCode !== undefined) {
      return { found: false, error: data?.message || `Payphone respondió ${response.status}` };
    }
    return {
      found: true,
      statusCode: Number(data.statusCode) || undefined,
      transactionStatus: data.transactionStatus,
      transactionId: Number(data.transactionId) || undefined,
    };
  } catch (error: any) {
    return { found: false, error: error?.message || "Payphone no respondió" };
  }
}

/** Que hacer con lo que dice la consulta, sin tocar la base. */
export function decideFromSale(sale: PayphoneSale): "pending" | "rejected" | "confirm" {
  if (!sale.found) return "pending";
  const declined = sale.statusCode === 2 || /cancel/i.test(sale.transactionStatus || "");
  if (declined && !sale.transactionId) return "rejected";
  if (!sale.transactionId) return "pending";
  const approved = sale.statusCode === PAYPHONE_APPROVED || sale.transactionStatus === "Approved";
  return approved ? "confirm" : "pending";
}

/**
 * Aplica la respuesta de la confirmacion al pedido. El monto se compara con el
 * del pedido: una transaccion de $1 no puede pagar un pedido de $1000.
 */
export async function applyPayphoneResult(order: any, data: any, clientTxId: string): Promise<"approved" | "mismatch" | "rejected"> {
  const approved = Number(data?.statusCode) === PAYPHONE_APPROVED;
  const confirmedAmount = Number(data?.amount);
  const expectedAmount = Math.round(order.totalAmount * 100);
  const amountMatches = !Number.isFinite(confirmedAmount) || confirmedAmount === expectedAmount;

  if (approved && !amountMatches) {
    console.error(`[payphone] monto no coincide para ${clientTxId}: esperado ${expectedAmount}, recibido ${confirmedAmount}`);
    if (order.status !== "pending") order.status = "pending";
    await order.save();
    return "mismatch";
  }
  order.status = approved ? "paid" : "cancelled";
  order.clientTransactionId = clientTxId;
  if (data?.transactionId) order.payphoneTransactionId = Number(data.transactionId);
  await order.save();
  return approved ? "approved" : "rejected";
}

export type CardSettlement = "already_paid" | "paid_now" | "pending" | "rejected" | "mismatch" | "not_applicable" | "error";

const PAID = ["paid", "processing", "delivered"];

/** Intentos de pago del pedido, del mas reciente al mas viejo, sin repetidos. */
export const paymentAttempts = (order: any): string[] =>
  [...new Set([order.clientTransactionId, ...[...(order.clientTransactionIds || [])].reverse()].filter(Boolean))] as string[];

/**
 * El cliente dice que ya pago: se pregunta a Payphone por cada intento y, si hay
 * uno aprobado, se confirma y el pedido queda Pagado. "Pendiente" o "no
 * encontrada" NO tocan el pedido (el cliente pudo no haber pagado todavia).
 */
export async function settleCardPayment(order: any): Promise<CardSettlement> {
  if (!order || order.source !== "payphone") return "not_applicable";
  if (PAID.includes(order.status)) return "already_paid";
  const attempts = paymentAttempts(order);
  if (!attempts.length) return "pending";

  let rejected = false;
  for (const clientTxId of attempts) {
    const sale = await getPayphoneSale(clientTxId);
    const decision = decideFromSale(sale);
    if (decision === "rejected") rejected = true;
    if (decision !== "confirm") continue;
    try {
      const data = await confirmPayphoneTransaction(sale.transactionId!, clientTxId);
      const result = await applyPayphoneResult(order, data, clientTxId);
      if (result === "approved") return "paid_now";
      if (result === "mismatch") return "mismatch";
      // La consulta decia aprobada y la confirmacion no: se deja pendiente, nunca cancelado desde el chat.
      if (order.status === "cancelled") {
        order.status = "pending";
        await order.save();
      }
      return "pending";
    } catch (error) {
      console.error(`[payphone] no se pudo confirmar ${clientTxId}:`, error instanceof Error ? error.message : error);
      return "error";
    }
  }
  return rejected ? "rejected" : "pending";
}
