import { Schema, model } from "mongoose";
import { nextSequence } from "./counter.model";

export const TICKET_TYPES = ["servicio_tecnico", "suministros"] as const;
export const TICKET_STATUSES = ["atencion", "nuevo", "en_revision", "cotizado", "en_reparacion", "listo", "entregado", "cancelado"] as const;

/** Solicitud de servicio tecnico o de suministros: la atiende una persona. */
const serviceTicketSchema = new Schema(
  {
    ticketNumber: { type: String, index: { unique: true, sparse: true } },
    type: { type: String, enum: TICKET_TYPES, required: true },
    status: { type: String, enum: TICKET_STATUSES, default: "nuevo" },
    channel: { type: String, enum: ["whatsapp_bot", "web", "panel"], default: "whatsapp_bot" },
    customerName: { type: String, default: "", trim: true },
    customerPhone: { type: String, default: "", trim: true },
    customerEmail: { type: String, default: "", trim: true, lowercase: true },
    // Telefono de la sesion del bot (con LID el customerPhone dice "numero oculto").
    chatPhone: { type: String, default: "" },
    // Equipo (impresora, laptop, pc, monitor, camara) y lo que le pasa, con las palabras del cliente.
    device: { type: String, default: "" },
    issue: { type: String, default: "" },
    // Categoria detectada y precio sugerido (rango en USD) que se le mostro al cliente.
    category: { type: String, default: "" },
    priceMin: { type: Number, default: null },
    priceMax: { type: Number, default: null },
    priceSource: { type: String, enum: ["catalogo", "referencial", "por_cotizar"], default: "por_cotizar" },
    // Resumen con IA de la conversacion: que busca, que quiere y como se clasifica.
    // "no_claro" o needsAttention mandan el ticket a la columna "Necesita atencion".
    summary: {
      text: { type: String, default: "" },
      wants: { type: String, default: "" },
      classification: { type: String, enum: ["servicio_tecnico", "suministros", "compra", "seguimiento", "no_claro", ""], default: "" },
      needsAttention: { type: Boolean, default: false },
      reason: { type: String, default: "" },
      at: { type: Date, default: null },
    },
    // Lo que define el equipo despues del diagnostico.
    finalPrice: { type: Number, default: null },
    assignedTo: { type: String, default: "" },
    notes: [{ _id: false, text: String, by: String, at: { type: Date, default: Date.now } }],
    statusHistory: [{ _id: false, status: String, by: String, at: { type: Date, default: Date.now } }],
  },
  { timestamps: true },
);

serviceTicketSchema.index({ status: 1, createdAt: -1 });

serviceTicketSchema.pre("validate", async function assignNumber() {
  if (this.isNew && !this.ticketNumber) {
    this.ticketNumber = `ST-${String(await nextSequence("ticket")).padStart(5, "0")}`;
  }
});

export const ServiceTicketModel = model("ServiceTicket", serviceTicketSchema);
