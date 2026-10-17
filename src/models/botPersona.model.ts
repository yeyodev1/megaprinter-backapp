import { Schema, model } from "mongoose";

/**
 * Personalidad de Mila editable desde el panel (Sistema → Aprendizaje, solo
 * admin). Un solo documento (_id "persona"). Entra en el prompt del extractor
 * y en el de la voz; las reglas fijas del router (precios, pasos del pedido,
 * reglas de Meta) siguen mandando.
 */
const botPersonaSchema = new Schema(
  {
    _id: { type: String, default: "persona" },
    // Tono y forma de ser ("cercana, tutea, emojis con medida…").
    personality: { type: String, default: "", trim: true },
    // Lo que Mila siempre debe decir o hacer.
    alwaysSay: [{ type: String, trim: true }],
    // Lo que Mila nunca debe decir.
    neverSay: [{ type: String, trim: true }],
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

export const BotPersonaModel = model("BotPersona", botPersonaSchema);
