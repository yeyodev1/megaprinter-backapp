import { Schema, model } from "mongoose";

/**
 * Revision de UN chat al momento: cuando Mila no entiende, el cliente repite o
 * el chat pasa a un asesor, la IA revisa esa conversacion y saca lecciones sin
 * esperar al cron de la mañana. Se ve en vivo en Sistema → Aprendizaje.
 */
const botChatReviewSchema = new Schema(
  {
    phone: { type: String, required: true, index: true },
    // Que la disparo: no_entendio | repitio | asesor.
    trigger: { type: String, default: "" },
    summary: { type: String, default: "" },
    added: [{ kind: String, text: String, status: String, reason: String }],
    error: { type: String, default: "" },
  },
  { timestamps: true },
);

export const BotChatReviewModel = model("BotChatReview", botChatReviewSchema);
