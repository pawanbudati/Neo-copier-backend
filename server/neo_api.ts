import fs from "fs";
import path from "path";
import { KotakAccount, TradeOrder, saveAccount, saveOrder, updateOrderStatus, getAccounts, getSettings, prisma } from "./db";
import { generateTOTP } from "./totp";

// ─── Kotak Neo API v2 Endpoints ─────────────────────────────────────────────
const NEO_API_BASE = "https://mis.kotaksecurities.com";
const NEO_FIN_KEY = "neotradeapi";

const DATA_DIR = path.resolve(process.cwd(), "data");
const SCRIP_CACHE_FILE = path.join(DATA_DIR, "scrip-master-cache.json");
const SCRIP_RAW_INDEX_FILE = path.join(DATA_DIR, "scrip-master-raw-index.json");
const SCRIP_RAW_JSON_FILE = path.join(DATA_DIR, "scrip-master-raw", "raw.json");
const SCRIP_RAW_DIR = path.join(DATA_DIR, "scrip-master-raw");
const SCRIP_CACHE_DIR = path.join(DATA_DIR, "scrip-master-files");

interface ScripMasterCacheFile {
  loadedAt: string; // ISO timestamp when the cache was written
  scrips: ScripInfo[];
}

interface ScripMasterRawFile {
  fileUrl: string;
  fileName: string;
  rows: Record<string, string>[];
}

interface ScripMasterRawIndex {
  loadedAt: string;
  files: Array<{
    fileUrl: string;
    fileName: string;
    rawJsonFile: string;
  }>;
}

function ensureDataDirExists(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureScripCacheDirExists(): void {
  ensureDataDirExists();
  if (!fs.existsSync(SCRIP_CACHE_DIR)) {
    fs.mkdirSync(SCRIP_CACHE_DIR, { recursive: true });
  }
}

function ensureScripRawDirExists(): void {
  ensureDataDirExists();
  if (!fs.existsSync(SCRIP_RAW_DIR)) {
    fs.mkdirSync(SCRIP_RAW_DIR, { recursive: true });
  }
}

function getSafeCsvFileName(url: string): string {
  try {
    const parsed = new URL(url);
    let fileName = path.basename(parsed.pathname) || "scrip.csv";
    if (!fileName.toLowerCase().endsWith(".csv")) {
      fileName += ".csv";
    }
    return fileName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  } catch {
    return `scrip-${Date.now()}.csv`;
  }
}

function saveDownloadedCsv(url: string, csvText: string): void {
  try {
    ensureScripCacheDirExists();
    const fileName = getSafeCsvFileName(url);
    const filePath = path.join(SCRIP_CACHE_DIR, fileName);
    fs.writeFileSync(filePath, csvText, "utf-8");
    console.log("[ScripMaster] Saved downloaded CSV to", filePath);
  } catch (err) {
    console.warn("[ScripMaster] Failed to save downloaded CSV:", err);
  }
}

function writeRawScripJson(rawData: { loadedAt: string; rows: Record<string, string>[]; files: Array<{ fileUrl: string; fileName: string }> }): void {
  try {
    ensureScripRawDirExists();

    const index: ScripMasterRawIndex = {
      loadedAt: rawData.loadedAt,
      files: rawData.files.map((file) => ({
        fileUrl: file.fileUrl,
        fileName: file.fileName,
        rawJsonFile: path.basename(SCRIP_RAW_JSON_FILE),
      })),
    };

    fs.writeFileSync(SCRIP_RAW_JSON_FILE, JSON.stringify({
      loadedAt: rawData.loadedAt,
      rows: rawData.rows,
    }, null, 2), "utf-8");
    console.log("[ScripMaster] Saved combined raw CSV rows to", SCRIP_RAW_JSON_FILE);

    fs.writeFileSync(SCRIP_RAW_INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");
    console.log("[ScripMaster] Saved raw CSV index to", SCRIP_RAW_INDEX_FILE);
  } catch (err) {
    console.warn("[ScripMaster] Failed to save raw CSV JSON:", err);
  }
}

function parseCsvToObjects(csvText: string): Record<string, string>[] {
  const normalized = csvText.replace(/\uFEFF/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = cols[index] ?? "";
    });
    rows.push(row);
  }

  return rows;
}

function isSameDay(isoDateA: string, isoDateB: string): boolean {
  return isoDateA.slice(0, 10) === isoDateB.slice(0, 10);
}

function readLocalScripCache(): ScripMasterCacheFile | null {
  try {
    if (!fs.existsSync(SCRIP_CACHE_FILE)) return null;
    const raw = fs.readFileSync(SCRIP_CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as ScripMasterCacheFile;
    if (!parsed || !parsed.loadedAt || !Array.isArray(parsed.scrips)) return null;
    return parsed;
  } catch (err) {
    console.warn("[ScripMaster] Failed to read local cache:", err);
    return null;
  }
}

function writeLocalScripCache(scrips: ScripInfo[]): void {
  try {
    ensureDataDirExists();
    const cache: ScripMasterCacheFile = {
      loadedAt: new Date().toISOString(),
      scrips,
    };
    fs.writeFileSync(SCRIP_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
    console.log("[ScripMaster] Saved local cache to", SCRIP_CACHE_FILE);
  } catch (err) {
    console.warn("[ScripMaster] Failed to save local cache:", err);
  }
}

function clearScripCacheFiles(): void {
  try {
    if (fs.existsSync(SCRIP_CACHE_DIR)) {
      const cacheFiles = fs.readdirSync(SCRIP_CACHE_DIR);
      for (const file of cacheFiles) {
        const filePath = path.join(SCRIP_CACHE_DIR, file);
        if (fs.statSync(filePath).isFile() && file.toLowerCase().endsWith(".csv")) {
          fs.unlinkSync(filePath);
        }
      }
    }

    if (fs.existsSync(SCRIP_RAW_DIR)) {
      const rawFiles = fs.readdirSync(SCRIP_RAW_DIR);
      for (const file of rawFiles) {
        const filePath = path.join(SCRIP_RAW_DIR, file);
        if (fs.statSync(filePath).isFile() && file.toLowerCase().endsWith(".json")) {
          fs.unlinkSync(filePath);
        }
      }
    }

    if (fs.existsSync(SCRIP_RAW_INDEX_FILE)) {
      fs.unlinkSync(SCRIP_RAW_INDEX_FILE);
    }

    if (fs.existsSync(SCRIP_CACHE_FILE)) {
      fs.unlinkSync(SCRIP_CACHE_FILE);
    }

    console.log("[ScripMaster] Cleared existing CSV and raw JSON cache files.");
  } catch (err) {
    console.warn("[ScripMaster] Failed to clear cache files:", err);
  }
}

function getFieldValue(row: Record<string, string>, candidates: string[]): string {
  const lowerKeys = Object.keys(row).reduce<Record<string, string>>((acc, key) => {
    acc[key.trim().toLowerCase()] = row[key] ?? "";
    return acc;
  }, {});

  for (const candidate of candidates) {
    if (candidate in lowerKeys && lowerKeys[candidate].trim().length > 0) {
      return lowerKeys[candidate].trim();
    }
  }
  return "";
}

function parseRawRowToScripInfo(row: Record<string, string>): ScripInfo | null {
  const token = getFieldValue(row, ["psymbol", "ptoken", "token", "scriptoken", "script_token", "scripttoken", "script token", "tokenid", "token_id", "instrument_token"]);
  const tradingSymbol = getFieldValue(row, ["ptrdsymbol", "trdsymbol", "tradingsymbol", "trading_symbol", "psymbol", "symbol", "symbolname", "symbol_name"]);
  const scripRefKey = getFieldValue(row, ["pscriprefkey", "scriprefkey", "scrip_ref_key"]);
  const instrumentName = getFieldValue(row, ["psymname", "symname", "symbol_name", "pinstname", "instrument_name", "instrumentname", "instname"]);
  const exchangeRaw = getFieldValue(row, ["pexchseg", "exchseg", "exchange_segment", "pexchange", "exchange", "segment", "segmentname"]);
  const strikePriceRaw = getFieldValue(row, ["pstrikeprice", "strikeprice", "strike_price", "strike", "strikepriceraw", "dstrikeprice;", "dstrikeprice", "pstrikeprice;"]);
  const lotSizeRaw = getFieldValue(row, ["ilotsize", "llotsize", "iboardlotqty", "plotsize", "lotsize", "lot_size", "boardlotqty", "boardlotquantity", "lotqty"]);

  if (!token || !tradingSymbol) {
    return null;
  }

  const exchange = mapExchangeSegment(exchangeRaw);
  const segment = deriveSegment(tradingSymbol, exchangeRaw, instrumentName);

  const derivedExpiryDate = extractTrueKotakExpiryDate(row);
  let expiryString = "";
  if (derivedExpiryDate) {
    const yyyy = derivedExpiryDate.getFullYear();
    const mm = String(derivedExpiryDate.getMonth() + 1).padStart(2, '0');
    const dd = String(derivedExpiryDate.getDate()).padStart(2, '0');
    expiryString = `${yyyy}-${mm}-${dd}`;
  }

  // Strike price in Kotak scrip master is stored in paise (e.g. 2770000.00 for 27700 strike)
  const rawStrike = parseFloat(strikePriceRaw) || 0;
  const strikePrice = rawStrike > 0 ? rawStrike / 100 : 0;

  return {
    scriptToken: token,
    tradingSymbol,
    scripRefKey,
    instrumentName: instrumentName || tradingSymbol,
    exchange,
    segment,
    strikePrice,
    expiry: expiryString,
    lotSize: parseInt(lotSizeRaw) || 1,
  };
}

function isRelevantRawFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.includes("nse_fo") || lower.includes("bse_fo");
}

function getRawRowSymbolName(row: Record<string, string>): string {
  return getFieldValue(row, ["psymbolname", "psymname", "symname", "symbol_name", "symbolname", "symbol"]).toUpperCase();
}

function parseExpiryDate(raw: string): Date | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  if (/^\d+$/.test(value)) {
    const timestamp = Number(value);
    const date = value.length === 13 ? new Date(timestamp) : new Date(timestamp * 1000);
    if (!isNaN(date.getTime())) return date;
  }

  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function extractTrueKotakExpiryDate(row: Record<string, string>): Date | null {
  const scripRef = getFieldValue(row, ["pscriprefkey", "scriprefkey", "scrip_ref_key"]).toUpperCase();
  const instType = getFieldValue(row, ["pinsttype", "insttype", "instrument_type"]).toUpperCase();

  if (["OPTSTK", "OPTIDX", "FUTSTK", "FUTIDX"].includes(instType) || scripRef.length > 0) {
    const match = scripRef.match(/(\d{2})([A-Z]{3})(\d{2})/);
    if (match) {
      const [_, dayStr, monthStr, yearShortStr] = match;
      const months: Record<string, number> = {
        JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
        JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
      };
      const month = months[monthStr];
      const year = 2000 + parseInt(yearShortStr, 10);
      const day = parseInt(dayStr, 10);

      if (month !== undefined && !isNaN(year) && !isNaN(day)) {
        return new Date(year, month, day, 0, 0, 0, 0);
      }
    }
  }

  const expiryRaw = getFieldValue(row, ["pexpirydate", "expirydate", "expiry_date", "expiry", "exp_date", "expirydatetime"]);
  return parseExpiryDate(expiryRaw);
}

function isExpiryCurrentOrFuture(row: Record<string, string>): boolean {
  const expiryDate = extractTrueKotakExpiryDate(row);
  if (!expiryDate) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  expiryDate.setHours(0, 0, 0, 0);
  
  return expiryDate.getTime() >= today.getTime() &&  expiryDate.getTime() <= today.setMonth(today.getMonth() + 1);
}

function isRelevantRawRow(fileName: string, row: Record<string, string>): boolean {
  if (!isExpiryCurrentOrFuture(row)) {
    return false;
  }

  const lower = fileName.toLowerCase();
  const symbolName = getRawRowSymbolName(row);
  if (lower.includes("nse_fo")) {
    return symbolName === "NIFTY";
  }
  if (lower.includes("bse_fo")) {
    return symbolName === "SENSEX";
  }
  return false;
}

function loadRawScripMasterFromLocalFiles(): ScripInfo[] {
  try {
    if (!fs.existsSync(SCRIP_RAW_DIR)) return [];

    const files = fs.readdirSync(SCRIP_RAW_DIR).filter((file) => file.toLowerCase().endsWith(".json"));
    if (files.length === 0) return [];

    const scripMap = new Map<string, ScripInfo>();

    for (const fileName of files) {
      const filePath = path.join(SCRIP_RAW_DIR, fileName);
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw) as { rows?: Record<string, string>[] };
        if (!parsed || !Array.isArray(parsed.rows)) continue;

        for (const row of parsed.rows) {
          const scrip = parseRawRowToScripInfo(row);
          if (scrip && !scripMap.has(scrip.scriptToken)) {
            scripMap.set(scrip.scriptToken, scrip);
          }
        }
      } catch (err) {
        console.warn("[ScripMaster] Failed to read raw scrip file", filePath, err);
      }
    }

    return Array.from(scripMap.values());
  } catch (err) {
    console.warn("[ScripMaster] Failed to load raw scrip data from local files:", err);
    return [];
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ScripInfo {
  scriptToken: string;
  tradingSymbol: string;
  scripRefKey: string;
  instrumentName: string;
  exchange: string;
  segment: string;        // CE | PE | FUT | EQ
  strikePrice: number;
  expiry: string;
  lotSize: number;
}

export interface QuoteTick {
  token: string;
  ltp: number;
  change: number;
  changePct: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}

// ─── Scrip Master Cache ─────────────────────────────────────────────────────

let scripMasterLoaded = false;
let scripMasterCount = 0;
let scripMasterLoading: Promise<void> | null = null;

export async function initializeScripStatusFromDb(): Promise<void> {
  const count = await prisma.scrip.count();
  scripMasterCount = count;
  scripMasterLoaded = count > 0;
  console.log(`[ScripMaster] Status initialized from database. Loaded: ${scripMasterLoaded}, Count: ${scripMasterCount}`);
}

async function loadScripMaster(): Promise<void> {
  if (scripMasterLoaded) return;
  if (scripMasterLoading) return scripMasterLoading;

  scripMasterLoading = (async () => {
    try {
      const dbCount = await prisma.scrip.count();
      if (dbCount > 0) {
        scripMasterCount = dbCount;
        scripMasterLoaded = true;
        console.log(`[ScripMaster] Found ${dbCount} scrips in database. Skipping download.`);
        return;
      }

      const rawScrips = loadRawScripMasterFromLocalFiles();
      if (rawScrips.length > 0) {
        await prisma.scrip.deleteMany();
        const batchSize = 5000;
        for (let i = 0; i < rawScrips.length; i += batchSize) {
          const chunk = rawScrips.slice(i, i + batchSize);
          await prisma.scrip.createMany({
            data: chunk,
            skipDuplicates: true,
          });
        }
        scripMasterCount = rawScrips.length;
        scripMasterLoaded = true;
        console.log(`[ScripMaster] Loaded ${scripMasterCount} raw scrip records from local files to database.`);
        return;
      }

      if (process.env.NODE_ENV === "production") {
        throw new Error("Downloading scrip master files from the internet is disabled in the production environment. Please upload and use local cache files.");
      }

      const accounts = await getAccounts();
      const activeAcc = accounts.find((a) => a.status === "active" && a.consumerKey && a.sid);

      if (!activeAcc) {
        console.warn("[ScripMaster] No active session found. Login to an account first.");
        return;
      }

      console.log("[ScripMaster] Fetching scrip master file paths...");

      const sessionBaseUrl = activeAcc.baseUrl || NEO_API_BASE;
      const pathsRes = await fetch(`${sessionBaseUrl}/script-details/1.0/masterscrip/file-paths`, {
        headers: {
          "Authorization": `${activeAcc.consumerKey}`,
          "Neo-Session": activeAcc.sid || "",
        },
      });

      if (!pathsRes.ok) {
        const errText = await pathsRes.text();
        throw new Error(`Failed to get scrip master paths: ${pathsRes.status} ${errText}`);
      }

      const pathsData = await pathsRes.json() as any;
      let filePaths: string[] = [];

      if (Array.isArray(pathsData)) {
        filePaths = pathsData;
      } else if (pathsData.filesPaths) {
        filePaths = pathsData.filesPaths;
      } else if (pathsData.data?.filesPaths) {
        filePaths = pathsData.data.filesPaths;
      } else if (typeof pathsData === "object") {
        const extractUrls = (obj: any): string[] => {
          const urls: string[] = [];
          for (const val of Object.values(obj)) {
            if (typeof val === "string" && (val.includes(".csv") || val.includes("http"))) {
              urls.push(val);
            } else if (typeof val === "object" && val !== null) {
              urls.push(...extractUrls(val));
            }
          }
          return urls;
        };
        filePaths = extractUrls(pathsData);
      }

      if (filePaths.length === 0) {
        console.warn("[ScripMaster] No file paths returned.");
        return;
      }

      console.log(`[ScripMaster] Found ${filePaths.length} master file(s). Downloading...`);

      const allScrips: ScripInfo[] = [];
      const filteredRawRows: Record<string, string>[] = [];
      const sourceFiles: Array<{ fileUrl: string; fileName: string }> = [];

      for (const fileUrl of filePaths) {
        const fileName = getSafeCsvFileName(fileUrl);
        if (!isRelevantRawFile(fileName)) {
          continue;
        }

        try {
          const csvRes = await fetch(fileUrl);
          if (!csvRes.ok) {
            console.warn(`[ScripMaster] Failed to download ${fileUrl}: ${csvRes.status}`);
            continue;
          }

          const csvText = await csvRes.text();
          saveDownloadedCsv(fileUrl, csvText);

          const rawRows = parseCsvToObjects(csvText);
          const relevantRows = rawRows.filter((row) => isRelevantRawRow(fileName, row));
          if (relevantRows.length === 0) {
            continue;
          }

          filteredRawRows.push(...relevantRows);
          sourceFiles.push({ fileUrl, fileName });

          for (const row of relevantRows) {
            const scrip = parseRawRowToScripInfo(row);
            if (scrip) {
              allScrips.push(scrip);
            }
          }

          console.log(`[ScripMaster] Parsed ${relevantRows.length} filtered scrips from ${fileUrl.split("/").pop()}`);
        } catch (err) {
          console.warn(`[ScripMaster] Error parsing ${fileUrl}:`, err);
        }
      }

      writeRawScripJson({
        loadedAt: new Date().toISOString(),
        rows: filteredRawRows,
        files: sourceFiles,
      });

      await prisma.scrip.deleteMany();
      const batchSize = 5000;
      for (let i = 0; i < allScrips.length; i += batchSize) {
        const chunk = allScrips.slice(i, i + batchSize);
        await prisma.scrip.createMany({
          data: chunk,
          skipDuplicates: true,
        });
      }
      scripMasterCount = allScrips.length;
      scripMasterLoaded = true;
      console.log(`[ScripMaster] Total scrips loaded to database: ${scripMasterCount}`);
    } catch (err) {
      console.error("[ScripMaster] Failed to load:", err);
    } finally {
      scripMasterLoading = null;
    }
  })();

  return scripMasterLoading;
}

function parseCsvLine(line: string): string[] {
  const delimiter = line.includes(",") ? "," : line.includes(";") ? ";" : ",";
  const cols: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === delimiter) {
        cols.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
  }

  cols.push(current.trim());
  return cols;
}

function parseScripCsv(csvText: string): ScripInfo[] {
  const normalized = csvText.replace(/\uFEFF/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const results: ScripInfo[] = [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());

  const idx = {
    token: findCol(headers, ["ptoken", "token", "scriptoken", "script_token", "scripttoken", "script token", "tokenid", "token_id", "instrument_token"]),
    tradingSymbol: findCol(headers, ["ptrdsymbol", "trdsymbol", "tradingsymbol", "trading_symbol", "psymbol", "symbol", "symbolname", "symbol_name"]),
    scripRefKey: findCol(headers, ["pscriprefkey", "scriprefkey", "scrip_ref_key"]),
    instrumentName: findCol(headers, ["psymname", "symname", "symbol_name", "pinstname", "instrument_name", "instrumentname", "instname"]),
    exchange: findCol(headers, ["pexchseg", "exchseg", "exchange_segment", "pexchange", "exchange", "segment", "segmentname"]),
    strikePrice: findCol(headers, ["pstrikeprice", "strikeprice", "strike_price", "strike", "strikepriceraw"]),
    lotSize: findCol(headers, ["ilotsize", "llotsize", "iboardlotqty", "plotsize", "lotsize", "lot_size", "boardlotqty", "boardlotquantity", "lotqty"]),
    instName: findCol(headers, ["pinstname", "instname", "instrument_name", "pinstrument", "instrument", "instname"]),
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCsvLine(line);

    const token = getCol(cols, idx.token) || "";
    const tradingSymbol = getCol(cols, idx.tradingSymbol) || "";
    const instrumentName = getCol(cols, idx.instrumentName) || getCol(cols, idx.instName) || "";
    const exchangeRaw = getCol(cols, idx.exchange) || "";
    const strikePriceRaw = getCol(cols, idx.strikePrice) || "0";
    const lotSizeRaw = getCol(cols, idx.lotSize) || "1";

    if (!token || !tradingSymbol) continue;

    const exchange = mapExchangeSegment(exchangeRaw);
    const segment = deriveSegment(tradingSymbol, exchangeRaw, instrumentName);

    const fakeRow: Record<string, string> = {};
    headers.forEach((h, hIdx) => {
      fakeRow[h] = cols[hIdx] ?? "";
    });

    const derivedExpiryDate = extractTrueKotakExpiryDate(fakeRow);
    let expiryString = "";
    if (derivedExpiryDate) {
      const yyyy = derivedExpiryDate.getFullYear();
      const mm = String(derivedExpiryDate.getMonth() + 1).padStart(2, "0");
      const dd = String(derivedExpiryDate.getDate()).padStart(2, "0");
      expiryString = `${yyyy}-${mm}-${dd}`;
    }

    results.push({
      scriptToken: token,
      tradingSymbol,
      scripRefKey: getCol(cols, idx.scripRefKey) || "",
      instrumentName: instrumentName || tradingSymbol,
      exchange,
      segment,
      strikePrice: parseFloat(strikePriceRaw) || 0,
      expiry: expiryString,
      lotSize: parseInt(lotSizeRaw) || 1,
    });
  }

  return results;
}

function findCol(headers: string[], candidates: string[]): number {
  for (const c of candidates) {
    const idx = headers.indexOf(c);
    if (idx >= 0) return idx;
  }
  return -1;
}

function getCol(cols: string[], index: number): string | undefined {
  if (index < 0 || index >= cols.length) return undefined;
  return cols[index];
}

function mapExchangeSegment(raw: string): string {
  const r = raw.toUpperCase();
  if (r.includes("NSE_FO") || r === "NFO" || r === "NSE_FNO") return "NFO";
  if (r.includes("BSE_FO") || r === "BFO" || r === "BSE_FNO") return "BFO";
  if (r.includes("NSE_CM") || r === "NSE" || r === "NSE_EQ") return "NSE";
  if (r.includes("BSE_CM") || r === "BSE" || r === "BSE_EQ") return "BSE";
  if (r.includes("MCX") || r === "MCX_FO") return "MCX";
  if (r.includes("CDE") || r === "CDE_FO") return "CDE";
  return r || "NSE";
}

function deriveSegment(symbol: string, exchange: string, instName: string): string {
  const s = symbol.toUpperCase();
  const inst = instName.toUpperCase();
  if (s.endsWith("CE") || inst.includes("OPTIDX") && s.includes("CE")) return "CE";
  if (s.endsWith("PE") || inst.includes("OPTIDX") && s.includes("PE")) return "PE";
  if (s.includes("FUT") || inst.includes("FUTIDX") || inst.includes("FUTSTK")) return "FUT";
  return "EQ";
}

function normalizeDate(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();

  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    if (!Number.isNaN(value)) {
      const date = trimmed.length === 13 ? new Date(value) : new Date(value * 1000);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split("T")[0];
      }
    }
  }

  try {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split("T")[0];
    }
  } catch (_) {}
  return raw;
}

function buildNeoQuoteQuery(scrip: ScripInfo): string {
  const exchangeSeg = mapToNeoExchange(scrip.exchange);
  return `${exchangeSeg}|${scrip.scriptToken}`;
}

async function fetchNeoQuotesForScrips(scrips: ScripInfo[]): Promise<Record<string, QuoteTick>> {
  const quotes: Record<string, QuoteTick> = {};
  if (!scrips.length) return quotes;

  const accounts = await getAccounts();
  const activeAcc = accounts.find((a) => a.status === "active" && a.consumerKey && a.sid && a.neoToken);
  if (!activeAcc || !activeAcc.neoToken) return quotes;

  const queries = scrips.map((s) => buildNeoQuoteQuery(s));
  const encodedQuery = queries.map(encodeURIComponent).join(",");
  const urlBase = activeAcc.baseUrl || NEO_API_BASE;
  const url = `${urlBase}/script-details/1.0/quotes/neosymbol/${encodedQuery}/ltp`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": activeAcc.consumerKey,
        "Sid": activeAcc.sid || "",
        "Neo-Fin-Key": NEO_FIN_KEY,
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[Quotes] Search quotes failed (${response.status}):`, errText.slice(0, 200));
      return quotes;
    }
    const data = await response.json();
    if (!Array.isArray(data)) return quotes;

    for (let index = 0; index < data.length; index += 1) {
      const quote = data[index] as any;
      const scrip = scrips[index];
      if (!quote || !scrip) continue;

      // Kotak returns ltp as a string e.g. "0", "245.50"
      const ltp = Number(quote.ltp ?? quote.lp ?? quote.last_price ?? quote.lastTradedPrice ?? 0);
      if (!Number.isFinite(ltp)) continue;
      // Note: Don't skip ltp===0 — show it so the UI knows the scrip exists (market may be closed)

      const rawChange = Number(quote.cng ?? quote.change ?? quote.changeAmount ?? 0);
      const rawChangePct = Number(quote.nc ?? quote.per_change ?? quote.perChange ?? quote.changePct ?? 0);
      let change = Number.isFinite(rawChange) ? rawChange : 0;
      let changePct = Number.isFinite(rawChangePct) ? rawChangePct : 0;

      const prevClose = Number(quote.c ?? quote.close ?? quote.ohlc?.close ?? 0);
      if (change === 0 && prevClose > 0 && ltp > 0) {
        change = Math.round((ltp - prevClose) * 100) / 100;
        changePct = Math.round(((ltp - prevClose) / prevClose) * 10000) / 100;
      }

      quotes[scrip.scriptToken] = {
        token: scrip.scriptToken,
        ltp,
        change,
        changePct,
        open: Number(quote.op ?? quote.open ?? quote.ohlc?.open ?? 0) || undefined,
        high: Number(quote.h ?? quote.high ?? quote.ohlc?.high ?? 0) || undefined,
        low: Number(quote.lo ?? quote.low ?? quote.ohlc?.low ?? 0) || undefined,
        close: prevClose || undefined,
        volume: Number(quote.v ?? quote.volume ?? quote.last_volume ?? 0) || undefined,
      };
    }
  } catch (_) {
    return quotes;
  }

  return quotes;
}

export async function searchScrips(query: string): Promise<{ results: ScripInfo[]; quotes: Record<string, QuoteTick> }> {
  if (!query || query.trim().length < 1) {
    return { results: [], quotes: {} };
  }
  if (!scripMasterLoaded) {
    await loadScripMaster();
  }
  if (!scripMasterLoaded) {
    return { results: [], quotes: {} };
  }

  const tokens = query.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const now = Date.now();

  const dbResults = await prisma.scrip.findMany({
    where: {
      AND: tokens.map((token) => ({
        OR: [
          { tradingSymbol: { contains: token, mode: 'insensitive' } },
          { instrumentName: { contains: token, mode: 'insensitive' } },
          { scripRefKey: { contains: token, mode: 'insensitive' } }
        ]
      }))
    },
    take: 100
  });

  const parsedResults = dbResults as unknown as ScripInfo[];

  parsedResults.sort((a, b) => {
    const expiryA = a.expiry ? new Date(a.expiry).getTime() : Infinity;
    const expiryB = b.expiry ? new Date(b.expiry).getTime() : Infinity;

    const expiredA = expiryA < now;
    const expiredB = expiryB < now;
    if (expiredA !== expiredB) return expiredA ? 1 : -1;

    return expiryA - expiryB;
  });

  const results = parsedResults.slice(0, 30);
  const quotes = await fetchNeoQuotesForScrips(results);
  return { results, quotes };
}

export async function loadScripMasterCache(forceReload = false): Promise<{ success: boolean; loaded: boolean; count: number; error?: string }> {
  try {
    if (forceReload) {
      await invalidateScripMaster();
      clearScripCacheFiles();
    }
    await loadScripMaster();
    return {
      success: scripMasterLoaded,
      loaded: scripMasterLoaded,
      count: scripMasterCount,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, loaded: scripMasterLoaded, count: scripMasterCount, error: message };
  }
}

export function isScripMasterLoaded(): boolean {
  return scripMasterLoaded;
}

export function getScripMasterCount(): number {
  return scripMasterCount;
}

export async function invalidateScripMaster(): Promise<void> {
  scripMasterLoaded = false;
  scripMasterCount = 0;
  scripMasterLoading = null;
  await prisma.scrip.deleteMany();
}

// ─── Authentication ─────────────────────────────────────────────────────────

function hasAutoTotpSecret(secret?: string): boolean {
  const cleanSecret = (secret || "").replace(/\s+/g, "").toUpperCase();
  return /^[A-Z2-7]{16,}$/.test(cleanSecret);
}

function normalizeKotakMobileNumber(mobileNumber: string): string {
  const trimmed = mobileNumber.trim();
  if (trimmed.startsWith("+")) return trimmed;

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return trimmed;
}

function getKotakError(responseBody: string, fallback: string): string {
  if (!responseBody) return fallback;
  try {
    const parsed = JSON.parse(responseBody) as any;
    return (
      parsed?.error?.message ||
      parsed?.message ||
      parsed?.Error ||
      parsed?.error ||
      responseBody
    );
  } catch (_) {
    return responseBody;
  }
}

export async function authenticateKotakAccount(
  account: KotakAccount,
  providedOtp?: string
): Promise<{ success: boolean; accessToken?: string; sid?: string; neoToken?: string; rid?: string; hsServerId?: string; dataCenter?: string; baseUrl?: string; error?: string }> {
  try {
    let otpCode = "";
    if (hasAutoTotpSecret(account.totpSecret)) {
      otpCode = generateTOTP(account.totpSecret);
    } else if (providedOtp) {
      otpCode = providedOtp;
    } else {
      throw new Error("Enter the current 6-digit TOTP from your authenticator app.");
    }

    if (!account.consumerKey) throw new Error("Consumer Key is required.");
    if (!account.ucc) throw new Error("UCC (Unique Client Code) is required.");
    if (!account.mpin) throw new Error("MPIN is required for login.");

    console.log(`[Auth] Step 1: TOTP Login for ${account.nickname}...`);
    const totpLoginResponse = await fetch(`${NEO_API_BASE}/login/1.0/tradeApiLogin`, {
      method: "POST",
      headers: {
        "Authorization": account.consumerKey,
        "neo-fin-key": NEO_FIN_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        mobileNumber: normalizeKotakMobileNumber(account.mobileNumber),
        ucc: account.ucc,
        totp: otpCode,
      }),
    });

    if (!totpLoginResponse.ok) {
      const errText = await totpLoginResponse.text();
      throw new Error(`TOTP Login failed (Step 1): ${getKotakError(errText, totpLoginResponse.statusText)}`);
    }

    const totpLoginData = (await totpLoginResponse.json()) as any;
    const sid = totpLoginData.data?.sid || totpLoginData.sid;
    const viewToken = totpLoginData.data?.token || totpLoginData.token;

    if (!sid || !viewToken) throw new Error("Session ID/view token returned empty.");

    console.log(`[Auth] Step 1 success. SID obtained for ${account.nickname}.`);

    console.log(`[Auth] Step 2: MPIN Validate for ${account.nickname}...`);
    const validateResponse = await fetch(`${NEO_API_BASE}/login/1.0/tradeApiValidate`, {
      method: "POST",
      headers: {
        "Authorization": account.consumerKey,
        "sid": sid,
        "Auth": viewToken,
        "neo-fin-key": NEO_FIN_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ mpin: account.mpin }),
    });

    if (!validateResponse.ok) {
      const errText = await validateResponse.text();
      throw new Error(`MPIN Validation failed (Step 2): ${getKotakError(errText, validateResponse.statusText)}`);
    }

    const validateData = (await validateResponse.json()) as any;
    const neoToken = validateData.data?.token || validateData.data?.neoToken || validateData.token || validateData.neoToken;
    const editSid = validateData.data?.sid || sid;

    if (!neoToken) throw new Error("MPIN Validation succeeded but no trading token returned.");

    console.log(`[Auth] Login complete for ${account.nickname}. Session active.`);
    invalidateScripMaster();

    return {
      success: true,
      accessToken: account.consumerKey,
      sid: editSid,
      neoToken,
      rid: validateData.data?.rid || validateData.rid,
      hsServerId: validateData.data?.hsServerId || validateData.hsServerId,
      dataCenter: validateData.data?.dataCenter || validateData.dataCenter,
      baseUrl: validateData.data?.baseUrl || validateData.baseUrl,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Auth] Error for ${account.nickname}:`, msg);
    return { success: false, error: msg };
  }
}

// ─── Order Execution Helpers ────────────────────────────────────────────────

export async function getNeoOrderBook(account: KotakAccount): Promise<any[]> {
  const baseUrl = account.baseUrl || NEO_API_BASE;
  const url = `${baseUrl}/quick/user/orders`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": account.neoToken,
      "Sid": account.sid,
      "Neo-Fin-Key": NEO_FIN_KEY,
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch order book (${response.status})`);
  }
  const resData = await response.json();
  return resData.data || resData || [];
}

export async function pollOrderFinalStatus(
  account: KotakAccount,
  orderId: string
): Promise<{ success: boolean; status: string; error?: string }> {
  // Retry up to 4 times with a 250ms delay to give the exchange time to reject or trade the order
  for (let i = 0; i < 4; i++) {
    try {
      const orders = await getNeoOrderBook(account);
      const matched = orders.find((o: any) => String(o.nOrdNo) === String(orderId));
      if (matched) {
        const ordSt = matched.ordSt ? matched.ordSt.toUpperCase() : "";
        if (ordSt === "REJECTED") {
          return {
            success: false,
            status: "FAILED",
            error: matched.rejReason || "Order rejected by broker",
          };
        } else if (ordSt === "CANCELLED" || ordSt === "CANCEL") {
          return {
            success: false,
            status: "FAILED",
            error: matched.cancelReason || "Order cancelled",
          };
        } else if (ordSt === "TRADED" || ordSt === "COMPLETE" || ordSt === "FILLED") {
          return { success: true, status: "SUCCESS" };
        } else if (ordSt === "OPEN" || ordSt === "PENDING" || ordSt.includes("TRIGGER")) {
          return { success: true, status: "PENDING" }; // successfully placed open limit or trigger order
        }
      }
    } catch (e) {
      console.error(`[OrderSync] Error checking order book for ${account.nickname}:`, e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { success: true, status: "SUCCESS" }; // Fallback if order not found in book
}

// ─── Cancel an open order on the exchange ───────────────────────────────────
export async function cancelNeoOrder(
  account: KotakAccount,
  orderId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!account.consumerKey || !account.neoToken || !account.sid) {
      throw new Error("Account session expired or unauthenticated. Please login again.");
    }

    const baseUrl = account.baseUrl || NEO_API_BASE;
    const cancelUrl = `${baseUrl}/quick/order/cancel`;

    const payload = { on: String(orderId) };

    console.log(`[CancelOrder] Cancelling order ${orderId} for ${account.nickname}...`);
    console.log(`[CancelOrder] URL: ${cancelUrl}, Payload:`, JSON.stringify(payload));

    const response = await fetch(cancelUrl, {
      method: "POST",
      headers: {
        "Authorization": account.neoToken,
        "Sid": account.sid,
        "Neo-Fin-Key": NEO_FIN_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: `jData=${encodeURIComponent(JSON.stringify(payload))}`,
    });

    const resText = await response.text();
    console.log(`[CancelOrder] Response (${response.status}):`, resText.slice(0, 500));

    if (!response.ok) {
      throw new Error(`Cancel failed (${response.status}): ${resText || response.statusText}`);
    }

    let resData: any;
    try {
      resData = JSON.parse(resText);
    } catch (_) {
      throw new Error(`Cancel response not JSON: ${resText.slice(0, 200)}`);
    }

    if (resData.stat === "NotOk" || resData.stat === "Not_Ok" || resData.errMsg || resData.error) {
      throw new Error(`Cancel rejected: ${resData.errMsg || resData.error || resData.message || JSON.stringify(resData)}`);
    }

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CancelOrder] Error for ${account.nickname}:`, msg);
    return { success: false, error: msg };
  }
}

// ─── Get live status of a specific order from the broker order book ──────────
export async function getOrderLiveStatus(
  account: KotakAccount,
  orderId: string
): Promise<{ status: string; rejReason?: string; cancelReason?: string } | null> {
  try {
    const orders = await getNeoOrderBook(account);
    const matched = orders.find((o: any) => String(o.nOrdNo) === String(orderId));
    if (!matched) return null;

    const ordSt = matched.ordSt ? matched.ordSt.toUpperCase() : "";

    if (ordSt === "TRADED" || ordSt === "COMPLETE" || ordSt === "FILLED") {
      return { status: "SUCCESS" };
    } else if (ordSt === "REJECTED") {
      return { status: "FAILED", rejReason: matched.rejReason };
    } else if (ordSt === "CANCELLED" || ordSt === "CANCEL") {
      return { status: "CANCELLED", cancelReason: matched.cancelReason };
    } else if (ordSt === "OPEN" || ordSt === "PENDING" || ordSt.includes("TRIGGER")) {
      return { status: "PENDING" };
    }

    return { status: ordSt || "UNKNOWN" };
  } catch (e) {
    console.error(`[OrderSync] Error checking order status for ${account.nickname}:`, e);
    return null;
  }
}

export async function getNeoAccountPositions(account: KotakAccount): Promise<any[]> {
  const baseUrl = account.baseUrl || NEO_API_BASE;
  const url = `${baseUrl}/quick/user/positions`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": account.neoToken,
      "Sid": account.sid,
      "Neo-Fin-Key": NEO_FIN_KEY,
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch positions (${response.status})`);
  }
  const resData = await response.json();
  
  if (resData.stat === "Not_Ok" || resData.stat === "NotOk") {
    const err = resData.errMsg || resData.error || "";
    if (err.toLowerCase().includes("no position") || err.toLowerCase().includes("no record") || err.toLowerCase().includes("no data")) {
      return [];
    }
    throw new Error(err || "Broker returned failure status");
  }

  const data = resData.data;
  if (Array.isArray(data)) {
    return data;
  }
  if (typeof data === "string" && (data.toLowerCase().includes("no position") || data.toLowerCase().includes("no record") || data.toLowerCase().includes("no data"))) {
    return [];
  }
  if (Array.isArray(resData)) {
    return resData;
  }
  return [];
}

export async function getNeoAccountLimits(account: KotakAccount): Promise<any> {
  const baseUrl = account.baseUrl || NEO_API_BASE;
  const url = `${baseUrl}/quick/user/limits`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": account.neoToken,
      "Sid": account.sid,
      "Neo-Fin-Key": NEO_FIN_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: `jData=${encodeURIComponent(JSON.stringify({ seg: "ALL", exch: "ALL", prod: "ALL" }))}`,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch limits (${response.status})`);
  }
  const resData = await response.json();
  
  if (resData.stat === "Not_Ok" || resData.stat === "NotOk") {
    const err = resData.errMsg || resData.error || resData.message || "";
    throw new Error(err || "Broker returned failure status for limits");
  }

  let limitsObj = resData.data || resData || {};
  if (Array.isArray(limitsObj)) {
    limitsObj = limitsObj[0] || {};
  }
  return limitsObj;
}

// ─── Order Execution ────────────────────────────────────────────────────────

export async function executeNeoOrder(
  account: KotakAccount,
  order: Omit<TradeOrder, "id" | "status" | "errorMessage" | "timestamp" | "accountId" | "accountName" | "accountRole" | "isSimulated" | "masterOrderId">,
): Promise<{ success: boolean; orderId?: string; status?: "SUCCESS" | "PENDING"; error?: string }> {
  const orderId = `NEO_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  try {
    if (!account.consumerKey || !account.neoToken || !account.sid) {
      throw new Error("Account session expired or unauthenticated. Please login again.");
    }

    // Resolve exchange segment — prefer scrip master lookup for accuracy
    let matchedScrip = await prisma.scrip.findFirst({
      where: { tradingSymbol: order.symbol }
    }) as unknown as ScripInfo | null;

    // Fallback: If exact match fails, try matching on instrument, strike, segment, expiry
    if (!matchedScrip && order.instrument && order.instrument !== "CUSTOM") {
      const orderInst = order.instrument.toUpperCase();
      const prefix = (orderInst === "IO" || orderInst === "IF" || orderInst === "SENSEX")
        ? "SENSEX"
        : orderInst;

      matchedScrip = await prisma.scrip.findFirst({
        where: {
          tradingSymbol: { startsWith: prefix },
          segment: order.optionType,
          strikePrice: order.strikePrice,
          expiry: order.expiry || null,
        }
      }) as unknown as ScripInfo | null;
    }

    let exchangeSegment: string;
    let tradingSymbol = order.symbol;

    if (matchedScrip) {
      exchangeSegment = mapToNeoExchange(matchedScrip.exchange);
      tradingSymbol = matchedScrip.tradingSymbol;
      console.log(`[Order] Resolved symbol "${order.symbol}" to exact trading symbol "${tradingSymbol}" from scrip master`);
    } else {
      const exchangeCode = getExchangeForInstrument(order.instrument);
      exchangeSegment = mapToNeoExchange(exchangeCode);
    }

    // Kotak Neo API v2 uses shortened field names in the order payload
    const payload = {
      es: exchangeSegment,                                          // exchange_segment
      ts: tradingSymbol,                                            // trading_symbol
      qt: String(order.quantity),                                   // quantity
      pr: String(order.price || 0),                                 // price (0 for market)
      tt: order.transactionType === "BUY" ? "B" : "S",             // transaction_type
      pt: order.orderType === "MARKET" ? "MKT" : (order.orderType === "SL" ? "SL" : "L"), // price_type (MKT, L, or SL)
      pc: "MIS",                                                    // product_code
      rt: "DAY",                                                    // retention (validity)
      dq: "0",                                                      // disclosed_quantity
      mp: "0",                                                      // market_protection
      tp: order.orderType === "SL" ? String(order.triggerPrice || 0) : "0", // trigger_price
      pf: "N",                                                      // portfolio flag
      am: "NO",                                                     // after_market_order
    };

    // Use account's dynamic baseUrl (e.g., https://e21.kotaksecurities.com)
    const baseUrl = account.baseUrl || NEO_API_BASE;
    const orderUrl = `${baseUrl}/quick/order/rule/ms/place`;

    console.log(`[Order] Placing ${order.transactionType} order for ${order.symbol} on ${account.nickname}...`);
    console.log(`[Order] URL: ${orderUrl}, Payload:`, JSON.stringify(payload));

    const response = await fetch(orderUrl, {
      method: "POST",
      headers: {
        "Authorization": account.neoToken,
        "Sid": account.sid,
        "Neo-Fin-Key": NEO_FIN_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: `jData=${encodeURIComponent(JSON.stringify(payload))}`,
    });

    const resText = await response.text();
    console.log(`[Order] Response (${response.status}):`, resText.slice(0, 500));

    if (!response.ok) {
      let friendlyError = `Order failed (${response.status}): ${resText || response.statusText}`;
      try {
        const errObj = JSON.parse(resText);
        if (errObj.stCode === 100008 || errObj.errMsg === "unauthorized" || errObj.stCode === 100009) {
          friendlyError += " | HINT: This indicates that your public IP address is not whitelisted in your Kotak Neo Trade API application settings. Please whitelist your public IP in the Kotak Neo developer portal under your App details.";
        }
      } catch (_) {}
      throw new Error(friendlyError);
    }

    let resData: any;
    try {
      resData = JSON.parse(resText);
    } catch (_) {
      throw new Error(`Order response not JSON: ${resText.slice(0, 200)}`);
    }

    // Check for API-level error
    if (resData.stat === "NotOk" || resData.errMsg || resData.error) {
      throw new Error(`Order rejected: ${resData.errMsg || resData.error || resData.message || JSON.stringify(resData)}`);
    }

    const liveOrderId = resData.nOrdNo || resData.data?.nOrdNo || resData.orderId || resData.data?.orderId || orderId;

    // Check actual order status from the order book
    const finalResult = await pollOrderFinalStatus(account, liveOrderId);
    if (!finalResult.success) {
      throw new Error(finalResult.error || "Order rejected by exchange");
    }

    return {
      success: true,
      orderId: String(liveOrderId),
      status: finalResult.status as "SUCCESS" | "PENDING",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Order] Error for ${account.nickname}:`, msg);
    return { success: false, orderId, error: msg };
  }
}

export async function replicateMasterTrade(
  masterOrderInput: Omit<TradeOrder, "id" | "status" | "errorMessage" | "timestamp" | "accountId" | "accountName" | "accountRole" | "isSimulated" | "masterOrderId">
): Promise<{ masterOrder: TradeOrder; slaveOrders: TradeOrder[] }> {
  const accounts = await getAccounts();
  const settings = await getSettings();

  const masterAcc = accounts.find((a) => a.role === "master" && a.status === "active");
  if (!masterAcc) throw new Error("No active Master Account found.");

  const masterResult = await executeNeoOrder(masterAcc, masterOrderInput);

  const masterOrder: TradeOrder = {
    id: masterResult.orderId || `M_ERR_${Date.now()}`,
    masterOrderId: null,
    accountId: masterAcc.id,
    accountName: masterAcc.nickname,
    accountRole: "master",
    ...masterOrderInput,
    status: masterResult.success
      ? (masterResult.status === "PENDING" ? "PENDING" : "SUCCESS")
      : "FAILED",
    errorMessage: masterResult.error || null,
    timestamp: new Date().toISOString(),
    isSimulated: false,
  };

  saveOrder(masterOrder);
  const slaveOrders: TradeOrder[] = [];

  if (!masterResult.success || !settings.autoReplicate) {
    return { masterOrder, slaveOrders };
  }

  const slaveAccounts = accounts.filter((a) => a.role === "slave" && a.status === "active");

  const slavePromises = slaveAccounts.map(async (slave) => {
    const calculatedQty = Math.max(1, Math.round(masterOrderInput.quantity * slave.multiplier));
    const slaveOrderInput = {
      ...masterOrderInput,
      quantity: calculatedQty,
    };

    try {
      const slaveResult = await executeNeoOrder(slave, slaveOrderInput);
      const slaveOrder: TradeOrder = {
        id: slaveResult.orderId || `S_ERR_${Date.now()}_${slave.id}`,
        masterOrderId: masterOrder.id,
        accountId: slave.id,
        accountName: slave.nickname,
        accountRole: "slave",
        ...slaveOrderInput,
        status: slaveResult.success
          ? (slaveResult.status === "PENDING" ? "PENDING" : "SUCCESS")
          : "FAILED",
        errorMessage: slaveResult.error || null,
        timestamp: new Date().toISOString(),
        isSimulated: false,
      };
      saveOrder(slaveOrder);
      return slaveOrder;
    } catch (err: any) {
      const failedOrder: TradeOrder = {
        id: `S_ERR_${Date.now()}_${slave.id}`,
        masterOrderId: masterOrder.id,
        accountId: slave.id,
        accountName: slave.nickname,
        accountRole: "slave",
        ...slaveOrderInput,
        status: "FAILED",
        errorMessage: err.message || String(err),
        timestamp: new Date().toISOString(),
        isSimulated: false,
      };
      saveOrder(failedOrder);
      return failedOrder;
    }
  });

  const results = await Promise.all(slavePromises);
  slaveOrders.push(...results);

  return { masterOrder, slaveOrders };
}

function getExchangeForInstrument(instrument: string): string {
  const code = instrument.toUpperCase();
  // F&O instruments on NSE
  if (code.includes("NIFTY") || code.includes("BANKNIFTY") || code.includes("FINNIFTY")) return "NFO";
  if (code === "OPTIDX" || code === "FUTIDX" || code === "OPTSTK" || code === "FUTSTK") return "NFO";
  // F&O instruments on BSE
  if (code.includes("SENSEX") || code === "IO" || code === "IF") return "BFO";
  // Currency & Commodity derivatives
  if (code.includes("USDINR") || code.includes("EURINR") || code === "OPTCUR" || code === "FUTCUR") return "CDE";
  if (code.includes("CRUDE") || code.includes("GOLD") || code.includes("SILVER") || code === "FUTCOM" || code === "OPTFUT") return "MCX";
  // Try to look up exchange from scrip master
  return "NSE";
}

// ─── Live Market Feed (REST Polling) ────────────────────────────────────────
// The Kotak HSM WebSocket (wss://mlhsm.kotaksecurities.com) uses a proprietary
// BINARY protocol that requires a custom encoder/decoder (see official SDK
// HSWebSocketLib.py). Instead of reimplementing that complex binary protocol,
// we poll the REST quotes API every ~1.5 seconds for all subscribed tokens.
// The same public API (subscribeTokens, onPriceTick, etc.) is preserved so the
// SSE layer in server.ts works unchanged.

type PriceCallback = (tick: QuoteTick) => void;

let subscribedTokens = new Set<string>();
const subscriptionCounts = new Map<string, number>();
const priceListeners: Set<PriceCallback> = new Set();
let lastPrices: Record<string, QuoteTick> = {};
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollRunning = false;
let feedConnected = false;

const POLL_INTERVAL_MS = 500; // Poll every 500ms
const MAX_TOKENS_PER_REQUEST = 25; // Kotak limits URL length

function mapToNeoExchange(exchange: string): string {
  switch (exchange.toUpperCase()) {
    case "NFO": return "nse_fo";
    case "NSE": return "nse_cm";
    case "BFO": return "bse_fo";
    case "BSE": return "bse_cm";
    case "MCX": return "mcx_fo";
    case "CDE": return "cde_fo";
    default: return "nse_cm";
  }
}

function buildQuoteKeyForToken(scriptToken: string, scrip?: ScripInfo | null): string | null {
  if (scriptToken === "Nifty 50") return "nse_cm|Nifty 50";
  if (scriptToken === "SENSEX") return "bse_cm|SENSEX";

  if (!scrip) return null;
  const exchangeSeg = mapToNeoExchange(scrip.exchange);
  return `${exchangeSeg}|${scrip.scriptToken}`;
}

async function pollQuotesOnce(): Promise<void> {
  if (pollRunning) return;
  if (subscribedTokens.size === 0) return;

  const accounts = await getAccounts();
  const activeAcc = accounts.find((a) => a.status === "active" && a.consumerKey && a.sid && a.neoToken);
  if (!activeAcc || !activeAcc.neoToken) {
    feedConnected = false;
    return;
  }

  pollRunning = true;

  try {
    const allTokens = Array.from(subscribedTokens);

    // Build scrip lookup for response mapping
    const tokenToScrip = new Map<string, ScripInfo>();
    const dbScrips = await prisma.scrip.findMany({
      where: {
        scriptToken: { in: allTokens }
      }
    });
    for (const scrip of dbScrips) {
      tokenToScrip.set(scrip.scriptToken, scrip as unknown as ScripInfo);
    }

    // Chunk into batches to avoid URL length limits
    for (let i = 0; i < allTokens.length; i += MAX_TOKENS_PER_REQUEST) {
      const chunk = allTokens.slice(i, i + MAX_TOKENS_PER_REQUEST);

      // Build query: exchange_segment|token for each scrip
      const queryParts: string[] = [];
      const orderedTokens: string[] = [];

      for (const t of chunk) {
        const scrip = tokenToScrip.get(t);
        const key = buildQuoteKeyForToken(t, scrip);
        if (key) {
          queryParts.push(key);
          orderedTokens.push(t);
        }
      }

      if (queryParts.length === 0) continue;

      const urlBase = activeAcc.baseUrl || NEO_API_BASE;
      const quotesPath = queryParts.map(encodeURIComponent).join(",");
      const url = `${urlBase}/script-details/1.0/quotes/neosymbol/${quotesPath}`;

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "Authorization": activeAcc.consumerKey,
            "Sid": activeAcc.sid || "",
            "Neo-Fin-Key": NEO_FIN_KEY,
          },
        });

        if (!response.ok) {
          const errText = await response.text();
          console.warn(`[LiveFeed] Quote poll failed (${response.status}):`, errText.slice(0, 200));
          feedConnected = false;
          continue;
        }

        feedConnected = true;
        const data = await response.json() as any;

        // The API returns an array of quote objects matching the requested order
        const quoteArray = Array.isArray(data) ? data : (data?.data ? (Array.isArray(data.data) ? data.data : [data.data]) : [data]);

        for (let qi = 0; qi < quoteArray.length; qi++) {
          const quote = quoteArray[qi];
          if (!quote) continue;

          // Try to match by position (API returns in same order as request)
          const scriptToken = orderedTokens[qi];
          if (!scriptToken) continue;

          const ltp = Number(quote.ltp ?? quote.lp ?? quote.last_price ?? quote.lastTradedPrice ?? 0);
          if (!Number.isFinite(ltp)) continue;

          const prevClose = Number(quote.c ?? quote.close ?? quote.ohlc?.close ?? 0);
          const rawChange = Number(quote.cng ?? quote.change ?? quote.changeAmount ?? 0);
          const rawChangePct = Number(quote.nc ?? quote.per_change ?? quote.perChange ?? quote.changePct ?? 0);

          let change = Number.isFinite(rawChange) ? rawChange : 0;
          let changePct = Number.isFinite(rawChangePct) ? rawChangePct : 0;

          // Derive change from prevClose if not provided
          if (change === 0 && prevClose > 0) {
            change = Math.round((ltp - prevClose) * 100) / 100;
            changePct = Math.round(((ltp - prevClose) / prevClose) * 10000) / 100;
          }

          const quoteTick: QuoteTick = {
            token: scriptToken,
            ltp,
            change,
            changePct,
            open: Number(quote.op ?? quote.open ?? quote.ohlc?.open ?? 0) || undefined,
            high: Number(quote.h ?? quote.high ?? quote.ohlc?.high ?? 0) || undefined,
            low: Number(quote.lo ?? quote.low ?? quote.ohlc?.low ?? 0) || undefined,
            close: prevClose || undefined,
            volume: Number(quote.v ?? quote.volume ?? quote.last_volume ?? 0) || undefined,
          };

          // Only emit if price actually changed
          const prev = lastPrices[scriptToken];
          if (!prev || prev.ltp !== quoteTick.ltp || prev.change !== quoteTick.change) {
            lastPrices[scriptToken] = quoteTick;
            for (const cb of priceListeners) {
              try { cb(quoteTick); } catch (_) {}
            }
          } else {
            // Even if unchanged, update the cache
            lastPrices[scriptToken] = quoteTick;
          }
        }
      } catch (err: any) {
        console.warn("[LiveFeed] Fetch error:", err?.message || err);
      }
    }
  } finally {
    pollRunning = false;
  }
}

function startPolling(): void {
  if (pollTimer) return;
  console.log(`[LiveFeed] Starting REST quote polling (${POLL_INTERVAL_MS}ms interval)...`);
  // Run immediately, then every POLL_INTERVAL_MS
  pollQuotesOnce();
  pollTimer = setInterval(pollQuotesOnce, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    feedConnected = false;
    console.log("[LiveFeed] Stopped REST quote polling.");
  }
}

export async function connectMarketFeed(): Promise<void> {
  if (pollTimer) return; // Already running
  const accounts = await getAccounts();
  const activeAcc = accounts.find((a) => a.status === "active" && a.consumerKey && a.sid && a.neoToken);
  if (!activeAcc) {
    console.warn("[LiveFeed] No active session for market feed.");
    return;
  }
  startPolling();
}

export function subscribeTokens(tokens: string[]): void {
  const requestedTokens = tokens.filter(Boolean);
  let hasNew = false;

  for (const token of requestedTokens) {
    const count = subscriptionCounts.get(token) || 0;
    subscriptionCounts.set(token, count + 1);
    if (!subscribedTokens.has(token)) {
      subscribedTokens.add(token);
      hasNew = true;
    }
  }

  // Start polling if not already running and we have tokens
  if (subscribedTokens.size > 0 && !pollTimer) {
    connectMarketFeed();
  }

  // Immediately poll for new tokens so the user doesn't wait 1.5s
  if (hasNew) {
    pollQuotesOnce();
  }
}

export function unsubscribeTokens(tokens: string[]): void {
  for (const token of tokens.filter(Boolean)) {
    const count = subscriptionCounts.get(token) || 0;
    if (count <= 1) {
      subscriptionCounts.delete(token);
      subscribedTokens.delete(token);
    } else {
      subscriptionCounts.set(token, count - 1);
    }
  }

  // Stop polling if no more tokens
  if (subscribedTokens.size === 0) {
    stopPolling();
  }
}

export function onPriceTick(callback: PriceCallback): () => void {
  priceListeners.add(callback);
  return () => { priceListeners.delete(callback); };
}

export function getLastPrices(): Record<string, QuoteTick> {
  return { ...lastPrices };
}

export function isMarketFeedConnected(): boolean {
  return feedConnected || (pollTimer !== null && subscribedTokens.size > 0);
}