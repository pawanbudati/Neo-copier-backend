import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const LOG_FILE = path.join(DATA_DIR, "app.log");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB

function ensureLogDirExists() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function rotateLogs() {
  try {
    ensureLogDirExists();
    if (!fs.existsSync(LOG_FILE)) return;

    const stats = fs.statSync(LOG_FILE);
    if (stats.size >= MAX_LOG_SIZE) {
      const backupFile = LOG_FILE + ".1";
      if (fs.existsSync(backupFile)) {
        try {
          fs.unlinkSync(backupFile);
        } catch (_) {}
      }
      fs.renameSync(LOG_FILE, backupFile);
    }
  } catch (err) {
    // Keep internal errors from crashing the console
    process.stderr.write(`[Logger Rotation Error] ${err}\n`);
  }
}

function formatArgs(args: any[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "object" && arg !== null) {
        try {
          if (arg instanceof Error) {
            return arg.stack || `${arg.name}: ${arg.message}`;
          }
          return JSON.stringify(arg);
        } catch (_) {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(" ");
}

function writeLog(level: "INFO" | "WARN" | "ERROR", message: string) {
  try {
    rotateLogs();
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, logLine, "utf8");
  } catch (err) {
    process.stderr.write(`[Logger Write Error] ${err}\n`);
  }
}

// Store original console methods
const originalLog = console.log;
const originalInfo = console.info;
const originalWarn = console.warn;
const originalError = console.error;

export function initializeLogger() {
  ensureLogDirExists();

  console.log = (...args: any[]) => {
    const formatted = formatArgs(args);
    originalLog.apply(console, args);
    writeLog("INFO", formatted);
  };

  console.info = (...args: any[]) => {
    const formatted = formatArgs(args);
    originalInfo.apply(console, args);
    writeLog("INFO", formatted);
  };

  console.warn = (...args: any[]) => {
    const formatted = formatArgs(args);
    originalWarn.apply(console, args);
    writeLog("WARN", formatted);
  };

  console.error = (...args: any[]) => {
    const formatted = formatArgs(args);
    originalError.apply(console, args);
    writeLog("ERROR", formatted);
  };

  console.log("[Logger] Global console logging initialized. Output writing to data/app.log");
}

export function readLastLogLines(maxLines = 500): string[] {
  try {
    ensureLogDirExists();
    if (!fs.existsSync(LOG_FILE)) return [];

    const data = fs.readFileSync(LOG_FILE, "utf8");
    const lines = data.split("\n").filter((l) => l.trim().length > 0);
    return lines.slice(-maxLines);
  } catch (err) {
    return [`[Logger Read Error] Failed to read logs: ${err}`];
  }
}

export function clearLogFile() {
  try {
    ensureLogDirExists();
    fs.writeFileSync(LOG_FILE, "", "utf8");
    console.log("[Logger] Log file cleared by administrator request.");
  } catch (err) {
    originalError("[Logger Clear Error]", err);
  }
}
