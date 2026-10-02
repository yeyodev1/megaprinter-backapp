import crypto from "crypto";
import { InferSchemaType, Schema, model } from "mongoose";
import { nextSequence } from "./counter.model";

export const ORDER_STATUSES = [
  "pending", // pago iniciado (Payphone o transferencia), sin confirmar
  "whatsapp", // solicitud enviada por WhatsApp, por contactar
  "paid", // pago aprobado
  "processing", // en preparacion
  "delivered", // entregado al cliente
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Metodo de pago (campo `source` por compatibilidad con los pedidos viejos). */
export const ORDER_SOURCES = ["payphone", "whatsapp", "transfer"] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

/** Por donde entro el pedido: la tienda web o el bot de WhatsApp. */
export const ORDER_CHANNELS = ["web", "whatsapp_bot"] as const;

/**
 * Estado del comprobante de una transferencia:
 * - awaiting_receipt: el cliente aun no manda el comprobante.
 * - in_review: llego un comprobante y el equipo debe revisarlo en el panel.
 * - approved / rejected: decision del equipo. Nunca la toma la IA sola.
 */
export const TRANSFER_STATUSES = ["awaiting_receipt", "in_review", "approved", "rejected"] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

const receiptSchema = new Schema(
  {
    url: { type: String, required: true },
    receivedAt: { type: Date, default: Date.now },
    via: { type: String, enum: ["whatsapp", "web"], default: "whatsapp" },
    // Lectura de la IA: solo orienta al equipo, no aprueba nada.
    analysis: {
      isReceipt: { type: Boolean, default: null },
      amountMatches: { type: Boolean, default: null },
      accountMatches: { type: Boolean, default: null },
      detectedAmount: { type: Number, default: null },
      detectedBank: { type: String, default: "" },
      detectedReference: { type: String, default: "" },
      summary: { type: String, default: "" },
    },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    // Numero legible para el cliente ("MP-00042"). Los pedidos anteriores a
    // este campo no lo tienen y el panel muestra su _id.
    orderNumber: { type: String, index: { unique: true, sparse: true } },
    customerName: { type: String, required: true, trim: true },
    customerEmail: { type: String, required: true, trim: true, lowercase: true },
    customerPhone: { type: String, required: true, trim: true },
    address: { type: String, default: "", trim: true },
    items: [{ name: String, price: Number, quantity: Number }],
    totalAmount: { type: Number, required: true, min: 0 },
    source: { type: String, enum: ORDER_SOURCES, required: true },
    channel: { type: String, enum: ORDER_CHANNELS, default: "web" },
    // Telefono E.164 del chat de WhatsApp que creo el pedido.
    whatsappPhone: { type: String, default: "", index: true },
    // Ciclo de vida del pedido. `pending`/`whatsapp` son los estados iniciales
    // segun el origen; el resto los asigna el equipo desde el panel.
    status: { type: String, enum: ORDER_STATUSES, default: "pending" },
    clientTransactionId: { type: String, default: "", index: true },
    // Intentos anteriores: cada vez que se abre el link de pago hay uno nuevo y
    // el cliente pudo pagar en uno viejo.
    clientTransactionIds: { type: [String], default: undefined, index: true },
    payphoneTransactionId: { type: Number },
    // Llave secreta del enlace de pago (/pagar/:token). No es el _id para que
    // nadie pueda abrir pedidos ajenos probando ids.
    paymentToken: {
      type: String,
      default: () => crypto.randomBytes(18).toString("base64url"),
      index: { unique: true, sparse: true },
    },
    transfer: {
      status: { type: String, enum: TRANSFER_STATUSES },
      // Cuenta que eligio el cliente (copia: si luego se edita en el panel, el pedido conserva la suya).
      account: {
        id: { type: String },
        bankCode: { type: String },
        bank: { type: String },
        accountType: { type: String },
        accountNumber: { type: String },
        accountHolder: { type: String },
        holderId: { type: String },
        logoUrl: { type: String },
      },
      receipts: { type: [receiptSchema], default: undefined },
      reviewedBy: { type: String },
      reviewedAt: { type: Date },
      note: { type: String },
    },
  },
  { timestamps: true },
);

orderSchema.pre("validate", async function assignOrderNumber() {
  if (this.isNew && !this.orderNumber) {
    this.orderNumber = `MP-${String(await nextSequence("order")).padStart(5, "0")}`;
  }
});

export type Order = InferSchemaType<typeof orderSchema>;
export const OrderModel = model("Order", orderSchema);
