import { Schema, model } from "mongoose";

const accountSchema = new Schema({
  // Codigo de banco conocido (pichincha, guayaquil...) u "otro".
  bankCode: { type: String, default: "otro", trim: true },
  bank: { type: String, required: true, trim: true },
  accountType: { type: String, default: "", trim: true },
  accountNumber: { type: String, required: true, trim: true },
  accountHolder: { type: String, default: "", trim: true },
  holderId: { type: String, default: "", trim: true },
  logoUrl: { type: String, default: "", trim: true },
  active: { type: Boolean, default: true },
});

/**
 * Configuracion de pagos de la tienda (documento unico, _id "payments").
 * El equipo la edita desde el panel: activar transferencias y sus cuentas.
 */
const paymentSettingsSchema = new Schema(
  {
    _id: { type: String, default: "payments" },
    transfer: {
      enabled: { type: Boolean, default: false },
      accounts: { type: [accountSchema], default: [] },
      // Formato anterior (una sola cuenta): se migra a `accounts` al leer.
      bank: { type: String },
      accountType: { type: String },
      accountNumber: { type: String },
      accountHolder: { type: String },
      holderId: { type: String },
    },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

export const PaymentSettingsModel = model("PaymentSettings", paymentSettingsSchema);
