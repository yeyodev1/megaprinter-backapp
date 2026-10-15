import { Schema, model } from "mongoose";

/**
 * Una fila por dia revisado (_id "YYYY-MM-DD"): las metricas de ese dia para
 * ver si Mila mejora, el resumen de la IA y lo que propuso.
 */
const botLearningRunSchema = new Schema(
  {
    _id: { type: String, required: true },
    metrics: {
      conversations: { type: Number, default: 0 },
      messages: { type: Number, default: 0 },
      notUnderstood: { type: Number, default: 0 },
      handoffs: { type: Number, default: 0 },
      orders: { type: Number, default: 0 },
      tickets: { type: Number, default: 0 },
      repeated: { type: Number, default: 0 },
    },
    summary: { type: String, default: "" },
    devSuggestions: { type: [String], default: [] },
    lessonsActive: { type: Number, default: 0 },
    lessonsPending: { type: Number, default: 0 },
    analyzed: { type: Boolean, default: false },
    error: { type: String, default: "" },
  },
  { timestamps: true },
);

export const BotLearningRunModel = model("BotLearningRun", botLearningRunSchema);
