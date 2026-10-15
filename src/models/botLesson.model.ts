import { Schema, model } from "mongoose";

/**
 * Aprendizajes del bot: lo que la revision diaria de chats (o el equipo desde
 * el panel, Sistema → Aprendizaje) le enseña a Mila. Los "activa" van en el
 * prompt del extractor; los "pendiente" esperan que alguien del equipo los
 * apruebe porque afirman algo del negocio; los "descartada" no se vuelven a proponer.
 */
const botLessonSchema = new Schema(
  {
    // frase: como lo dicen los clientes → que quieren. respuesta: como responder algo frecuente. evitar: algo que Mila hizo mal.
    kind: { type: String, enum: ["frase", "respuesta", "evitar"], required: true },
    text: { type: String, required: true, trim: true },
    example: { type: String, default: "", trim: true },
    status: { type: String, enum: ["activa", "pendiente", "descartada"], default: "pendiente", index: true },
    source: { type: String, enum: ["auto", "manual"], default: "auto" },
    // Dia de chats del que salio (YYYY-MM-DD, hora de Ecuador).
    learnedFrom: { type: String, default: "" },
    reason: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

export const BotLessonModel = model("BotLesson", botLessonSchema);
