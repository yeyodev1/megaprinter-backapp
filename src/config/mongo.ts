import mongoose from "mongoose";

/**
 * En un entorno serverless (Vercel) cada invocacion puede reutilizar el mismo
 * proceso Node. Sin esta cache, cada arranque en frio abria una conexion nueva
 * y Atlas terminaba rechazando conexiones por agotar el pool.
 */
let connection: Promise<typeof mongoose> | null = null;

export async function dbConnect() {
  const DB_URI = process.env.DB_URI;

  if (!DB_URI) {
    throw new Error("DB_URI is not defined in environment variables");
  }

  if (mongoose.connection.readyState === 1) return mongoose;

  if (!connection) {
    connection = mongoose
      .connect(DB_URI, {
        serverSelectionTimeoutMS: 10000,
        maxPoolSize: 10,
      })
      .then((instance) => {
        console.log("Connected to MongoDB");
        return instance;
      })
      .catch((error) => {
        // Se limpia la promesa fallida para que el siguiente intento reconecte
        // en vez de quedar cacheado el rechazo para siempre.
        connection = null;
        console.error("MongoDB connection error:", error);
        throw error;
      });
  }

  return connection;
}
