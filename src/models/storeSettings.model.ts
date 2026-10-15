import { Schema, model } from "mongoose";

const branchSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    mapsUrl: { type: String, default: "", trim: true },
    hours: { type: [{ _id: false, days: { type: String, trim: true }, time: { type: String, trim: true } }], default: [] },
    active: { type: Boolean, default: true },
  },
  { _id: false },
);

/**
 * Sucursales de la tienda (documento unico, _id "store"). El equipo las edita
 * desde el panel (Sistema → Sucursales); el bot y la web las leen de aqui.
 */
const storeSettingsSchema = new Schema(
  {
    _id: { type: String, default: "store" },
    city: { type: String, default: "Guayaquil", trim: true },
    branches: { type: [branchSchema], default: [] },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

export const StoreSettingsModel = model("StoreSettings", storeSettingsSchema);
