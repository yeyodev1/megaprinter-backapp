import { Schema, model } from "mongoose";

/** Alertas del panel: lo que el equipo tiene que ver o atender. */
export const ALERT_TYPES = [
  "order_new", // pedido nuevo (web o bot)
  "payment_confirmed", // pago confirmado: preparar el pedido
  "receipt_review", // comprobante de transferencia por revisar
  "ticket_new", // ticket de servicio tecnico o suministros
  "human_handoff", // un cliente pidio hablar con una persona
  "email_failed", // un correo no se pudo enviar
] as const;

const alertSchema = new Schema(
  {
    type: { type: String, enum: ALERT_TYPES, required: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    // Ruta del panel a la que lleva (ej. /admin/orders?search=MP-00012).
    link: { type: String, default: "" },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Se conservan 60 dias.
alertSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

export const AlertModel = model("Alert", alertSchema);
