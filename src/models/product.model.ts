import { InferSchemaType, Schema, model } from "mongoose";

const productSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    imageUrl: { type: String, default: "", trim: true },
    specifications: [
      {
        label: { type: String, required: true, trim: true },
        value: { type: String, required: true, trim: true },
      },
    ],
    category: { type: Schema.Types.ObjectId, ref: "Category", required: true },
    kind: { type: String, enum: ["product", "service"], default: "product" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// La consulta publica del catalogo filtra por `active` + `kind` y ordena por
// `createdAt`; sin indice cada visita a la tienda hacia un COLLSCAN.
productSchema.index({ active: 1, kind: 1, createdAt: -1 });
productSchema.index({ category: 1 });

export type Product = InferSchemaType<typeof productSchema>;
export const ProductModel = model("Product", productSchema);
