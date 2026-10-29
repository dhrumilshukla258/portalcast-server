import pino from "pino";
import pretty from "pino-pretty";

let broadcastLogFn:
  | ((level: string, message: string, timestamp: string) => void)
  | null = null;

export const setLogBroadcaster = (
  fn: (level: string, message: string, timestamp: string) => void,
) => {
  broadcastLogFn = fn;
};

// Pretty lines written in this thread, not a transport worker: a worker loads pino-pretty
// from node_modules by name, and the packaged server bundles its dependencies into one file
// (tsup.config.ts) instead of shipping thousands of node_modules files.
const pinoLogger = pino(
  { level: process.env.LOG_LEVEL || "info" },
  pretty({
    colorize: true,
    translateTime: "SYS:standard",
    ignore: "pid,hostname",
  }),
);

const logToSocket = (level: string, args: any[]) => {
  try {
    if (!broadcastLogFn) return;

    let message = "";
    if (args.length > 0) {
      if (typeof args[0] === "string") {
        message = args.join(" ");
      } else if (typeof args[0] === "object" && args[0] !== null) {
        if (args.length > 1 && typeof args[1] === "string") {
          message = args[1] + " " + JSON.stringify(args[0]);
        } else {
          message = JSON.stringify(args[0]);
        }
      } else {
        message = String(args[0]);
      }
    }
    broadcastLogFn(level, message, new Date().toISOString());
  } catch (err) {}
};

export const logger = new Proxy(pinoLogger, {
  get(target, prop, receiver) {
    if (
      typeof prop === "string" &&
      ["info", "warn", "error", "debug", "fatal"].includes(prop)
    ) {
      const original = target[prop as keyof typeof target];
      if (typeof original === "function") {
        return (...args: any[]) => {
          const result = (original as Function).apply(target, args);

          logToSocket(prop, args);
          return result;
        };
      }
    }
    return Reflect.get(target, prop, receiver);
  },
});
