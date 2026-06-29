import "dotenv/config";
import { initializeLogger, readLastLogLines, clearLogFile } from "./server/logger";
initializeLogger();
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import os from "os";
import { getAccounts, saveAccount, deleteAccount, getOrders, saveOrder, updateOrderStatus, getSettings, updateSettings, KotakAccount, WatchlistItem, initializeDbForCloud } from "./server/db";
import { authenticateKotakAccount, replicateMasterTrade, searchScrips, loadScripMasterCache, isScripMasterLoaded, getScripMasterCount, ScripInfo, subscribeTokens, unsubscribeTokens, onPriceTick, getLastPrices, isMarketFeedConnected, connectMarketFeed, QuoteTick, getNeoAccountPositions, getNeoAccountLimits, executeNeoOrder, cancelNeoOrder, getOrderLiveStatus, initializeScripStatusFromDb, getSystemPower, setSystemPower } from "./server/neo_api";
import { generateTOTP } from "./server/totp";

function hasAutoTotpSecret(secret?: string): boolean {
  const cleanSecret = (secret || "").replace(/\s+/g, "").toUpperCase();
  return /^[A-Z2-7]{16,}$/.test(cleanSecret);
}

const isProd = process.env.NODE_ENV === "production";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}

async function startServer() {
  await initializeDbForCloud();
  await initializeScripStatusFromDb();
  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- API ROUTES ---

  // Get backend logs
  app.get("/api/logs", (req, res) => {
    try {
      const maxLines = req.query.lines ? Number(req.query.lines) : 500;
      res.json({ logs: readLastLogLines(maxLines) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download raw backend logs file
  app.get("/api/logs/download", (req, res) => {
    try {
      const logPath = path.resolve(process.cwd(), "data", "app.log");
      if (fs.existsSync(logPath)) {
        res.download(logPath, "app.log");
      } else {
        res.status(404).json({ error: "Log file not found" });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Clear/Truncate backend logs
  app.post("/api/logs/clear", (req, res) => {
    try {
      clearLogFile();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get active settings
  app.get("/api/settings", async (req, res) => {
    try {
      res.json(await getSettings());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update settings
  app.post("/api/settings", async (req, res) => {
    try {
      const newSettings = await updateSettings(req.body);
      res.json(newSettings);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get system power status
  app.get("/api/system/power", (req, res) => {
    res.json({ powerOn: getSystemPower() });
  });

  // Update system power status
  app.post("/api/system/power", (req, res) => {
    try {
      const { powerOn } = req.body;
      if (typeof powerOn !== "boolean") {
        res.status(400).json({ error: "powerOn must be a boolean" });
        return;
      }
      setSystemPower(powerOn);
      res.json({ success: true, powerOn: getSystemPower() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Retrieve accounts (secrets masked)
  app.get("/api/accounts", async (req, res) => {
    try {
      const accounts = (await getAccounts()).map((acc) => ({
        id: acc.id,
        nickname: acc.nickname,
        role: acc.role,
        mobileNumber: acc.mobileNumber,
        ucc: acc.ucc,
        multiplier: acc.multiplier,
        status: acc.status,
        lastLogin: acc.lastLogin,
        errorMessage: acc.errorMessage,
        createdAt: acc.createdAt,
        hasConsumerKey: !!acc.consumerKey,
        hasTotpSecret: !!acc.totpSecret,
        hasAutoTotpSecret: hasAutoTotpSecret(acc.totpSecret),
        hasMpin: !!acc.mpin,
      }));
      res.json(accounts);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create or Update account
  app.post("/api/accounts", async (req, res) => {
    try {
      const { id, nickname, role, mobileNumber, ucc, mpin, consumerKey, totpSecret, multiplier } = req.body;

      if (!nickname || !role || !mobileNumber) {
        return res.status(400).json({ error: "Missing required fields (nickname, role, mobileNumber)" });
      }

      const accounts = await getAccounts();
      if (role === "master") {
        const existingMaster = accounts.find((a) => a.role === "master" && a.id !== id);
        if (existingMaster) {
          return res.status(400).json({
            error: `Only one Master account is allowed. '${existingMaster.nickname}' is currently configured as Master.`,
          });
        }
      }

      let existingAcc: KotakAccount | undefined;
      if (id) {
        existingAcc = accounts.find((a) => a.id === id);
      }

      const account: KotakAccount = {
        id: id || `ACC_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        nickname,
        role,
        mobileNumber,
        ucc: ucc || existingAcc?.ucc || "",
        mpin: mpin || existingAcc?.mpin || "",
        consumerKey: consumerKey || existingAcc?.consumerKey || "",
        totpSecret: totpSecret?.replace(/\s+/g, "") || existingAcc?.totpSecret || "",
        multiplier: multiplier !== undefined ? Number(multiplier) : (existingAcc?.multiplier ?? 1.0),
        status: existingAcc?.status || "disconnected",
        lastLogin: existingAcc?.lastLogin || null,
        accessToken: existingAcc?.accessToken || null,
        sid: existingAcc?.sid || null,
        neoToken: existingAcc?.neoToken || null,
        rid: existingAcc?.rid || null,
        hsServerId: existingAcc?.hsServerId || null,
        dataCenter: existingAcc?.dataCenter || null,
        baseUrl: existingAcc?.baseUrl || null,
        errorMessage: existingAcc?.errorMessage || null,
        createdAt: existingAcc?.createdAt || new Date().toISOString(),
      };

      await saveAccount(account);
      res.json({ success: true, accountId: account.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete account
  app.delete("/api/accounts/:id", async (req, res) => {
    try {
      await deleteAccount(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Login a specific account
  app.post("/api/accounts/:id/login", async (req, res) => {
    try {
      const { id } = req.params;
      const { manualOtp } = req.body;
      const accounts = await getAccounts();
      const account = accounts.find((a) => a.id === id);

      if (!account) {
        return res.status(404).json({ error: "Account not found" });
      }

      const authResult = await authenticateKotakAccount(account, manualOtp);

      if (authResult.success) {
        account.status = "active";
        account.accessToken = authResult.accessToken || null;
        account.sid = authResult.sid || null;
        account.neoToken = authResult.neoToken || null;
        account.rid = authResult.rid || null;
        account.hsServerId = authResult.hsServerId || null;
        account.dataCenter = authResult.dataCenter || null;
        account.baseUrl = authResult.baseUrl || null;
        account.lastLogin = new Date().toISOString();
        account.errorMessage = null;
      } else {
        account.status = "error";
        account.errorMessage = authResult.error || "Authentication failed";
      }

      await saveAccount(account);

      // After successful login, try to connect market feed
      if (authResult.success) {
        connectMarketFeed();
      }

      res.json({
        success: authResult.success,
        status: account.status,
        error: account.errorMessage,
        lastLogin: account.lastLogin,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Generate real-time preview TOTP code
  app.get("/api/accounts/:id/totp-preview", async (req, res) => {
    try {
      const { id } = req.params;
      const account = (await getAccounts()).find((a) => a.id === id);
      if (!account || !hasAutoTotpSecret(account.totpSecret)) {
        return res.status(400).json({ error: "Reusable TOTP secret not found" });
      }
      const code = generateTOTP(account.totpSecret);
      res.json({ code });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Batch login / refresh sessions
  app.post("/api/accounts/refresh-all", async (req, res) => {
    try {
      const accounts = await getAccounts();

      const refreshPromises = accounts.map(async (account) => {
        if (!hasAutoTotpSecret(account.totpSecret)) {
          return { id: account.id, nickname: account.nickname, success: false, error: "Current TOTP required for this account" };
        }

        try {
          const authResult = await authenticateKotakAccount(account);
          if (authResult.success) {
            account.status = "active";
            account.accessToken = authResult.accessToken || null;
            account.sid = authResult.sid || null;
            account.neoToken = authResult.neoToken || null;
            account.rid = authResult.rid || null;
            account.hsServerId = authResult.hsServerId || null;
            account.dataCenter = authResult.dataCenter || null;
            account.baseUrl = authResult.baseUrl || null;
            account.lastLogin = new Date().toISOString();
            account.errorMessage = null;
          } else {
            account.status = "error";
            account.errorMessage = authResult.error || "Session expired / Login failed";
          }
          await saveAccount(account);
          return { id: account.id, nickname: account.nickname, success: authResult.success, error: account.errorMessage };
        } catch (err: any) {
          account.status = "error";
          account.errorMessage = err.message || String(err);
          await saveAccount(account);
          return { id: account.id, nickname: account.nickname, success: false, error: account.errorMessage };
        }
      });

      const results = await Promise.all(refreshPromises);

      // Connect market feed after refreshing sessions
      connectMarketFeed();

      res.json({ success: true, results });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get Order logs
  app.get("/api/orders", async (req, res) => {
    try {
      res.json(await getOrders());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Replicate and execute F&O order
  app.post("/api/orders/replicate", async (req, res) => {
    try {
      const { symbol, instrument, optionType, strikePrice, expiry, quantity, price, triggerPrice, orderType, transactionType } = req.body;

      if (!symbol || !instrument || !quantity || !transactionType || !orderType) {
        return res.status(400).json({ error: "Missing core trading details" });
      }

      const result = await replicateMasterTrade({
        symbol,
        instrument,
        optionType: optionType || "EQ",
        strikePrice: strikePrice ? Number(strikePrice) : 0,
        expiry: expiry || "",
        quantity: Number(quantity),
        price: price ? Number(price) : 0,
        triggerPrice: triggerPrice ? Number(triggerPrice) : 0,
        orderType: orderType || "MARKET",
        transactionType: transactionType || "BUY",
      });

      res.json({
        success: result.masterOrder.status === "SUCCESS" || result.masterOrder.status === "PENDING",
        masterOrder: result.masterOrder,
        slaveOrders: result.slaveOrders,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Cancel a pending order
  app.post("/api/orders/:orderId/cancel", async (req, res) => {
    try {
      const { orderId } = req.params;
      const allOrders = await getOrders();
      const order = allOrders.find((o) => o.id === orderId);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      if (order.status !== "PENDING") {
        return res.status(400).json({ error: `Cannot cancel order with status: ${order.status}` });
      }

      const accounts = await getAccounts();
      const acc = accounts.find((a) => a.id === order.accountId);
      if (!acc) {
        return res.status(404).json({ error: "Account not found for this order" });
      }

      const result = await cancelNeoOrder(acc, orderId);
      if (!result.success) {
        return res.status(500).json({ error: result.error || "Failed to cancel order" });
      }

      await updateOrderStatus(orderId, "CANCELLED", "Cancelled by user");
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Sync status of all PENDING orders from broker order book
  app.post("/api/orders/sync-status", async (req, res) => {
    try {
      const allOrders = await getOrders();
      const pendingOrders = allOrders.filter((o) => o.status === "PENDING");

      if (pendingOrders.length === 0) {
        return res.json({ updated: 0, orders: allOrders });
      }

      const accounts = await getAccounts();
      let updatedCount = 0;

      // Group pending orders by accountId to minimize API calls
      const ordersByAccount: Record<string, typeof pendingOrders> = {};
      for (const order of pendingOrders) {
        if (!ordersByAccount[order.accountId]) {
          ordersByAccount[order.accountId] = [];
        }
        ordersByAccount[order.accountId].push(order);
      }

      for (const [accountId, accountOrders] of Object.entries(ordersByAccount)) {
        const acc = accounts.find((a) => a.id === accountId);
        if (!acc || acc.status !== "active") continue;

        for (const order of accountOrders) {
          const liveStatus = await getOrderLiveStatus(acc, order.id);
          if (liveStatus && liveStatus.status !== "PENDING") {
            const errorMsg = liveStatus.status === "FAILED"
              ? (liveStatus.rejReason || "Rejected by exchange")
              : liveStatus.status === "CANCELLED"
                ? (liveStatus.cancelReason || "Cancelled")
                : null;
            await updateOrderStatus(
              order.id,
              liveStatus.status as any,
              errorMsg
            );
            updatedCount++;
          }
        }
      }

      const updatedOrders = await getOrders();
      res.json({ updated: updatedCount, orders: updatedOrders });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Fetch Margins / Funds of active accounts
  app.get("/api/accounts/margins", async (req, res) => {
    try {
      const accounts = (await getAccounts()).filter((a) => a.status === "active");

      const marginPromises = accounts.map(async (acc) => {
        try {
          const limits = await getNeoAccountLimits(acc);

          const net = Number(limits.Net !== undefined ? limits.Net : (limits.net !== undefined ? limits.net : 0));
          const marginUsed = Number(limits.MarginUsed !== undefined ? limits.MarginUsed : (limits.marginUsed !== undefined ? limits.marginUsed : 0));
          const rawCollateral = Number(limits.CollateralValue !== undefined ? limits.CollateralValue : (limits.collateralValue !== undefined ? limits.collateralValue : 0));

          // Clamp collateral value to zero if broker returns a negative number (e.g. to reflect account debit)
          const collateral = Math.max(0, rawCollateral);

          const realizedPL = Number(limits.RealizedMtomPrsnt !== undefined ? limits.RealizedMtomPrsnt : (limits.realizedMtomPrsnt !== undefined ? limits.realizedMtomPrsnt : 0));
          const unrealizedPL = Number(limits.UnrealizedMtomPrsnt !== undefined ? limits.UnrealizedMtomPrsnt : (limits.unrealizedMtomPrsnt !== undefined ? limits.unrealizedMtomPrsnt : 0));

          // Calculate cash/ledger balance
          const cashBalance = net + marginUsed - collateral;

          return {
            accountId: acc.id,
            accountName: acc.nickname,
            role: acc.role,
            cashBalance,
            utilMargin: marginUsed,
            availableMargin: net,
            collateral,
            realizedPL,
            unrealizedPL,
          };
        } catch (e: any) {
          return {
            accountId: acc.id,
            accountName: acc.nickname,
            role: acc.role,
            error: e.message || "Failed to fetch margins",
            cashBalance: 0,
            utilMargin: 0,
            availableMargin: 0,
            collateral: 0,
            realizedPL: 0,
            unrealizedPL: 0,
          };
        }
      });

      const results = await Promise.all(marginPromises);
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Fetch Positions of active accounts
  app.get("/api/accounts/positions", async (req, res) => {
    try {
      const accounts = (await getAccounts()).filter((a) => a.status === "active");

      const positionPromises = accounts.map(async (acc) => {
        try {
          const rawPositions = await getNeoAccountPositions(acc);
          const positionsList = Array.isArray(rawPositions) ? rawPositions : [];
          const formatted = positionsList.map((p: any) => ({
            symbol: p.trdSym || p.tradingSymbol || p.symbol || "",
            scriptToken: String(p.scrpCd || p.token || p.instrumentToken || ""),
            segment: p.prdCd || p.product || "",
            exchange: p.exch || p.exchange || "NSE",
            netQty: Number(p.flQty !== undefined ? p.flQty : (p.netQty !== undefined ? p.netQty : 0)),
            buyQty: Number(p.buyQty || 0),
            sellQty: Number(p.sellQty || 0),
            buyAvg: Number(p.buyAvg || p.buyAvgRate || p.buyRate || 0),
            sellAvg: Number(p.sellAvg || p.sellAvgRate || p.sellRate || 0),
            actvLtp: Number(p.actvLtp || p.ltp || p.lastPrice || 0),
          }));
          return {
            accountId: acc.id,
            accountName: acc.nickname,
            role: acc.role,
            positions: formatted,
          };
        } catch (e: any) {
          return {
            accountId: acc.id,
            accountName: acc.nickname,
            role: acc.role,
            error: e.message || "Failed to fetch positions",
            positions: [],
          };
        }
      });

      const results = await Promise.all(positionPromises);
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Exit a specific position for an account
  app.post("/api/positions/exit", async (req, res) => {
    try {
      const { accountId, symbol, quantity, segment, exchange } = req.body;
      if (!accountId || !symbol || quantity === undefined) {
        return res.status(400).json({ error: "Missing required details to exit position" });
      }

      const qty = Number(quantity);
      if (qty === 0) {
        return res.json({ success: true, message: "Position already flat" });
      }

      const accounts = await getAccounts();
      const acc = accounts.find((a) => a.id === accountId);
      if (!acc) {
        return res.status(404).json({ error: "Account not found" });
      }

      const transactionType: "BUY" | "SELL" = qty > 0 ? "SELL" : "BUY";
      const targetQty = Math.abs(qty);

      const result = await executeNeoOrder(acc, {
        symbol,
        instrument: "CUSTOM",
        optionType: segment || "MIS",
        strikePrice: 0,
        expiry: "",
        quantity: targetQty,
        price: 0,
        orderType: "MARKET",
        transactionType,
      });

      if (!result.success) {
        return res.status(500).json({ error: result.error || "Failed to place square off order" });
      }

      // Log the exit order
      const exitOrder = {
        id: result.orderId || `EXIT_ERR_${Date.now()}`,
        masterOrderId: null,
        accountId: acc.id,
        accountName: acc.nickname,
        accountRole: acc.role,
        symbol,
        instrument: "CUSTOM",
        optionType: segment || "MIS",
        strikePrice: 0,
        expiry: "",
        quantity: targetQty,
        price: 0,
        orderType: "MARKET" as const,
        transactionType,
        status: "SUCCESS" as const,
        errorMessage: null,
        timestamp: new Date().toISOString(),
        isSimulated: false,
      };
      await saveOrder(exitOrder);

      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Emergency Exit All positions for all active accounts
  app.post("/api/positions/exit-all", async (req, res) => {
    try {
      const accounts = (await getAccounts()).filter((a) => a.status === "active");

      // Stage 1: Fetch positions for all accounts concurrently
      const fetchPromises = accounts.map(async (acc) => {
        try {
          const rawPositions = await getNeoAccountPositions(acc);
          const positionsList = Array.isArray(rawPositions) ? rawPositions : [];
          const activePositions = positionsList.filter((p: any) => {
            const qty = Number(p.flQty !== undefined ? p.flQty : (p.netQty !== undefined ? p.netQty : 0));
            return qty !== 0;
          });
          return { acc, activePositions, error: null };
        } catch (e: any) {
          return { acc, activePositions: [], error: e.message || "Failed to fetch positions" };
        }
      });

      const positionResults = await Promise.all(fetchPromises);

      // Stage 2: Create a flat list of concurrent exit operations
      const exitOperations: Promise<{ accountId: string; success: boolean; error?: string }>[] = [];
      const accountResultsMap: Record<string, { accountName: string; exits: any[]; error?: string }> = {};

      for (const resItem of positionResults) {
        const { acc, activePositions, error } = resItem;
        accountResultsMap[acc.id] = {
          accountName: acc.nickname,
          exits: [],
          error: error || undefined,
        };

        if (error) continue;

        for (const p of activePositions) {
          const qty = Number(p.flQty !== undefined ? p.flQty : (p.netQty !== undefined ? p.netQty : 0));
          const symbol = p.trdSym || p.tradingSymbol || p.symbol || "";
          const segment = p.prdCd || p.product || "MIS";
          const transactionType: "BUY" | "SELL" = qty > 0 ? "SELL" : "BUY";
          const targetQty = Math.abs(qty);

          const exitPromise = (async () => {
            console.log(`[EmergencyExit] Squaring off ${symbol} (${qty}) on account ${acc.nickname}...`);
            try {
              const orderResult = await executeNeoOrder(acc, {
                symbol,
                instrument: "CUSTOM",
                optionType: segment,
                strikePrice: 0,
                expiry: "",
                quantity: targetQty,
                price: 0,
                orderType: "MARKET",
                transactionType,
              });

              if (orderResult.success) {
                const exitOrder = {
                  id: orderResult.orderId || `EXIT_ERR_${Date.now()}`,
                  masterOrderId: null,
                  accountId: acc.id,
                  accountName: acc.nickname,
                  accountRole: acc.role,
                  symbol,
                  instrument: "CUSTOM",
                  optionType: segment,
                  strikePrice: 0,
                  expiry: "",
                  quantity: targetQty,
                  price: 0,
                  orderType: "MARKET" as const,
                  transactionType,
                  status: "SUCCESS" as const,
                  errorMessage: null,
                  timestamp: new Date().toISOString(),
                  isSimulated: false,
                };
                await saveOrder(exitOrder);
                accountResultsMap[acc.id].exits.push({ symbol, success: true, orderId: orderResult.orderId });
                return { accountId: acc.id, success: true };
              } else {
                accountResultsMap[acc.id].exits.push({ symbol, success: false, error: orderResult.error });
                return { accountId: acc.id, success: false, error: orderResult.error };
              }
            } catch (err: any) {
              accountResultsMap[acc.id].exits.push({ symbol, success: false, error: err.message || String(err) });
              return { accountId: acc.id, success: false, error: err.message || String(err) };
            }
          })();

          exitOperations.push(exitPromise);
        }
      }

      // Execute all exits in parallel
      const exitResults = await Promise.all(exitOperations);
      const totalExits = exitResults.filter((r) => r.success).length;

      const finalDetails = Object.values(accountResultsMap);
      res.json({ success: true, totalExits, details: finalDetails });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Scrip Search ──────────────────────────────────────────────────────────
  app.get("/api/search", async (req, res) => {
    try {
      const q = (req.query.q as string) || "";
      const result = await searchScrips(q);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/scrips/status", async (req, res) => {
    try {
      if (!isScripMasterLoaded()) {
        await loadScripMasterCache();
      }
      res.json({
        loaded: isScripMasterLoaded(),
        count: getScripMasterCount(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/scrips/load", async (req, res) => {
    try {
      const result = await loadScripMasterCache(true);
      if (!result.success) {
        return res.status(500).json({ error: result.error || "Failed to load scrip master" });
      }
      res.json({ success: true, loaded: result.loaded, count: result.count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Watchlist CRUD ────────────────────────────────────────────────────────
  const { getWatchlist, addToWatchlist, removeFromWatchlist } = await import("./server/db");

  app.get("/api/watchlist", async (req, res) => {
    try {
      res.json(await getWatchlist());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/watchlist", async (req, res) => {
    try {
      const item: WatchlistItem = {
        scriptToken: req.body.scriptToken,
        tradingSymbol: req.body.tradingSymbol,
        exchange: req.body.exchange,
        instrumentName: req.body.instrumentName,
        segment: req.body.segment,
        strikePrice: Number(req.body.strikePrice) || 0,
        expiry: req.body.expiry || "",
        lotSize: Number(req.body.lotSize) || 1,
        addedAt: new Date().toISOString(),
      };
      if (!item.scriptToken || !item.tradingSymbol) {
        return res.status(400).json({ error: "scriptToken and tradingSymbol are required" });
      }
      await addToWatchlist(item);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/watchlist/:scriptToken", async (req, res) => {
    try {
      await removeFromWatchlist(req.params.scriptToken);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Market feed status ────────────────────────────────────────────────────
  app.get("/api/feed/status", (req, res) => {
    res.json({ connected: isMarketFeedConnected() });
  });

  // ── Live Quote Stream (Server-Sent Events) ────────────────────────────────
  // Client connects with ?tokens=TOKEN1,TOKEN2,...
  // Server subscribes to the real WebSocket and relays price ticks via SSE.
  app.get("/api/quotes/stream", (req, res) => {
    const tokensParam = (req.query.tokens as string) || "";
    const requestedTokens = tokensParam.split(",").filter(Boolean);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Subscribe to the requested tokens on the WebSocket
    if (requestedTokens.length > 0) {
      subscribeTokens(requestedTokens);
    }

    // Send last known prices immediately
    const lastPrices = getLastPrices();
    const initialPrices: Record<string, { ltp: number; change: number; changePct: number }> = {};
    for (const token of requestedTokens) {
      if (lastPrices[token]) {
        initialPrices[token] = {
          ltp: lastPrices[token].ltp,
          change: lastPrices[token].change,
          changePct: lastPrices[token].changePct,
        };
      }
    }
    if (Object.keys(initialPrices).length > 0) {
      res.write(`data: ${JSON.stringify(initialPrices)}\n\n`);
    }

    // Listen for real price ticks and relay to this SSE client
    const unsubscribe = onPriceTick((tick: QuoteTick) => {
      if (requestedTokens.includes(tick.token)) {
        const priceData: Record<string, { ltp: number; change: number; changePct: number }> = {
          [tick.token]: {
            ltp: tick.ltp,
            change: tick.change,
            changePct: tick.changePct,
          },
        };
        try {
          res.write(`data: ${JSON.stringify(priceData)}\n\n`);
        } catch (_) {
          // Client disconnected
        }
      }
    });

    // Clean up on disconnect
    req.on("close", () => {
      unsubscribe();
      if (requestedTokens.length > 0) {
        unsubscribeTokens(requestedTokens);
      }
    });
  });

  // --- API ROOT HEALTH CHECK ---
  app.get("/", (req, res) => {
    res.json({ status: "running", name: "neo-copier-backend" });
  });

  app.listen(PORT, "0.0.0.0", async () => {
    const localIP = getLocalIP();
    console.log(`\n  App running at:`);
    console.log(`  → Local:   http://localhost:${PORT}`);
    console.log(`  → Network: http://${localIP}:${PORT}\n`);
    console.log(`  Open the Network URL on your mobile (same WiFi).\n`);

    // Try to auto-connect market feed if any account is already active
    const accounts = await getAccounts();
    if (accounts.some((a) => a.status === "active" && a.neoToken)) {
      connectMarketFeed();
    }
  });
}

startServer().catch((err) => {
  console.error("Critical error starting application server:", err);
});
