import { Schema, model } from "mongoose";

/**
 * Conversacion del bot de WhatsApp por telefono. El estado del pedido vive
 * aqui (no en el `{history}` de BuilderBot): asi el backend decide cada paso.
 */
const whatsappSessionSchema = new Schema(
  {
    phone: { type: String, required: true, unique: true },
    state: { type: Schema.Types.Mixed, default: null },
    history: [
      {
        _id: false,
        role: { type: String, enum: ["user", "assistant"] },
        content: String,
        createdAt: { type: Date, default: Date.now },
      },
    ],
    // Reintentos de BuilderBot: mismo mensaje en menos de 5 s recibe la misma respuesta.
    lastMessageHash: { type: String, default: "" },
    lastMessageAt: { type: Date },
    lastResponse: { type: Schema.Types.Mixed, default: null },
    // Candado por telefono: dos burbujas seguidas se procesan en orden.
    turnLockUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

// La conversacion se olvida tras 3 dias sin mensajes. Los pedidos quedan en
// Order y se encuentran por telefono.
whatsappSessionSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });

export const WhatsAppSessionModel = model("WhatsAppSession", whatsappSessionSchema);
