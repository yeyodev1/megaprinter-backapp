import { InferSchemaType, Schema, model } from "mongoose";

const categorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    slug: { type: String, required: true, trim: true, unique: true, lowercase: true },
  },
  { timestamps: true }
);

export type Category = InferSchemaType<typeof categorySchema>;
export const CategoryModel = model("Category", categorySchema);
