import mongoose from "mongoose";
import { env } from "../config/env.js";

let connecting: Promise<typeof mongoose> | null = null;

export async function connectMongo(uri: string = env.MONGODB_URI): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (!connecting) {
    connecting = mongoose.connect(uri).then((m) => {
      return m;
    });
    connecting.catch(() => {
      connecting = null;
    });
  }
  return connecting;
}

export async function disconnectMongo(): Promise<void> {
  connecting = null;
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}
