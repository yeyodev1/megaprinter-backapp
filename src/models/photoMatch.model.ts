import { Schema, model } from "mongoose";

/**
 * Fotos de productos que mandan los clientes y lo que la IA reconocio. Asi
 * aprende la vista: cuando el cliente elige un producto de la lista que salio
 * de su foto queda "confirmada"; cuando el equipo dice cual era en el panel
 * (Sistema → Aprendizaje) queda "corregida". Las dos se usan como ejemplos en
 * el prompt de la siguiente foto.
 */
const photoMatchSchema = new Schema(
  {
    phone: { type: String, default: "", index: true },
    // Copia en Cloudinary (la URL temporal de BuilderBot vence).
    imageUrl: { type: String, default: "" },
    description: { type: String, default: "", trim: true },
    searchQuery: { type: String, default: "", trim: true },
    // Lo que propuso la IA, del mas al menos parecido.
    suggestedIds: [{ type: Schema.Types.ObjectId, ref: "Product" }],
    exactMatch: { type: Boolean, default: false },
    // El producto correcto (lo eligio el cliente o lo dijo el equipo). null = no esta en el catalogo.
    productId: { type: Schema.Types.ObjectId, ref: "Product", default: null },
    status: { type: String, enum: ["sugerida", "confirmada", "corregida", "descartada"], default: "sugerida", index: true },
    confirmedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

export const PhotoMatchModel = model("PhotoMatch", photoMatchSchema);
