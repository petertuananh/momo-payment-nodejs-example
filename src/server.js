import "dotenv/config";

import express from "express";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MomoApiError,
  MomoClient,
  MomoError,
  MOMO_SANDBOX_URL
} from "momo-payment";

const app = express();
const port = Number(process.env.PORT || 3000);
const transactions = new Map();
const viewsPath = fileURLToPath(new URL("../views", import.meta.url));
const publicPath = fileURLToPath(new URL("../public", import.meta.url));
const momoEndpoint = (process.env.MOMO_ENDPOINT || MOMO_SANDBOX_URL)
  .replace(/\/v2\/gateway\/api\/?$/, "");

const requiredEnv = ["MOMO_PARTNER_CODE", "MOMO_ACCESS_KEY", "MOMO_SECRET_KEY"];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  throw new Error(`Missing environment variables: ${missingEnv.join(", ")}`);
}

const momo = new MomoClient({
  partnerCode: process.env.MOMO_PARTNER_CODE,
  accessKey: process.env.MOMO_ACCESS_KEY,
  secretKey: process.env.MOMO_SECRET_KEY,
  endpoint: momoEndpoint,
  timeoutMs: 30_000
});

let publicBaseUrl = process.env.APP_BASE_URL?.replace(/\/$/, "") || "";
let tunnel;
const debugEnabled = process.env.MOMO_DEBUG !== "false";

app.set("view engine", "ejs");
app.set("views", viewsPath);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(publicPath));

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    debug("HTTP request", {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      contentType: req.headers["content-type"] || null
    });
  });
  next();
});

app.use((req, res, next) => {
  res.locals.tmnCode = process.env.MOMO_PARTNER_CODE;
  res.locals.publicBaseUrl = publicBaseUrl;
  res.locals.environment = momoEndpoint === MOMO_SANDBOX_URL
    ? "Sandbox"
    : "Production";
  next();
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "momo-payment-nodejs-example",
    publicBaseUrl: publicBaseUrl || null,
    ipnUrl: publicBaseUrl ? `${publicBaseUrl}/payments/momo/ipn` : null,
    timestamp: new Date().toISOString()
  });
});

function createOrderId() {
  return `DEMO_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function getBaseUrl(req) {
  return publicBaseUrl || `${req.protocol}://${req.get("host")}`;
}

function debug(message, details) {
  if (!debugEnabled) {
    return;
  }
  const prefix = `[${new Date().toISOString()}] [momo-example]`;
  if (details === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }
  console.log(`${prefix} ${message}`, details);
}

function withoutSignature(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const { signature, ...safePayload } = payload;
  return safePayload;
}

function getSignatureDiagnostics(payload) {
  const signature = payload?.signature;
  return {
    hasSignature: typeof signature === "string" && signature.length > 0,
    signatureLength: typeof signature === "string" ? signature.length : 0
  };
}

const pendingIpnResultCodes = new Set([1000, 7000, 7002, 9000]);
const terminalTransactionStatuses = new Set(["SUCCESS", "FAILED", "AUTHORIZED"]);

function getIpnTransactionStatus(resultCode) {
  if (resultCode === 0) {
    return "SUCCESS";
  }
  if (resultCode === 9000) {
    return "AUTHORIZED";
  }
  if (pendingIpnResultCodes.has(resultCode)) {
    return "PENDING";
  }
  return "FAILED";
}

function normalizeError(error) {
  if (error instanceof MomoApiError) {
    const resultCode = error.response?.resultCode ?? "UNKNOWN";
    const message = error.response?.message
      || error.response?.detail
      || error.response?.title
      || error.message
      || "MoMo API request failed";
    const status = error.response?.resultCode === undefined && error.status
      ? `HTTP ${error.status}`
      : resultCode;
    return `${status}: ${message}`;
  }
  if (error instanceof MomoError) {
    return `${error.code || "MOMO_ERROR"}: ${error.message || "MoMo request failed"}`;
  }
  return error instanceof Error ? error.message : "Unknown error";
}

app.get("/", (req, res) => {
  res.render("index", {
    transactions: [...transactions.values()].sort((a, b) => b.createdAt - a.createdAt),
    message: req.query.message,
    error: req.query.error
  });
});

app.post("/payments/momo/create", async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return res.redirect("/?error=" + encodeURIComponent("Số tiền phải là số nguyên dương VND."));
  }

  const orderId = createOrderId();
  const baseUrl = getBaseUrl(req);
  const transaction = {
    orderId,
    amount,
    orderInfo: req.body.orderInfo?.trim() || `Thanh toán đơn hàng ${orderId}`,
    status: "PENDING",
    createdAt: Date.now()
  };
  transactions.set(orderId, transaction);
  const paymentOptions = {
    orderId,
    amount,
    orderInfo: transaction.orderInfo,
    redirectUrl: `${baseUrl}/payments/momo/return`,
    ipnUrl: `${baseUrl}/payments/momo/ipn`
  };
  const request = momo.buildCreatePaymentRequest(paymentOptions);
  debug("createPayment request", withoutSignature(request));

  try {
    const payment = await momo.createPayment(paymentOptions);
    transaction.payUrl = payment.payUrl;
    debug("createPayment response", {
      orderId,
      resultCode: payment.resultCode,
      message: payment.message,
      hasPayUrl: Boolean(payment.payUrl)
    });
    return res.redirect(payment.payUrl);
  } catch (error) {
    transaction.status = "CREATE_FAILED";
    transaction.error = normalizeError(error);
    console.error("[momo-example] createPayment failed", {
      orderId,
      error: transaction.error,
      details: error
    });
    return res.redirect("/?error=" + encodeURIComponent(transaction.error));
  }
});

app.get("/payments/momo/return", (req, res) => {
  debug("MoMo return callback", withoutSignature(req.query));
  const orderId = req.query.orderId;
  const transaction = transactions.get(orderId);
  if (transaction) {
    transaction.returnPayload = req.query;
    transaction.status = Number(req.query.resultCode) === 0 ? "RETURN_SUCCESS" : "RETURN_FAILED";
  }
  return res.render("return", { payload: req.query, transaction });
});

app.post("/payments/momo/ipn", (req, res) => {
  console.log("[momo-example] IPN received", withoutSignature(req.body));
  debug("MoMo IPN received", {
    contentType: req.headers["content-type"] || null,
    signature: getSignatureDiagnostics(req.body),
    payload: withoutSignature(req.body)
  });
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ success: false, message: "Invalid IPN payload" });
  }
  if (req.body.partnerCode !== process.env.MOMO_PARTNER_CODE) {
    return res.status(400).json({ success: false, message: "Partner code mismatch" });
  }
  if (!momo.verifySignature(req.body)) {
    console.error("[momo-example] IPN signature validation failed", {
      orderId: req.body?.orderId,
      signature: getSignatureDiagnostics(req.body),
      payload: withoutSignature(req.body)
    });
    const message = getSignatureDiagnostics(req.body).hasSignature
      ? "Invalid MoMo signature"
      : "Missing MoMo signature";
    return res.status(400).json({ success: false, message });
  }

  const transaction = transactions.get(req.body.orderId);
  if (!transaction) {
    return res.status(404).json({ success: false, message: "Unknown orderId" });
  }
  if (transaction.amount !== Number(req.body.amount)) {
    return res.status(400).json({ success: false, message: "Amount mismatch" });
  }

  transaction.ipnPayload = req.body;
  const resultCode = Number(req.body.resultCode);
  if (!terminalTransactionStatuses.has(transaction.status)) {
    transaction.status = getIpnTransactionStatus(resultCode);
  }
  transaction.resultCode = resultCode;
  transaction.resultMessage = req.body.message;
  transaction.transId = req.body.transId;
  transaction.updatedAt = Date.now();
  debug("MoMo IPN processed", {
    orderId: transaction.orderId,
    resultCode,
    status: transaction.status
  });
  return res.status(204).end();
});

app.post("/transactions/:orderId/query", async (req, res) => {
  const { orderId } = req.params;
  const transaction = transactions.get(orderId);
  if (!transaction) {
    return res.redirect("/?error=" + encodeURIComponent("Không tìm thấy giao dịch."));
  }

  try {
    debug("queryTransaction request", { orderId, requestId: `QUERY_${orderId}` });
    const result = await momo.queryTransaction({
      requestId: `QUERY_${orderId}`,
      orderId,
      lang: "vi"
    });
    transaction.queryPayload = result;
    transaction.status = Number(result.resultCode) === 0 ? "SUCCESS" : `MOMO_${result.resultCode}`;
    debug("queryTransaction response", {
      orderId,
      resultCode: result.resultCode,
      message: result.message,
      transId: result.transId
    });
    return res.redirect("/?message=" + encodeURIComponent(`Query ${orderId}: ${result.message}`));
  } catch (error) {
    const message = normalizeError(error);
    console.error("[momo-example] queryTransaction failed", { orderId, error: message, details: error });
    return res.redirect("/?error=" + encodeURIComponent(message));
  }
});

app.get("/api/transactions/:orderId", (req, res) => {
  const transaction = transactions.get(req.params.orderId);
  return transaction
    ? res.json(transaction)
    : res.status(404).json({ message: "Transaction not found" });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).render("error", { error: normalizeError(error) });
});

const server = app.listen(port, async () => {
  console.log(`MoMo example listening at http://localhost:${port}`);
  if (process.env.TUNNEL_ENABLED !== "true" || publicBaseUrl) {
    console.log(`Public callback base URL: ${publicBaseUrl || "(local only)"}`);
    return;
  }

  try {
    tunnel = spawn("ssh", [
      "-o", "StrictHostKeyChecking=no",
      "-o", "ServerAliveInterval=60",
      "-R", `80:localhost:${port}`,
      "nokey@localhost.run"
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const tunnelOutput = (chunk) => {
      const output = chunk.toString();
      const url = output.match(/https:\/\/[a-z0-9-]+\.lhr\.life/i)?.[0];
      if (!url || publicBaseUrl) {
        return;
      }
      publicBaseUrl = url;
      debug("localhost.run connected", { publicBaseUrl });
      console.log(`Public callback base URL: ${publicBaseUrl}`);
      console.log(`IPN URL: ${publicBaseUrl}/payments/momo/ipn`);
    };
    tunnel.stdout.on("data", tunnelOutput);
    tunnel.stderr.on("data", tunnelOutput);
    tunnel.on("close", (code) => {
      if (publicBaseUrl) {
        publicBaseUrl = "";
      }
      console.error(`localhost.run tunnel closed${code === null ? "" : ` (code ${code})`}.`);
    });
    tunnel.on("error", (error) => {
      console.error(`Could not start localhost.run: ${normalizeError(error)}`);
      console.error("Install OpenSSH or set APP_BASE_URL/TUNNEL_ENABLED=false.");
    });
  } catch (error) {
    console.error(`Could not start localhost.run: ${normalizeError(error)}`);
    console.error("Install OpenSSH or set APP_BASE_URL/TUNNEL_ENABLED=false.");
  }
});

function shutdown() {
  tunnel?.kill();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
