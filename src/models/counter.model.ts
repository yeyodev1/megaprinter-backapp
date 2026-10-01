import { Schema, model } from "mongoose";

const counterSchema = new Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

export const CounterModel = model("Counter", counterSchema);

/** Siguiente numero de una secuencia (atomico: dos pedidos a la vez no repiten numero). */
export async function nextSequence(name: string) {
  const counter = await CounterModel.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return counter.seq;
}
