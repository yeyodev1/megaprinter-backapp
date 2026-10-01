import { Schema, model } from "mongoose";

/**
 * Bitacora del bot de WhatsApp: una fila por llamada de BuilderBot. Sirve al
 * panel (/admin/bot) para ver en todo momento que decidio /brain, a que flujo
 * fue, que respondio cada endpoint, cuanto tardo y que fallo.
 */
const botEventSchema = new Schema(
  {
    phone: { type: String, required: true, index: true },
    // Endpoint que atendio: brain, conversation, checkout, search-order, human, catalog, media.
    endpoint: { type: String, required: true },
    kind: { type: String, enum: ["decision", "turn", "error"], required: true },
    route: { type: String, default: "" },
    decision: { type: String, default: "" },
    intent: { type: String, default: "" },
    step: { type: String, default: "" },
    message: { type: String, default: "" },
    reply: { type: String, default: "" },
    mediaUrl: { type: String, default: "" },
    orderNumber: { type: String, default: "" },
    duplicated: { type: Boolean, default: false },
    error: { type: String, default: "" },
    durationMs: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

botEventSchema.index({ phone: 1, createdAt: -1 });
// Se conserva 30 dias (este indice tambien sirve para ordenar por fecha).
botEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60, name: "ttl_30d" });

export const BotEventModel = model("BotEvent", botEventSchema);
