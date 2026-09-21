import cors from "cors";
import { config } from "dotenv";
import express from "express";
import multer from "multer";
import {
  FinanceEntryType,
  LogLevel,
  LogType,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  SaleType,
  StockMovementType,
  UserRole as PrismaUserRole
} from "@prisma/client";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { prisma } from "./db/client.js";
import { startKeepAlive } from "./keepAlive.js";
import { emitInventoryUpdated, emitOrderStatusUpdated, emitProductUpdated, setupRealtime } from "./realtime/socket.js";
import { createOrderWithStockReservation } from "./services/orders.service.js";
import { id, snapshot, transact, type Customer, type Order, type ProductCategory, type SystemLog, type User, type UserRole } from "./store.js";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

const app = express();
const httpServer = createServer(app);
const port = Number(process.env.PORT ?? 3333);
const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
const businessWhatsapp = process.env.BUSINESS_WHATSAPP ?? "";
const authSecret = process.env.AUTH_SECRET ?? process.env.REMOVAL_KEY ?? "pedidos-pro-secret";
const uploadRoot = resolve(process.env.UPLOAD_DIR ?? "./uploads");
const productUploadDir = resolve(uploadRoot, "products");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype.startsWith("image/")) return callback(new AppError("Arquivo selecionado nao e uma imagem"));
    callback(null, true);
  }
});

app.use(cors({ origin: [frontendUrl, "http://localhost:5173"], credentials: true }));
app.use(express.json({ limit: "8mb" }));
app.use("/uploads", express.static(uploadRoot));

class AppError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const asyncHandler =
  (handler: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

const money = z.coerce.number().nonnegative();
const upper = (value: string) => value.toLocaleUpperCase("pt-BR");
const normalizeText = (value: string) => upper(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const upperString = z.string().transform(upper);

const allPermissions = [
  "home.view",
  "dashboard.view",
  "products.view",
  "products.create",
  "products.edit",
  "categories.view",
  "categories.create",
  "categories.edit",
  "stock.view",
  "stock.move",
  "finance.view",
  "finance.create",
  "orders.view",
  "orders.create",
  "orders.edit",
  "orders.delete",
  "orders.receive",
  "customerOrders.manage",
  "clientPage.view",
  "clientPage.manage",
  "customers.view",
  "customers.create",
  "customers.edit",
  "users.manage",
  "logs.view"
];

const roleFromDb = (role: PrismaUserRole): UserRole => role === "ADMIN" ? "admin" : role === "CLIENTE" ? "cliente" : "usuario";
const roleToDb = (role: UserRole) => role === "admin" ? PrismaUserRole.ADMIN : role === "cliente" ? PrismaUserRole.CLIENTE : PrismaUserRole.USUARIO;
const movementFromDb = (type: StockMovementType) => type === "IN" ? "in" : type === "OUT" ? "out" : "adjustment";
const movementToDb = (type: "in" | "out" | "adjustment") => type === "in" ? StockMovementType.IN : type === "out" ? StockMovementType.OUT : StockMovementType.ADJUSTMENT;
const financeFromDb = (type: FinanceEntryType) => type === "EXPENSE" ? "expense" : type === "RECEIVABLE" ? "receivable" : "income";
const financeToDb = (type: "income" | "expense" | "receivable") => type === "expense" ? FinanceEntryType.EXPENSE : type === "receivable" ? FinanceEntryType.RECEIVABLE : FinanceEntryType.INCOME;
const saleTypeFromDb = (type: SaleType) => type === "AVULSO" ? "avulso" : "cliente";
const paymentFromDb = (method: PaymentMethod) => method === "DINHEIRO" ? "dinheiro" : method === "CARTAO" ? "cartao" : method === "FIADO" ? "fiado" : "pix";
const paymentStatusFromDb = (status: PaymentStatus) => status === "PARTIAL" ? "partial" : status === "PENDING" ? "pending" : "paid";
const orderStatusFromDb = (status: OrderStatus) => {
  if (status === "WAITING" || status === "OPEN") return "pending";
  if (status === "PREPARING") return "preparing";
  if (status === "READY") return "ready";
  if (status === "CANCELLED") return "cancelled";
  return "delivered";
};
const orderStatusToDb = (status: "pending" | "preparing" | "ready" | "delivered" | "cancelled") => {
  if (status === "preparing") return OrderStatus.PREPARING;
  if (status === "ready") return OrderStatus.READY;
  if (status === "delivered") return OrderStatus.DELIVERED;
  if (status === "cancelled") return OrderStatus.CANCELLED;
  return OrderStatus.WAITING;
};
const moneyValue = (value: Prisma.Decimal | number | null | undefined) => Number(value ?? 0);
const iso = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : undefined;

function mapUser(user: any): User {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: typeof user.role === "string" && user.role === user.role.toUpperCase() ? roleFromDb(user.role) : user.role,
    passwordHash: user.passwordHash,
    salt: user.salt,
    permissions: user.permissions ?? [],
    active: user.active,
    createdAt: iso(user.createdAt) ?? new Date().toISOString(),
    updatedAt: iso(user.updatedAt) ?? new Date().toISOString()
  };
}

function mapProduct(product: any) {
  return {
    ...product,
    costPrice: moneyValue(product.costPrice),
    salePrice: moneyValue(product.salePrice),
    manufactureDate: iso(product.manufactureDate) ?? "",
    expirationDate: iso(product.expirationDate) ?? "",
    createdAt: iso(product.createdAt),
    updatedAt: iso(product.updatedAt),
    lots: product.lots?.map(mapLot)
  };
}

function mapLot(lot: any) {
  return {
    ...lot,
    costPrice: moneyValue(lot.costPrice),
    totalCost: lot.totalCost === null ? undefined : moneyValue(lot.totalCost),
    salePrice: moneyValue(lot.salePrice),
    manufactureDate: iso(lot.manufactureDate) ?? "",
    expirationDate: iso(lot.expirationDate) ?? "",
    createdAt: iso(lot.createdAt)
  };
}

function mapCustomer(customer: any): Customer {
  return {
    ...customer,
    creditLimit: moneyValue(customer.creditLimit),
    cashbackBalance: moneyValue(customer.cashbackBalance),
    createdAt: iso(customer.createdAt) ?? new Date().toISOString(),
    updatedAt: iso(customer.updatedAt) ?? new Date().toISOString()
  };
}

function mapOrder(order: any) {
  return {
    id: order.id,
    source: order.source === "CLIENT_PAGE" ? "client_page" : "admin",
    saleType: saleTypeFromDb(order.saleType),
    customerId: order.customerId ?? undefined,
    customerName: order.customerName,
    customerPhone: order.customerPhone ?? "",
    paymentMethod: paymentFromDb(order.paymentMethod),
    paymentStatus: paymentStatusFromDb(order.paymentStatus),
    amountPaid: moneyValue(order.amountPaid),
    amountDue: moneyValue(order.amountDue),
    cashbackUsed: moneyValue(order.cashbackUsed),
    cashbackEarned: moneyValue(order.cashbackEarned),
    cashbackReleased: order.cashbackReleased,
    status: orderStatusFromDb(order.status),
    cancelledAt: iso(order.cancelledAt),
    cancelledBy: order.cancelledById ?? undefined,
    cancelledByName: order.cancelledByName ?? undefined,
    total: moneyValue(order.total),
    whatsappUrl: order.whatsappUrl ?? undefined,
    createdAt: iso(order.createdAt),
    items: (order.items ?? []).map((item: any) => ({
      id: item.id,
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: moneyValue(item.unitPrice),
      costPrice: item.costPrice === null ? undefined : moneyValue(item.costPrice),
      lotCode: item.lotCode ?? undefined,
      product: item.product ? mapProduct(item.product) : undefined
    }))
  };
}

const productSchema = z.object({
  name: z.string().min(2).transform(upper),
  sku: z.string().optional().default(""),
  categoryId: z.string().optional().default(""),
  brand: upperString.optional().default(""),
  productType: z.string().optional().default(""),
  manufactureDate: z.string().optional().default(""),
  expirationDate: z.string().optional().default(""),
  description: upperString.optional().nullable(),
  imageUrl: z.string().optional().nullable(),
  costPrice: money.default(0),
  salePrice: money,
  stock: z.coerce.number().int().min(0).default(0),
  minStock: z.coerce.number().int().min(0).default(0),
  onlineAvailable: z.boolean().default(true),
  active: z.boolean().default(true)
});

const categorySchema = z.object({
  name: z.string().min(2).transform(upper),
  description: upperString.optional().default(""),
  active: z.boolean().default(true)
});

const imageSearchSchema = z.object({
  q: z.string().min(2)
});

const imageImportSchema = z.object({
  url: z.string().url()
});

const financeSchema = z.object({
  type: z.enum(["income", "expense", "receivable"]),
  description: z.string().min(2).transform(upper),
  amount: money,
  category: z.string().optional()
});

const stockSchema = z.object({
  productId: z.string(),
  type: z.enum(["in", "out", "adjustment"]),
  quantity: z.coerce.number().int().positive(),
  totalCost: money.optional(),
  costPrice: money.optional(),
  salePrice: money.optional(),
  manufactureDate: z.string().optional().default(""),
  expirationDate: z.string().optional().default(""),
  note: z.string().optional()
});

const lotUpdateSchema = z.object({
  salePrice: money
});

const customerSchema = z.object({
  name: z.string().min(2).transform(upper),
  phone: z.string().optional().default(""),
  cpf: z.string().optional().default(""),
  email: upperString.optional().default(""),
  address: upperString.optional().default(""),
  notes: upperString.optional().default(""),
  creditLimit: money.default(10),
  cashbackBalance: money.optional()
});

const orderSchema = z.object({
  source: z.enum(["admin", "client_page"]).optional().default("admin"),
  saleType: z.enum(["avulso", "cliente"]).default("cliente"),
  customerId: z.string().optional(),
  customerName: upperString.optional().default(""),
  customerPhone: z.string().optional().default(""),
  customerCpf: z.string().optional().default(""),
  paymentMethod: z.enum(["dinheiro", "pix", "cartao", "fiado"]).default("pix"),
  amountPaid: money.optional(),
  useCashback: z.coerce.boolean().optional().default(false),
  items: z.array(z.object({
    productId: z.string(),
    quantity: z.coerce.number().int().positive()
  })).min(1)
});

const paymentSchema = z.object({
  amount: money
});

const deleteOrderSchema = z.object({
  removalKey: z.string().min(1)
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const userSchema = z.object({
  name: z.string().min(2).transform(upper),
  username: z.string().min(2),
  password: z.string().min(4).optional(),
  role: z.enum(["usuario", "cliente"]).default("usuario"),
  permissions: z.array(z.string()).default([]),
  active: z.boolean().default(true)
});

function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const passwordHash = createHmac("sha256", salt).update(password).digest("hex");
  return { salt, passwordHash };
}

function verifyPassword(password: string, user: User) {
  const expected = Buffer.from(user.passwordHash, "hex");
  const actual = Buffer.from(hashPassword(password, user.salt).passwordHash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function signToken(user: Pick<User, "id" | "role">) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, role: user.role, iat: Date.now() })).toString("base64url");
  const signature = createHmac("sha256", authSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyToken(token?: string) {
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  const expected = createHmac("sha256", authSecret).update(payload).digest("base64url");
  if (signature !== expected) return null;
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { id: string; role: UserRole };
}

function publicUser(user: User) {
  const { passwordHash: _passwordHash, salt: _salt, ...safe } = user;
  return { ...safe, permissions: user.role === "admin" ? allPermissions : user.permissions };
}

async function writeLog(log: Omit<SystemLog, "id" | "createdAt">) {
  await prisma.systemLog.create({
    data: {
      type: log.type === "login" ? LogType.LOGIN : LogType.ERROR,
      level: log.level === "error" ? LogLevel.ERROR : LogLevel.INFO,
      userId: log.userId,
      username: log.username,
      role: log.role ? roleToDb(log.role) : undefined,
      action: log.action,
      route: log.route,
      method: log.method,
      message: log.message
    }
  });
}

async function ensureAdminUser() {
  const admin = await prisma.user.findFirst({ where: { role: PrismaUserRole.ADMIN } });
  if (admin) return;
  const { salt, passwordHash } = hashPassword(process.env.ADMIN_PASSWORD ?? "admin123");
  await prisma.user.create({
    data: {
      name: process.env.ADMIN_NAME ?? "Administrador",
      username: process.env.ADMIN_USERNAME ?? "admin",
      role: PrismaUserRole.ADMIN,
      salt,
      passwordHash,
      permissions: allPermissions,
      active: true
    }
  });
}

const requireAuth: express.RequestHandler = asyncHandler(async (req, res, next) => {
  const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const session = verifyToken(token);
  if (!session) throw new AppError("Login necessario", 401);
  const dbUser = await prisma.user.findFirst({ where: { id: session.id, active: true } });
  const user = dbUser ? mapUser(dbUser) : undefined;
  if (!user) throw new AppError("Usuario inativo ou nao encontrado", 401);
  res.locals.user = user;
  next();
});

function requirePermission(permission: string): express.RequestHandler {
  return (_req, res, next) => {
    const user = res.locals.user as User | undefined;
    if (user?.role === "admin" || user?.permissions.includes(permission)) return next();
    next(new AppError("Permissao negada", 403));
  };
}

function requireAdmin(_req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = res.locals.user as User | undefined;
  if (user?.role === "admin") return next();
  next(new AppError("Apenas ADMIN pode executar esta acao", 403));
}

function slug(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "produto";
}

function imageExtension(contentType: string) {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  return "jpg";
}

async function saveProductImage(bytes: Buffer, contentType: string, name = "produto") {
  await mkdir(productUploadDir, { recursive: true });
  const filename = `${Date.now()}-${slug(name)}-${randomUUID()}.${imageExtension(contentType)}`;
  await writeFile(resolve(productUploadDir, filename), bytes);
  return `/uploads/products/${filename}`;
}

function skuPart(value: string, fallback: string) {
  const letters = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  return (letters || fallback).slice(0, 3).padEnd(3, fallback.slice(0, 1));
}

function nextSku(db: { products: Array<{ sku?: string }>; categories?: ProductCategory[] }, name: string, categoryId?: string, brand?: string) {
  const category = db.categories?.find((item) => item.id === categoryId);
  const prefix = `${skuPart(category?.name ?? "", "SEM")}-${skuPart(brand || name, "MAR")}-`;
  const last = db.products.reduce((max, product) => {
    if (!product.sku?.startsWith(prefix)) return max;
    const number = Number(product.sku.slice(prefix.length));
    return Number.isFinite(number) ? Math.max(max, number) : max;
  }, 0);
  return `${prefix}${String(last + 1).padStart(3, "0")}`;
}

function lotPrefixFromSku(sku: string) {
  const parts = sku.split("-").filter(Boolean);
  if (parts.length >= 2) return `LOTE-${parts[0]}-${parts[1]}-`;
  return `LOTE-${skuPart(sku, "PRO")}-`;
}

function nextLotCode(db: { products: Array<{ lotCode?: string }>; productLots?: Array<{ code: string }>; stockMovements: Array<{ lotCode?: string }> }, sku: string) {
  const prefix = lotPrefixFromSku(sku);
  const codes = [
    ...db.products.map((product) => product.lotCode),
    ...(db.productLots ?? []).map((lot) => lot.code),
    ...db.stockMovements.map((movement) => movement.lotCode)
  ].filter(Boolean) as string[];
  const last = codes.reduce((max, code) => {
    if (!code.startsWith(prefix)) return max;
    const number = Number(code.slice(prefix.length));
    return Number.isFinite(number) ? Math.max(max, number) : max;
  }, 0);
  return `${prefix}${String(last + 1).padStart(3, "0")}`;
}

async function nextSkuDb(name: string, categoryId?: string, brand?: string) {
  const category = categoryId ? await prisma.productCategory.findUnique({ where: { id: categoryId } }) : undefined;
  const prefix = `${skuPart(category?.name ?? "", "SEM")}-${skuPart(brand || name, "MAR")}-`;
  const products = await prisma.product.findMany({ where: { sku: { startsWith: prefix } }, select: { sku: true } });
  const last = products.reduce((max, product) => {
    const number = Number(product.sku.slice(prefix.length));
    return Number.isFinite(number) ? Math.max(max, number) : max;
  }, 0);
  return `${prefix}${String(last + 1).padStart(3, "0")}`;
}

async function nextLotCodeDb(sku: string) {
  const prefix = lotPrefixFromSku(sku);
  const [products, lots, movements] = await Promise.all([
    prisma.product.findMany({ where: { lotCode: { startsWith: prefix } }, select: { lotCode: true } }),
    prisma.productLot.findMany({ where: { code: { startsWith: prefix } }, select: { code: true } }),
    prisma.stockMovement.findMany({ where: { lotCode: { startsWith: prefix } }, select: { lotCode: true } })
  ]);
  const codes = [
    ...products.map((product) => product.lotCode),
    ...lots.map((lot) => lot.code),
    ...movements.map((movement) => movement.lotCode)
  ].filter(Boolean) as string[];
  const last = codes.reduce((max, code) => {
    const number = Number(code.slice(prefix.length));
    return Number.isFinite(number) ? Math.max(max, number) : max;
  }, 0);
  return `${prefix}${String(last + 1).padStart(3, "0")}`;
}

function cashbackDiscount(balance: number, total: number) {
  if (balance < 1) return 0;
  return Math.min(Math.floor(balance), Math.floor(total));
}

function maybeReleaseFiadoCashback(order: Order, customer?: Customer) {
  if (!customer || order.paymentMethod !== "fiado" || order.cashbackReleased || Number(order.amountDue ?? 0) > 0) return 0;
  const base = Math.max(Number(order.total) - Number(order.cashbackUsed ?? 0), 0);
  const earned = Number((base * 0.05).toFixed(2));
  customer.cashbackBalance = Number((Number(customer.cashbackBalance ?? 0) + earned).toFixed(2));
  order.cashbackEarned = Number((Number(order.cashbackEarned ?? 0) + earned).toFixed(2));
  order.cashbackReleased = true;
  return earned;
}

function whatsappUrl(orderId: string, customerName: string, lines: string[], total: number) {
  const message = [
    `Novo pedido #${orderId}`,
    `Cliente: ${customerName}`,
    "",
    ...lines,
    "",
    `Total: R$ ${total.toFixed(2)}`
  ].join("\n");

  return `https://wa.me/${businessWhatsapp}?text=${encodeURIComponent(message)}`;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.post("/auth/login", asyncHandler(async (req, res) => {
  await ensureAdminUser();
  const data = loginSchema.parse(req.body);
  const dbUser = await prisma.user.findFirst({
    where: { username: { equals: data.username, mode: "insensitive" }, active: true }
  });
  const user = dbUser ? mapUser(dbUser) : undefined;
  if (!user || !verifyPassword(data.password, user)) {
    await writeLog({
      type: "error",
      level: "error",
      username: data.username,
      action: "login_failed",
      route: req.originalUrl,
      method: req.method,
      message: "Tentativa de login invalida"
    });
    throw new AppError("Usuario ou senha invalido", 401);
  }
  await writeLog({
    type: "login",
    level: "info",
    userId: user.id,
    username: user.username,
    role: user.role,
    action: "login_success",
    route: req.originalUrl,
    method: req.method,
    message: `${user.name} entrou no sistema`
  });
  res.json({ token: signToken(user), user: publicUser(user), permissions: allPermissions });
}));

app.get("/auth/me", requireAuth, asyncHandler(async (_req, res) => {
  res.json({ user: publicUser(res.locals.user), permissions: allPermissions });
}));

app.get("/users", requireAuth, requirePermission("users.manage"), asyncHandler(async (_req, res) => {
  const users = await prisma.user.findMany({ orderBy: { name: "asc" } });
  res.json(users.map((user) => publicUser(mapUser(user))));
}));

app.post("/users", requireAuth, requirePermission("users.manage"), asyncHandler(async (req, res) => {
  const data = userSchema.parse(req.body);
  const existing = await prisma.user.findFirst({ where: { username: { equals: data.username, mode: "insensitive" } } });
  if (existing) throw new AppError("Usuario ja cadastrado");
  const { salt, passwordHash } = hashPassword(data.password ?? "123456");
  const created = await prisma.user.create({
    data: {
      name: data.name,
      username: data.username,
      role: roleToDb(data.role),
      permissions: data.permissions,
      active: data.active,
      salt,
      passwordHash
    }
  });
  res.status(201).json(publicUser(mapUser(created)));
}));

app.put("/users/:id", requireAuth, requirePermission("users.manage"), asyncHandler(async (req, res) => {
  const data = userSchema.partial().parse(req.body);
  const current = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!current) throw new AppError("Usuario nao encontrado", 404);
  if (current.role === PrismaUserRole.ADMIN) throw new AppError("Permissoes do ADMIN nao podem ser editadas", 403);
  if (data.username) {
    const existing = await prisma.user.findFirst({ where: { id: { not: current.id }, username: { equals: data.username, mode: "insensitive" } } });
    if (existing) throw new AppError("Usuario ja cadastrado");
  }
  const passwordData = data.password ? hashPassword(data.password) : {};
  const updated = await prisma.user.update({
    where: { id: current.id },
    data: {
      name: data.name,
      username: data.username,
      role: data.role ? roleToDb(data.role) : undefined,
      permissions: data.permissions,
      active: data.active,
      ...passwordData
    }
  });
  res.json(publicUser(mapUser(updated)));
}));

app.get("/logs", requireAuth, requirePermission("logs.view"), asyncHandler(async (_req, res) => {
  const logs = await prisma.systemLog.findMany({ orderBy: { createdAt: "desc" }, take: 250 });
  res.json(logs.map((log) => ({
    ...log,
    type: log.type === "LOGIN" ? "login" : "error",
    level: log.level === "ERROR" ? "error" : "info",
    role: log.role ? roleFromDb(log.role) : undefined,
    createdAt: log.createdAt.toISOString()
  })));
}));

app.get("/categories", asyncHandler(async (_req, res) => {
  const categories = await prisma.productCategory.findMany({ orderBy: { name: "asc" } });
  res.json(categories.map((category) => ({ ...category, createdAt: category.createdAt.toISOString(), updatedAt: category.updatedAt.toISOString() })));
}));

app.post("/categories", requireAuth, requirePermission("categories.create"), asyncHandler(async (req, res) => {
  const data = categorySchema.parse(req.body);
  const existing = await prisma.productCategory.findFirst({ where: { name: { equals: data.name, mode: "insensitive" } } });
  if (existing) throw new AppError("Categoria ja cadastrada");
  const category = await prisma.productCategory.create({
    data
  });
  res.status(201).json(category);
}));

app.put("/categories/:id", requireAuth, requirePermission("categories.edit"), asyncHandler(async (req, res) => {
  const data = categorySchema.partial().parse(req.body);
  const current = await prisma.productCategory.findUnique({ where: { id: req.params.id } });
  if (!current) throw new AppError("Categoria nao encontrada", 404);
  if (data.name) {
    const existing = await prisma.productCategory.findFirst({ where: { id: { not: current.id }, name: { equals: data.name, mode: "insensitive" } } });
    if (existing) throw new AppError("Categoria ja cadastrada");
  }
  const category = await prisma.productCategory.update({ where: { id: current.id }, data });
  res.json(category);
}));

app.delete("/categories/:id", requireAuth, requirePermission("categories.edit"), asyncHandler(async (req, res) => {
  await prisma.productCategory.update({ where: { id: req.params.id }, data: { active: false } }).catch(() => undefined);
  res.status(204).send();
}));

app.get("/images/search", requireAuth, requirePermission("products.create"), asyncHandler(async (req, res) => {
  const { q } = imageSearchSchema.parse(req.query);
  const response = await fetch(`https://api.openverse.engineering/v1/images/?q=${encodeURIComponent(q)}&page_size=12&mature=false`);
  if (!response.ok) throw new AppError("Nao foi possivel buscar imagens", 502);
  const data = await response.json() as { results?: Array<{ id: string; title?: string; thumbnail?: string; url?: string; creator?: string; source?: string; license?: string }> };
  res.json((data.results ?? []).map((item) => ({
    id: item.id,
    title: item.title ?? "Imagem",
    thumbnail: item.thumbnail || item.url,
    url: item.url,
    creator: item.creator,
    source: item.source,
    license: item.license
  })).filter((item) => item.thumbnail && item.url));
}));

app.post("/images/import", requireAuth, requirePermission("products.create"), asyncHandler(async (req, res) => {
  const { url } = imageImportSchema.parse(req.body);
  const response = await fetch(url, { headers: { "User-Agent": "PedidosPro/1.0" } });
  if (!response.ok) throw new AppError("Nao foi possivel baixar a imagem", 502);
  const contentType = response.headers.get("content-type") ?? "image/jpeg";
  if (!contentType.startsWith("image/")) throw new AppError("Arquivo selecionado nao e uma imagem");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > 6 * 1024 * 1024) throw new AppError("Imagem muito grande");
  res.json({ imageUrl: await saveProductImage(bytes, contentType, "produto-importado") });
}));

app.post("/images/upload", requireAuth, requirePermission("products.create"), upload.single("image"), asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError("Envie uma imagem.");
  const productName = String(req.body.name ?? "produto");
  res.status(201).json({ imageUrl: await saveProductImage(req.file.buffer, req.file.mimetype, productName) });
}));

app.get("/products", asyncHandler(async (_req, res) => {
  const products = await prisma.product.findMany({
    where: { active: true },
    include: { category: true, lots: { orderBy: { createdAt: "desc" } } },
    orderBy: { createdAt: "desc" }
  });
  res.json(products.map(mapProduct));
}));

app.post("/products", asyncHandler(async (req, res) => {
  const data = productSchema.parse(req.body);
  const sku = data.sku?.trim() || await nextSkuDb(data.name, data.categoryId, data.brand);
  const existing = await prisma.product.findFirst({ where: { active: true, sku } });
  if (existing) throw new AppError("SKU ja cadastrado");
  const productType = data.productType?.trim() || data.name;
  const lotCode = await nextLotCodeDb(sku);
  const product = await prisma.$transaction(async (tx) => {
    const created = await tx.product.create({
      data: {
        ...data,
        sku,
        productType,
        lotCode,
        categoryId: data.categoryId || undefined,
        manufactureDate: data.manufactureDate ? new Date(data.manufactureDate) : undefined,
        expirationDate: data.expirationDate ? new Date(data.expirationDate) : undefined
      }
    });
    if (created.stock > 0) {
      await tx.productLot.create({
        data: {
          productId: created.id,
          code: lotCode,
          initialStock: created.stock,
          currentStock: created.stock,
          costPrice: created.costPrice,
          salePrice: created.salePrice
        }
      });
      await tx.stockMovement.create({
        data: { productId: created.id, type: StockMovementType.IN, quantity: created.stock, lotCode, note: `Lote inicial ${lotCode}` }
      });
    }
    return created;
  });
  emitInventoryUpdated({ productId: product.id, stock: product.stock, onlineAvailable: product.onlineAvailable });
  res.status(201).json(mapProduct(product));
}));

app.put("/products/:id", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const data = productSchema.partial().parse(req.body);
  const current = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!current) throw new AppError("Produto nao encontrado", 404);
  const product = await prisma.product.update({
    where: { id: current.id },
    data: {
      ...data,
      categoryId: data.categoryId || undefined,
      manufactureDate: data.manufactureDate ? new Date(data.manufactureDate) : undefined,
      expirationDate: data.expirationDate ? new Date(data.expirationDate) : undefined
    }
  });
  emitProductUpdated(product.id);
  emitInventoryUpdated({ productId: product.id, stock: product.stock, onlineAvailable: product.onlineAvailable });
  res.json(mapProduct(product));
}));

app.delete("/products/:id", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const product = await prisma.product.update({ where: { id: req.params.id }, data: { active: false } }).catch(() => null);
  if (product) emitProductUpdated(product.id);
  res.status(204).send();
}));

app.get("/stock", asyncHandler(async (_req, res) => {
  const movements = await prisma.stockMovement.findMany({ include: { product: true }, orderBy: { createdAt: "desc" }, take: 80 });
  res.json(movements.map((movement) => ({
    ...movement,
    type: movementFromDb(movement.type),
    totalCost: movement.totalCost === null ? undefined : moneyValue(movement.totalCost),
    costPrice: movement.costPrice === null ? undefined : moneyValue(movement.costPrice),
    salePrice: movement.salePrice === null ? undefined : moneyValue(movement.salePrice),
    manufactureDate: iso(movement.manufactureDate) ?? "",
    expirationDate: iso(movement.expirationDate) ?? "",
    createdAt: movement.createdAt.toISOString(),
    product: movement.product ? mapProduct(movement.product) : undefined
  })));
}));

app.post("/stock", asyncHandler(async (req, res) => {
  const data = stockSchema.parse(req.body);
  const delta = data.type === "out" ? -data.quantity : data.quantity;

  const result = await prisma.$transaction(async (tx) => {
    const [product] = await tx.$queryRaw<Array<{ id: string; sku: string; name: string; stock: number; lotCode: string | null; costPrice: Prisma.Decimal; salePrice: Prisma.Decimal }>>`
      SELECT id, sku, name, stock, "lotCode", "costPrice", "salePrice"
      FROM products
      WHERE id = ${data.productId}::uuid
      FOR UPDATE
    `;
    if (!product) throw new AppError("Produto nao encontrado", 404);
    const lotCode = data.type === "in" ? await nextLotCodeDb(product.sku || product.name) : product.lotCode;
    const unitCost = data.costPrice ?? (data.totalCost !== undefined ? Number((data.totalCost / data.quantity).toFixed(2)) : moneyValue(product.costPrice));
    const salePrice = data.salePrice ?? moneyValue(product.salePrice);
    if (data.type === "out" && product.stock < data.quantity) throw new AppError(`Estoque insuficiente: ${product.name}`);
    if (data.type !== "adjustment") {
      await tx.product.update({ where: { id: product.id }, data: { stock: { increment: delta } } });
    }
    if (data.type === "in") {
      const newLotCode = lotCode ?? await nextLotCodeDb(product.sku || product.name);
      await tx.product.update({ where: { id: product.id }, data: { lotCode: newLotCode, costPrice: unitCost } });
      await tx.productLot.create({
        data: {
          productId: product.id,
          code: newLotCode,
          initialStock: data.quantity,
          currentStock: data.quantity,
          costPrice: unitCost,
          totalCost: data.totalCost ?? Number((unitCost * data.quantity).toFixed(2)),
          salePrice,
          manufactureDate: data.manufactureDate ? new Date(data.manufactureDate) : undefined,
          expirationDate: data.expirationDate ? new Date(data.expirationDate) : undefined
        }
      });
    }
    if (data.type === "out") {
      await tx.$queryRaw`SELECT id FROM product_lots WHERE "productId" = ${product.id}::uuid ORDER BY "createdAt", code FOR UPDATE`;
      let remaining = data.quantity;
      const lots = await tx.productLot.findMany({ where: { productId: product.id, currentStock: { gt: 0 } }, orderBy: [{ createdAt: "asc" }, { code: "asc" }] });
      for (const lot of lots) {
        if (remaining <= 0) break;
        const quantity = Math.min(remaining, lot.currentStock);
        await tx.productLot.update({ where: { id: lot.id }, data: { currentStock: { decrement: quantity } } });
        remaining -= quantity;
      }
    }
    const movement = await tx.stockMovement.create({
      data: {
        productId: product.id,
        type: movementToDb(data.type),
        quantity: data.quantity,
        totalCost: data.totalCost,
        costPrice: data.costPrice,
        salePrice: data.salePrice,
        manufactureDate: data.manufactureDate ? new Date(data.manufactureDate) : undefined,
        expirationDate: data.expirationDate ? new Date(data.expirationDate) : undefined,
        lotCode,
        note: data.note
      }
    });
    const updatedProduct = await tx.product.findUniqueOrThrow({ where: { id: product.id } });
    return { movement, product: updatedProduct };
  });

  emitInventoryUpdated({ productId: result.product.id, stock: result.product.stock, onlineAvailable: result.product.onlineAvailable });
  res.status(201).json({ movement: { ...result.movement, type: movementFromDb(result.movement.type), createdAt: result.movement.createdAt.toISOString() }, product: mapProduct(result.product) });
}));

app.put("/lots/:id", requireAuth, requirePermission("stock.move"), asyncHandler(async (req, res) => {
  const data = lotUpdateSchema.parse(req.body);
  const lot = await prisma.productLot.update({ where: { id: req.params.id }, data: { salePrice: data.salePrice } }).catch(() => null);
  if (!lot) throw new AppError("Lote nao encontrado", 404);
  emitProductUpdated(lot.productId);
  res.json(mapLot(lot));
}));

app.get("/finance", asyncHandler(async (_req, res) => {
  const entries = await prisma.financeEntry.findMany({ orderBy: { createdAt: "desc" } });
  res.json(entries.map((entry) => ({ ...entry, type: financeFromDb(entry.type), amount: moneyValue(entry.amount), createdAt: entry.createdAt.toISOString() })));
}));

app.post("/finance", asyncHandler(async (req, res) => {
  const data = financeSchema.parse(req.body);
  const entry = await prisma.financeEntry.create({ data: { ...data, type: financeToDb(data.type) } });
  res.status(201).json({ ...entry, type: financeFromDb(entry.type), amount: moneyValue(entry.amount), createdAt: entry.createdAt.toISOString() });
}));

app.get("/customers", asyncHandler(async (req, res) => {
  const q = String(req.query.q ?? "").replace(/\D/g, "");
  const raw = normalizeText(String(req.query.q ?? ""));
  const customers = await prisma.customer.findMany({ orderBy: { name: "asc" }, take: 200 });
  const filtered = customers
    .filter((customer) => {
      if (!raw) return true;
      return normalizeText(customer.name).includes(raw)
        || (q.length > 0 && (customer.phone ?? "").replace(/\D/g, "").includes(q))
        || (q.length > 0 && (customer.cpf ?? "").replace(/\D/g, "").includes(q));
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 30);
  res.json(filtered.map(mapCustomer));
}));

app.post("/customers", asyncHandler(async (req, res) => {
  const data = customerSchema.parse(req.body);
  const customerFilters = [
    ...(data.phone ? [{ phone: data.phone }] : []),
    ...(data.cpf ? [{ cpf: data.cpf }] : [])
  ];
  const existing = customerFilters.length ? await prisma.customer.findFirst({ where: { OR: customerFilters } }) : null;
  const customer = existing
    ? await prisma.customer.update({ where: { id: existing.id }, data })
    : await prisma.customer.create({ data: { ...data, cashbackBalance: data.cashbackBalance ?? 0 } });
  res.status(201).json(mapCustomer(customer));
}));

app.put("/customers/:id", asyncHandler(async (req, res) => {
  const data = customerSchema.partial().parse(req.body);
  const customer = await prisma.customer.update({ where: { id: req.params.id }, data }).catch(() => null);
  if (!customer) throw new AppError("Cliente nao encontrado", 404);
  res.json(mapCustomer(customer));
}));

app.get("/orders", asyncHandler(async (_req, res) => {
  const orders = await prisma.order.findMany({
    include: { items: { include: { product: true } } },
    orderBy: { createdAt: "desc" }
  });
  res.json(orders.map(mapOrder));
}));

app.post("/orders", asyncHandler(async (req, res) => {
  const data = orderSchema.parse(req.body);
  if (data.saleType === "avulso" && data.paymentMethod === "fiado") {
    throw new AppError("Fiado so pode ser usado para cliente cadastrado.");
  }
  if (data.paymentMethod === "fiado" && data.saleType !== "cliente") {
    throw new AppError("Venda fiada precisa ser para cliente cadastrado");
  }
  let customer = data.customerId ? await prisma.customer.findUnique({ where: { id: data.customerId } }) : null;
  if (data.saleType === "cliente" && !customer) {
    const name = data.customerName.trim();
    if (!name) throw new AppError("Informe o nome do cliente");
    customer = await prisma.customer.create({
      data: { name, phone: data.customerPhone, cpf: data.customerCpf, creditLimit: 10, cashbackBalance: 0 }
    });
  }
  if (data.paymentMethod === "fiado" && customer) {
    const debt = await prisma.order.aggregate({ where: { customerId: customer.id, amountDue: { gt: 0 } }, _sum: { amountDue: true } });
    const itemsPreview = await prisma.product.findMany({ where: { id: { in: data.items.map((item) => item.productId) } }, select: { id: true, salePrice: true } });
    const previewTotal = data.items.reduce((sum, item) => {
      const product = itemsPreview.find((candidate) => candidate.id === item.productId);
      return sum + moneyValue(product?.salePrice) * item.quantity;
    }, 0);
    const currentDebt = moneyValue(debt._sum.amountDue);
    const creditLimit = moneyValue(customer.creditLimit);
    const amountPaid = Number(data.amountPaid ?? 0);
    const duePreview = Math.max(previewTotal - amountPaid, 0);
    if (currentDebt + duePreview > creditLimit) throw new AppError(`Limite de fiado excedido. Limite: R$ ${creditLimit.toFixed(2)}`);
  }
  const created = await createOrderWithStockReservation({
    source: data.source,
    saleType: data.saleType,
    customerId: customer?.id,
    customerName: customer?.name ?? (data.customerName || "Avulso"),
    customerPhone: customer?.phone ?? data.customerPhone,
    customerCpf: customer?.cpf ?? data.customerCpf,
    paymentMethod: data.paymentMethod,
    amountPaid: data.paymentMethod === "fiado" ? Number(data.amountPaid ?? 0) : undefined,
    items: data.items
  });
  const order = await prisma.order.findUniqueOrThrow({ where: { id: created.id }, include: { items: { include: { product: true } } } });
  res.status(201).json(mapOrder(order));
}));

app.post("/orders/:id/payments", asyncHandler(async (req, res) => {
  const data = paymentSchema.parse(req.body);
  const order = await prisma.$transaction(async (tx) => {
    const current = await tx.order.findUnique({ where: { id: req.params.id } });
    if (!current) throw new AppError("Venda nao encontrada", 404);
    const amount = Math.min(data.amount, moneyValue(current.amountDue));
    const amountPaid = moneyValue(current.amountPaid) + amount;
    const amountDue = Math.max(moneyValue(current.amountDue) - amount, 0);
    const updated = await tx.order.update({
      where: { id: current.id },
      data: { amountPaid, amountDue, paymentStatus: amountDue <= 0 ? PaymentStatus.PAID : PaymentStatus.PARTIAL },
      include: { items: { include: { product: true } } }
    });
    await tx.financeEntry.create({
      data: {
        type: FinanceEntryType.INCOME,
        description: `Pagamento recebido venda ${current.id}`,
        amount,
        category: "Vendas/fiado"
      }
    });
    return updated;
  });
  res.json(mapOrder(order));
}));

app.put("/orders/:id/payment", asyncHandler(async (req, res) => {
  const data = z.object({
    paymentMethod: z.enum(["dinheiro", "pix", "cartao", "fiado"]).optional(),
    paymentStatus: z.enum(["paid", "partial", "pending"]).optional(),
    amountPaid: money.optional()
  }).parse(req.body);

  const current = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!current) throw new AppError("Venda nao encontrada", 404);
  let amountPaid = moneyValue(current.amountPaid);
  let amountDue = moneyValue(current.amountDue);
  let paymentStatus = current.paymentStatus;
  if (data.amountPaid !== undefined) {
    amountPaid = Math.min(data.amountPaid, moneyValue(current.total));
    amountDue = Math.max(moneyValue(current.total) - amountPaid, 0);
  }
  if (data.paymentStatus) {
    paymentStatus = data.paymentStatus === "paid" ? PaymentStatus.PAID : data.paymentStatus === "partial" ? PaymentStatus.PARTIAL : PaymentStatus.PENDING;
    if (paymentStatus === PaymentStatus.PAID) {
      amountPaid = moneyValue(current.total);
      amountDue = 0;
    }
    if (paymentStatus === PaymentStatus.PENDING) {
      amountPaid = 0;
      amountDue = moneyValue(current.total);
    }
  } else {
    paymentStatus = amountDue <= 0 ? PaymentStatus.PAID : amountPaid > 0 ? PaymentStatus.PARTIAL : PaymentStatus.PENDING;
  }
  const order = await prisma.order.update({
    where: { id: current.id },
    data: {
      paymentMethod: data.paymentMethod ? (data.paymentMethod === "dinheiro" ? PaymentMethod.DINHEIRO : data.paymentMethod === "cartao" ? PaymentMethod.CARTAO : data.paymentMethod === "fiado" ? PaymentMethod.FIADO : PaymentMethod.PIX) : undefined,
      paymentStatus,
      amountPaid,
      amountDue
    },
    include: { items: { include: { product: true } } }
  });
  res.json(mapOrder(order));
}));

app.put("/orders/:id/status", requireAuth, requirePermission("customerOrders.manage"), asyncHandler(async (req, res) => {
  const data = z.object({
    status: z.enum(["pending", "preparing", "ready", "delivered", "cancelled"]),
    removalKey: z.string().optional()
  }).parse(req.body);
  const user = res.locals.user as User;
  const now = new Date().toISOString();

  if (data.status === "cancelled") {
    const expectedKey = (process.env.REMOVAL_KEY ?? "admin-remover").trim().replace(/^["']|["']$/g, "");
    if (data.removalKey !== expectedKey) throw new AppError("Chave de seguranca invalida", 403);
  }

  const order = await prisma.$transaction(async (tx) => {
    const current = await tx.order.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!current) throw new AppError("Pedido nao encontrado", 404);
    const wasCancelled = current.status === OrderStatus.CANCELLED;
    if (data.status === "cancelled" && !wasCancelled) {
      for (const item of current.items) {
        await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
        if (item.lotId) await tx.productLot.update({ where: { id: item.lotId }, data: { currentStock: { increment: item.quantity } } });
        await tx.stockMovement.create({
          data: {
            productId: item.productId,
            type: StockMovementType.IN,
            quantity: item.quantity,
            lotCode: item.lotCode,
            note: `Cancelamento pedido ${current.id}`
          }
        });
      }
    }
    return tx.order.update({
      where: { id: current.id },
      data: {
        status: orderStatusToDb(data.status),
        cancelledAt: data.status === "cancelled" && !wasCancelled ? new Date(now) : current.cancelledAt,
        cancelledById: data.status === "cancelled" && !wasCancelled ? user.id : current.cancelledById,
        cancelledByName: data.status === "cancelled" && !wasCancelled ? user.name : current.cancelledByName
      },
      include: { items: { include: { product: true } } }
    });
  });

  emitOrderStatusUpdated(order.id, data.status);
  res.json(mapOrder(order));
}));

app.delete("/orders/:id", asyncHandler(async (req, res) => {
  const data = deleteOrderSchema.parse(req.body);
  const expectedKey = (process.env.REMOVAL_KEY ?? "admin-remover").trim().replace(/^["']|["']$/g, "");
  if (data.removalKey !== expectedKey) throw new AppError("Chave de remocao invalida", 403);

  await prisma.$transaction(async (tx) => {
    const removed = await tx.order.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!removed) throw new AppError("Venda nao encontrada", 404);
    for (const item of removed.items) {
      await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
      if (item.lotId) await tx.productLot.update({ where: { id: item.lotId }, data: { currentStock: { increment: item.quantity } } });
      await tx.stockMovement.create({
        data: {
          productId: item.productId,
          type: StockMovementType.IN,
          quantity: item.quantity,
          lotCode: item.lotCode,
          note: `Estorno venda ${removed.id}`
        }
      });
    }
    await tx.order.delete({ where: { id: removed.id } });
  });

  res.status(204).send();
}));

app.use(async (error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  const status = error instanceof z.ZodError ? 400 : error instanceof AppError ? error.status : 500;
  const message = error instanceof z.ZodError ? "Erro de validacao" : error instanceof AppError ? error.message : "Erro interno";
  if (req.originalUrl !== "/logs") {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const session = verifyToken(token);
    const dbUser = session ? await prisma.user.findUnique({ where: { id: session.id } }).catch(() => null) : null;
    const user = dbUser ? mapUser(dbUser) : undefined;
    await writeLog({
      type: "error",
      level: "error",
      userId: user?.id,
      username: user?.username,
      role: user?.role,
      action: "api_error",
      route: req.originalUrl,
      method: req.method,
      message
    }).catch(() => undefined);
  }
  if (error instanceof z.ZodError) return res.status(400).json({ error: error.flatten() });
  if (error instanceof AppError) return res.status(error.status).json({ error: error.message });
  return res.status(500).json({ error: "Erro interno" });
});

setupRealtime(httpServer, frontendUrl);

httpServer.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
  startKeepAlive();
});
