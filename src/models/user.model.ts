import { InferSchemaType, Schema, model } from "mongoose";

export const USER_ROLES = ["admin", "tecnico"] as const;
export type UserRole = (typeof USER_ROLES)[number];

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    // Obligatorio para admins; un tecnico puede entrar solo con WhatsApp o cedula.
    email: { type: String, trim: true, lowercase: true },
    // WhatsApp normalizado (+5939XXXXXXXX) y cedula sin espacios: ver utils/identity.
    phone: { type: String, trim: true },
    cedula: { type: String, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: USER_ROLES, default: "admin" },
    // Desactivar corta el acceso de inmediato sin borrar su historial en los tickets.
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Unicos solo cuando existen: varios tecnicos pueden no tener correo. Nombres
// propios para no chocar con el indice viejo `email_1` (ver migrateUserIndexes).
for (const field of ["email", "phone", "cedula"]) {
  userSchema.index(
    { [field]: 1 },
    { unique: true, name: `${field}_unique_if_set`, partialFilterExpression: { [field]: { $type: "string" } } }
  );
}

export type InternalUser = InferSchemaType<typeof userSchema>;
export const UserModel = model("InternalUser", userSchema);

/**
 * El indice original `email_1` era unico sin ser parcial: trata "sin correo"
 * como null y solo dejaria crear un tecnico sin correo. Se elimina una vez y se
 * crean los indices parciales. Idempotente: si ya se migro no hace nada.
 */
export async function migrateUserIndexes() {
  try {
    const indexes = await UserModel.collection.indexes();
    const legacy = indexes.find((index) => index.name === "email_1" && !index.partialFilterExpression);
    if (legacy) {
      await UserModel.collection.dropIndex("email_1");
      console.log("[usuarios] índice email_1 reemplazado por índices parciales");
    }
    await UserModel.createIndexes();
  } catch (error) {
    console.warn(`[usuarios] no se pudieron revisar los índices: ${error instanceof Error ? error.message : error}`);
  }
}
