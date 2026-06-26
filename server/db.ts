import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
export const prisma = new PrismaClient({ adapter });

export async function initializeDbForCloud(): Promise<void> {
  try {
    await prisma.$connect();
    console.log("[DB] Connected successfully to database.");
  } catch (err) {
    console.error("[DB] Database connection error:", err);
    throw err;
  }
}


export interface KotakAccount {
  id: string;
  nickname: string;
  role: "master" | "slave";
  mobileNumber: string;
  ucc: string;
  mpin: string;
  consumerKey: string;
  totpSecret: string;
  multiplier: number;
  status: "active" | "expired" | "error" | "disconnected";
  lastLogin: string | null;
  accessToken: string | null;
  sid: string | null;
  neoToken: string | null;
  rid?: string | null;
  hsServerId?: string | null;
  dataCenter?: string | null;
  baseUrl?: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface TradeOrder {
  id: string;
  masterOrderId: string | null;
  accountId: string;
  accountName: string;
  accountRole: "master" | "slave";
  symbol: string;
  instrument: string;
  optionType: "CE" | "PE" | "FUT" | "EQ";
  strikePrice: number;
  expiry: string;
  quantity: number;
  price: number;
  orderType: "MARKET" | "LIMIT" | "SL";
  triggerPrice?: number;
  transactionType: "BUY" | "SELL";
  status: "SUCCESS" | "FAILED" | "PENDING";
  errorMessage: string | null;
  timestamp: string;
  isSimulated: boolean;
}

export interface AppSettings {
  autoReplicate: boolean;
  autoRenewSessions: boolean;
}

export interface WatchlistItem {
  scriptToken: string;
  tradingSymbol: string;
  exchange: string;
  instrumentName: string;
  segment: string;
  strikePrice: number;
  expiry: string;
  lotSize: number;
  addedAt: string;
}

export async function getAccounts(): Promise<KotakAccount[]> {
  const accs = await prisma.account.findMany();
  return accs as unknown as KotakAccount[];
}

export async function saveAccount(account: KotakAccount): Promise<void> {
  await prisma.account.upsert({
    where: { id: account.id },
    update: {
      nickname: account.nickname,
      role: account.role,
      mobileNumber: account.mobileNumber,
      ucc: account.ucc,
      mpin: account.mpin,
      consumerKey: account.consumerKey,
      totpSecret: account.totpSecret,
      multiplier: account.multiplier,
      status: account.status,
      lastLogin: account.lastLogin,
      accessToken: account.accessToken,
      sid: account.sid,
      neoToken: account.neoToken,
      rid: account.rid,
      hsServerId: account.hsServerId,
      dataCenter: account.dataCenter,
      baseUrl: account.baseUrl,
      errorMessage: account.errorMessage,
    },
    create: {
      id: account.id,
      nickname: account.nickname,
      role: account.role,
      mobileNumber: account.mobileNumber,
      ucc: account.ucc,
      mpin: account.mpin,
      consumerKey: account.consumerKey,
      totpSecret: account.totpSecret,
      multiplier: account.multiplier,
      status: account.status,
      lastLogin: account.lastLogin,
      accessToken: account.accessToken,
      sid: account.sid,
      neoToken: account.neoToken,
      rid: account.rid,
      hsServerId: account.hsServerId,
      dataCenter: account.dataCenter,
      baseUrl: account.baseUrl,
      errorMessage: account.errorMessage,
      createdAt: account.createdAt,
    },
  });
}

export async function deleteAccount(id: string): Promise<void> {
  await prisma.account.delete({
    where: { id },
  });
}

export async function getOrders(): Promise<TradeOrder[]> {
  const ords = await prisma.order.findMany({
    orderBy: { timestamp: "desc" },
  });
  return ords as unknown as TradeOrder[];
}

export async function saveOrder(order: TradeOrder): Promise<void> {
  await prisma.order.upsert({
    where: { id: order.id },
    update: {
      masterOrderId: order.masterOrderId,
      accountId: order.accountId,
      accountName: order.accountName,
      accountRole: order.accountRole,
      symbol: order.symbol,
      instrument: order.instrument,
      optionType: order.optionType,
      strikePrice: order.strikePrice,
      expiry: order.expiry,
      quantity: order.quantity,
      price: order.price,
      orderType: order.orderType,
      transactionType: order.transactionType,
      status: order.status,
      errorMessage: order.errorMessage,
      timestamp: order.timestamp,
      isSimulated: order.isSimulated,
    },
    create: {
      id: order.id,
      masterOrderId: order.masterOrderId,
      accountId: order.accountId,
      accountName: order.accountName,
      accountRole: order.accountRole,
      symbol: order.symbol,
      instrument: order.instrument,
      optionType: order.optionType,
      strikePrice: order.strikePrice,
      expiry: order.expiry,
      quantity: order.quantity,
      price: order.price,
      orderType: order.orderType,
      transactionType: order.transactionType,
      status: order.status,
      errorMessage: order.errorMessage,
      timestamp: order.timestamp,
      isSimulated: order.isSimulated,
    },
  });
}

export async function getSettings(): Promise<AppSettings> {
  const row = await prisma.settings.findUnique({
    where: { id: 1 },
  });
  if (row) {
    return {
      autoReplicate: row.autoReplicate,
      autoRenewSessions: row.autoRenewSessions,
    };
  }
  const defaultSettings = { autoReplicate: true, autoRenewSessions: true };
  try {
    await prisma.settings.create({
      data: { id: 1, ...defaultSettings },
    });
  } catch (_) {}
  return defaultSettings;
}

export async function updateSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
  const row = await prisma.settings.upsert({
    where: { id: 1 },
    update: settings,
    create: {
      id: 1,
      autoReplicate: settings.autoReplicate ?? true,
      autoRenewSessions: settings.autoRenewSessions ?? true,
    },
  });
  return {
    autoReplicate: row.autoReplicate,
    autoRenewSessions: row.autoRenewSessions,
  };
}

export async function getWatchlist(): Promise<WatchlistItem[]> {
  const items = await prisma.watchlist.findMany({
    orderBy: { addedAt: "desc" },
  });
  return items as unknown as WatchlistItem[];
}

export async function addToWatchlist(item: WatchlistItem): Promise<void> {
  await prisma.watchlist.upsert({
    where: { scriptToken: item.scriptToken },
    update: {
      tradingSymbol: item.tradingSymbol,
      exchange: item.exchange,
      instrumentName: item.instrumentName,
      segment: item.segment,
      strikePrice: item.strikePrice,
      expiry: item.expiry,
      lotSize: item.lotSize,
      addedAt: item.addedAt,
    },
    create: {
      scriptToken: item.scriptToken,
      tradingSymbol: item.tradingSymbol,
      exchange: item.exchange,
      instrumentName: item.instrumentName,
      segment: item.segment,
      strikePrice: item.strikePrice,
      expiry: item.expiry,
      lotSize: item.lotSize,
      addedAt: item.addedAt,
    },
  });
}

export async function removeFromWatchlist(scriptToken: string): Promise<void> {
  await prisma.watchlist.delete({
    where: { scriptToken },
  });
}
