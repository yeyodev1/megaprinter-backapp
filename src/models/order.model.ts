import { InferSchemaType, Schema, model } from "mongoose";

const orderSchema = new Schema(
  {
    customerName: { type: String, required: true, trim: true },
    customerEmail: { type: String, required: true, trim: true, lowercase: true },
    customerPhone: { type: String, required: true, trim: true },
    address: { type: String, default: "", trim: true },
    items: [{ name: String, price: Number, quantity: Number }],
    totalAmount: { type: Number, required: true, min: 0 },
    source: { type: String, enum: ["payphone", "whatsapp"], required: true },
    status: { type: String, enum: ["pending", "paid", "cancelled", "whatsapp"], default: "pending" },
    clientTransactionId: { type: String, default: "", index: true },
    payphoneTransactionId: { type: Number },
  },
  { timestamps: true }
);

export type Order = InferSchemaType<typeof orderSchema>;
export const OrderModel = model("Order", orderSchema);
