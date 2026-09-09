import { InferSchemaType, Schema, model } from "mongoose";

export const ORDER_STATUSES = [
  "pending", // pago iniciado en Payphone, sin confirmar
  "whatsapp", // solicitud enviada por WhatsApp, por contactar
  "paid", // pago aprobado
  "processing", // en preparacion
  "delivered", // entregado al cliente
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

const orderSchema = new Schema(
  {
    customerName: { type: String, required: true, trim: true },
    customerEmail: { type: String, required: true, trim: true, lowercase: true },
    customerPhone: { type: String, required: true, trim: true },
    address: { type: String, default: "", trim: true },
    items: [{ name: String, price: Number, quantity: Number }],
    totalAmount: { type: Number, required: true, min: 0 },
    source: { type: String, enum: ["payphone", "whatsapp"], required: true },
    // Ciclo de vida del pedido. `pending`/`whatsapp` son los estados iniciales
    // segun el origen; el resto los asigna el equipo desde el panel.
    status: { type: String, enum: ORDER_STATUSES, default: "pending" },
    clientTransactionId: { type: String, default: "", index: true },
    payphoneTransactionId: { type: Number },
  },
  { timestamps: true }
);

export type Order = InferSchemaType<typeof orderSchema>;
export const OrderModel = model("Order", orderSchema);
