import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";

type InventoryPayload = {
  productId: string;
  stock: number;
  onlineAvailable?: boolean;
};

let io: Server | null = null;

export function setupRealtime(server: HttpServer, frontendUrl: string) {
  io = new Server(server, {
    cors: {
      origin: [frontendUrl, "http://localhost:5173"],
      credentials: true
    }
  });

  io.on("connection", (socket) => {
    socket.join("inventory");
    socket.join("orders");
  });

  return io;
}

export function emitInventoryUpdated(payload: InventoryPayload | InventoryPayload[]) {
  io?.to("inventory").emit("inventory:updated", payload);
}

export function emitProductUpdated(productId: string) {
  io?.to("inventory").emit("product:updated", { productId });
}

export function emitOrderCreated(orderId: string) {
  io?.to("orders").emit("order:created", { orderId });
}

export function emitOrderStatusUpdated(orderId: string, status: string) {
  io?.to("orders").emit("order:status-updated", { orderId, status });
}
