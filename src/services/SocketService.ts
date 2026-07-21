import { Server as SocketIOServer, Socket } from "socket.io";
import { Server } from "http";
import { logger, setLogBroadcaster } from "@/infra/logger";
import { verifyJWT } from "@/auth/jwt";
import type { PortalRequestEvent } from "@/services/RequestMetrics";

interface Device {
  id: string;
  socketId: string;
  name: string;
  type: "receiver" | "controller";
  ip: string;
}

class SocketService {
  private io: SocketIOServer | null = null;
  private devices: Map<string, Device> = new Map();

  public init(httpServer: Server) {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : false,
        methods: ["GET", "POST"],
      },
    });

    setLogBroadcaster((level, message, timestamp) => {
      this.broadcastLog(level, message, timestamp);
    });

    this.io.on("connection", (socket: Socket) => {
      logger.info(`[Socket] New connection: ${socket.id}`);

      socket.on(
        "register",
        (data: {
          id: string;
          name: string;
          type: "receiver" | "controller";
        }) => {
          for (const [sId, dev] of this.devices.entries()) {
            if (dev.id === data.id) {
              this.devices.delete(sId);
            }
          }

          const device: Device = {
            id: data.id,
            socketId: socket.id,
            name: data.name,
            type: data.type,
            ip: socket.handshake.address,
          };

          this.devices.set(socket.id, device);
          this.broadcastReceivers();
          this.broadcastActiveUserCount();
        },
      );

      socket.on("get_receivers", () => {
        socket.emit("receivers_list", this.getReceivers());
      });

      socket.on(
        "cast_command",
        (data: { targetDeviceId: string; command: string; payload: any }) => {
          const targetSocketId = this.findSocketIdByDeviceId(
            data.targetDeviceId,
          );
          if (targetSocketId) {
            logger.info(
              `[Socket] Forwarding command '${data.command}' to ${data.targetDeviceId}`,
            );
            this.io?.to(targetSocketId).emit("receive_cast_command", {
              command: data.command,
              payload: data.payload,
              from: this.devices.get(socket.id)?.name || "Unknown Controller",
            });
          } else {
            logger.warn(
              `[Socket] Target device ${data.targetDeviceId} not found`,
            );
          }
        },
      );

      socket.on("get_active_devices", () => {
        socket.emit("active_devices_list", Array.from(this.devices.values()));
      });

      socket.on("disconnect", () => {
        const device = this.devices.get(socket.id);
        if (device) {
          logger.info(`[Socket] Device disconnected: ${device.name}`);
          this.devices.delete(socket.id);
          if (device.type === "receiver") {
            this.broadcastReceivers();
          }
          this.broadcastActiveUserCount();
        }
      });

      // Live server logs and portal-request events are admin-only — anyone who can
      // open a socket connection (device pairing/casting doesn't require auth) could
      // otherwise subscribe to either just by knowing the event name. Require the
      // same admin JWT the REST admin endpoints already check, passed in the event
      // payload rather than gating the whole connection (regular receiver/controller
      // casting has no admin token and must keep working unauthenticated).
      socket.on("start_logging", (payload?: { token?: string }) => {
        if (!this.isAdminToken(payload?.token)) return;
        socket.join("logging");
      });

      socket.on("stop_logging", () => {
        socket.leave("logging");
      });

      socket.on("start_portal_metrics", (payload?: { token?: string }) => {
        if (!this.isAdminToken(payload?.token)) return;
        socket.join("portal-metrics");
      });

      socket.on("stop_portal_metrics", () => {
        socket.leave("portal-metrics");
      });
    });

    logger.info("[Socket] Service initialized");
  }

  private isAdminToken(token: string | undefined): boolean {
    if (!token) return false;
    const payload = verifyJWT(token);
    return !!payload && payload.role === "admin";
  }

  private getReceivers(): Device[] {
    return Array.from(this.devices.values()).filter(
      (d) => d.type === "receiver",
    );
  }

  private findSocketIdByDeviceId(deviceId: string): string | undefined {
    for (const [socketId, device] of this.devices.entries()) {
      if (device.id === deviceId) return socketId;
    }
    return undefined;
  }

  private broadcastReceivers() {
    const receivers = this.getReceivers();
    this.io?.emit("receivers_updated", receivers);
  }

  private broadcastActiveUserCount() {
    const count = this.devices.size;
    const list = Array.from(this.devices.values());
    this.io?.emit("active_user_count", count);
    this.io?.emit("active_devices_updated", list);
  }

  public broadcastLog(level: string, message: string, timestamp: string) {
    this.io?.to("logging").emit("server_log", { level, message, timestamp });
  }

  public broadcastConfigChange(hash: string) {
    this.io?.emit("config_changed", { timestamp: Date.now(), hash });
  }

  public broadcastPortalRequest(event: PortalRequestEvent) {
    this.io?.to("portal-metrics").emit("portal_request", event);
  }

  public getActiveDeviceCount(): number {
    return this.devices.size;
  }
}

export const socketService = new SocketService();
