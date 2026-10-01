import { Schema, model } from "mongoose";

/**
 * Configuracion de pagos de la tienda (documento unico, _id "payments").
 * El equipo la edita desde el panel: activar transferencias y la cuenta.
 */
const paymentSettingsSchema = new Schema(
  {
    _id: { type: String, default: "payments" },
    transfer: {
      enabled: { type: Boolean, default: false },
      bank: { type: String, default: "", trim: true },
      accountType: { type: String, default: "", trim: true },
      accountNumber: { type: String, default: "", trim: true },
      accountHolder: { type: String, default: "", trim: true },
      holderId: { type: String, default: "", trim: true },
    },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

export const PaymentSettingsModel = model("PaymentSettings", paymentSettingsSchema);
