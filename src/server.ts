import cors from "cors";
import { config } from "dotenv";
import express from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { startKeepAlive } from "./keepAlive.js";
import { id, snapshot, transact, type Customer, type Order, type ProductCategory, type SystemLog, type User, type UserRole } from "./store.js";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

const app = express();
const port = Number(process.env.PORT ?? 3333);
const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
const businessWhatsapp = process.env.BUSINESS_WHATSAPP ?? "";
const authSecret = process.env.AUTH_SECRET ?? process.env.REMOVAL_KEY ?? "pedidos-pro-secret";

app.use(cors({ origin: [frontendUrl, "http://localhost:5173"], credentials: true }));
app.use(express.json({ limit: "8mb" }));

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
  "customers.view",
  "customers.create",
  "customers.edit",
  "users.manage",
  "logs.view"
];

const productSchema = z.object({
  name: z.string().min(2),
  sku: z.string().optional().default(""),
  categoryId: z.string().optional().default(""),
  brand: z.string().optional().default(""),
  productType: z.string().optional().default(""),
  manufactureDate: z.string().optional().default(""),
  expirationDate: z.string().optional().default(""),
  description: z.string().optional().nullable(),
  imageUrl: z.string().optional().nullable(),
  costPrice: money.default(0),
  salePrice: money,
  stock: z.coerce.number().int().min(0).default(0),
  minStock: z.coerce.number().int().min(0).default(0),
  active: z.boolean().default(true)
});

const categorySchema = z.object({
  name: z.string().min(2),
  description: z.string().optional().default(""),
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
  description: z.string().min(2),
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

const customerSchema = z.object({
  name: z.string().min(2),
  phone: z.string().optional().default(""),
  cpf: z.string().optional().default(""),
  email: z.string().optional().default(""),
  address: z.string().optional().default(""),
  notes: z.string().optional().default(""),
  creditLimit: money.default(10),
  cashbackBalance: money.optional()
});

const orderSchema = z.object({
  source: z.enum(["admin", "client_page"]).optional().default("admin"),
  saleType: z.enum(["avulso", "cliente"]).default("cliente"),
  customerId: z.string().optional(),
  customerName: z.string().optional().default(""),
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
  name: z.string().min(2),
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
  await transact((db) => {
    db.logs.push({ id: id(), ...log, createdAt: new Date().toISOString() });
    if (db.logs.length > 500) db.logs.splice(0, db.logs.length - 500);
  });
}

async function ensureAdminUser() {
  await transact((db) => {
    if (db.users.some((user) => user.role === "admin")) return;
    const now = new Date().toISOString();
    const { salt, passwordHash } = hashPassword(process.env.ADMIN_PASSWORD ?? "admin123");
    db.users.push({
      id: id(),
      name: process.env.ADMIN_NAME ?? "Administrador",
      username: process.env.ADMIN_USERNAME ?? "admin",
      role: "admin",
      salt,
      passwordHash,
      permissions: allPermissions,
      active: true,
      createdAt: now,
      updatedAt: now
    });
  });
}

const requireAuth: express.RequestHandler = asyncHandler(async (req, res, next) => {
  const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const session = verifyToken(token);
  if (!session) throw new AppError("Login necessario", 401);
  const data = await snapshot();
  const user = data.users.find((item) => item.id === session.id && item.active);
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
  const db = await snapshot();
  const user = db.users.find((item) => item.username.toLowerCase() === data.username.toLowerCase() && item.active);
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
  const data = await snapshot();
  res.json(data.users.map(publicUser).sort((a, b) => a.name.localeCompare(b.name)));
}));

app.post("/users", requireAuth, requirePermission("users.manage"), asyncHandler(async (req, res) => {
  const data = userSchema.parse(req.body);
  const now = new Date().toISOString();
  const created = await transact((db) => {
    if (db.users.some((user) => user.username.toLowerCase() === data.username.toLowerCase())) throw new AppError("Usuario ja cadastrado");
    const { salt, passwordHash } = hashPassword(data.password ?? "123456");
    const user: User = { id: id(), name: data.name, username: data.username, role: data.role, permissions: data.permissions, active: data.active, salt, passwordHash, createdAt: now, updatedAt: now };
    db.users.push(user);
    return user;
  });
  res.status(201).json(publicUser(created));
}));

app.put("/users/:id", requireAuth, requirePermission("users.manage"), asyncHandler(async (req, res) => {
  const data = userSchema.partial().parse(req.body);
  const updated = await transact((db) => {
    const current = db.users.find((user) => user.id === req.params.id);
    if (!current) throw new AppError("Usuario nao encontrado", 404);
    if (current.role === "admin") throw new AppError("Permissoes do ADMIN nao podem ser editadas", 403);
    if (data.username && db.users.some((user) => user.id !== current.id && user.username.toLowerCase() === data.username!.toLowerCase())) throw new AppError("Usuario ja cadastrado");
    Object.assign(current, {
      name: data.name ?? current.name,
      username: data.username ?? current.username,
      role: data.role ?? current.role,
      permissions: data.permissions ?? current.permissions,
      active: data.active ?? current.active,
      updatedAt: new Date().toISOString()
    });
    if (data.password) Object.assign(current, hashPassword(data.password));
    return current;
  });
  res.json(publicUser(updated));
}));

app.get("/logs", requireAuth, requirePermission("logs.view"), asyncHandler(async (_req, res) => {
  const data = await snapshot();
  res.json(data.logs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 250));
}));

app.get("/categories", asyncHandler(async (_req, res) => {
  const data = await snapshot();
  res.json(data.categories.sort((a, b) => a.name.localeCompare(b.name)));
}));

app.post("/categories", requireAuth, requirePermission("categories.create"), asyncHandler(async (req, res) => {
  const data = categorySchema.parse(req.body);
  const now = new Date().toISOString();
  const category = await transact((db) => {
    if (db.categories.some((item) => item.name.toLowerCase() === data.name.toLowerCase())) throw new AppError("Categoria ja cadastrada");
    const created: ProductCategory = { id: id(), ...data, createdAt: now, updatedAt: now };
    db.categories.push(created);
    return created;
  });
  res.status(201).json(category);
}));

app.put("/categories/:id", requireAuth, requirePermission("categories.edit"), asyncHandler(async (req, res) => {
  const data = categorySchema.partial().parse(req.body);
  const category = await transact((db) => {
    const current = db.categories.find((item) => item.id === req.params.id);
    if (!current) throw new AppError("Categoria nao encontrada", 404);
    if (data.name && db.categories.some((item) => item.id !== current.id && item.name.toLowerCase() === data.name!.toLowerCase())) throw new AppError("Categoria ja cadastrada");
    Object.assign(current, data, { updatedAt: new Date().toISOString() });
    return current;
  });
  res.json(category);
}));

app.delete("/categories/:id", requireAuth, requirePermission("categories.edit"), asyncHandler(async (req, res) => {
  await transact((db) => {
    const category = db.categories.find((item) => item.id === req.params.id);
    if (category) category.active = false;
  });
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
  res.json({ imageUrl: `data:${contentType};base64,${bytes.toString("base64")}` });
}));

app.get("/products", asyncHandler(async (_req, res) => {
  const data = await snapshot();
  res.json(data.products
    .filter((product) => product.active)
    .map((product) => ({ ...product, category: data.categories.find((category) => category.id === product.categoryId), lots: data.productLots.filter((lot) => lot.productId === product.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}));

app.post("/products", asyncHandler(async (req, res) => {
  const data = productSchema.parse(req.body);
  const now = new Date().toISOString();
  const product = await transact((db) => {
    const sku = data.sku?.trim() || nextSku(db, data.name, data.categoryId, data.brand);
    if (sku && db.products.some((item) => item.active && item.sku === sku)) throw new AppError("SKU ja cadastrado");
    const productType = data.productType?.trim() || data.name;
    const lotCode = nextLotCode(db, sku);
    const created = { id: id(), ...data, sku, productType, lotCode, createdAt: now, updatedAt: now };
    db.products.push(created);
    if (created.stock > 0) {
      db.productLots.push({
        id: id(),
        productId: created.id,
        code: lotCode,
        initialStock: created.stock,
        currentStock: created.stock,
        costPrice: created.costPrice,
        salePrice: created.salePrice,
        createdAt: now
      });
      db.stockMovements.push({ id: id(), productId: created.id, type: "in", quantity: created.stock, lotCode, note: `Lote inicial ${lotCode}`, createdAt: now });
    }
    return created;
  });
  res.status(201).json(product);
}));

app.put("/products/:id", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const data = productSchema.partial().parse(req.body);
  const product = await transact((db) => {
    const current = db.products.find((item) => item.id === req.params.id);
    if (!current) throw new AppError("Produto nao encontrado", 404);
    Object.assign(current, data, { updatedAt: new Date().toISOString() });
    return current;
  });
  res.json(product);
}));

app.delete("/products/:id", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  await transact((db) => {
    const product = db.products.find((item) => item.id === req.params.id);
    if (product) product.active = false;
  });
  res.status(204).send();
}));

app.get("/stock", asyncHandler(async (_req, res) => {
  const data = await snapshot();
  const movements = data.stockMovements
    .map((movement) => ({ ...movement, product: data.products.find((product) => product.id === movement.productId) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 80);
  res.json(movements);
}));

app.post("/stock", asyncHandler(async (req, res) => {
  const data = stockSchema.parse(req.body);
  const delta = data.type === "out" ? -data.quantity : data.quantity;

  const result = await transact((db) => {
    const product = db.products.find((item) => item.id === data.productId);
    if (!product) throw new AppError("Produto nao encontrado", 404);
    const lotCode = data.type === "in" ? nextLotCode(db, product.sku || product.name) : product.lotCode;
    const unitCost = data.costPrice ?? (data.totalCost !== undefined ? Number((data.totalCost / data.quantity).toFixed(2)) : product.costPrice);
    const salePrice = data.salePrice ?? product.salePrice;
    if (data.type !== "adjustment") product.stock += delta;
    if (data.type === "in") {
      const newLotCode = lotCode ?? nextLotCode(db, product.sku || product.name);
      product.lotCode = newLotCode;
      product.costPrice = unitCost;
      db.productLots.push({
        id: id(),
        productId: product.id,
        code: newLotCode,
        initialStock: data.quantity,
        currentStock: data.quantity,
        costPrice: unitCost,
        totalCost: data.totalCost ?? Number((unitCost * data.quantity).toFixed(2)),
        salePrice,
        manufactureDate: data.manufactureDate,
        expirationDate: data.expirationDate,
        createdAt: new Date().toISOString()
      });
    }
    product.updatedAt = new Date().toISOString();
    const movement = { id: id(), ...data, lotCode, createdAt: new Date().toISOString() };
    db.stockMovements.push(movement);
    return { movement, product };
  });

  res.status(201).json(result);
}));

app.get("/finance", asyncHandler(async (_req, res) => {
  const data = await snapshot();
  res.json(data.financeEntries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}));

app.post("/finance", asyncHandler(async (req, res) => {
  const data = financeSchema.parse(req.body);
  const entry = await transact((db) => {
    const created = { id: id(), ...data, createdAt: new Date().toISOString() };
    db.financeEntries.push(created);
    return created;
  });
  res.status(201).json(entry);
}));

app.get("/customers", asyncHandler(async (req, res) => {
  const q = String(req.query.q ?? "").toLowerCase().replace(/\D/g, "");
  const raw = String(req.query.q ?? "").toLowerCase();
  const data = await snapshot();
  const customers = data.customers
    .filter((customer) => {
      if (!raw) return true;
      return customer.name.toLowerCase().includes(raw)
        || (q.length > 0 && (customer.phone ?? "").replace(/\D/g, "").includes(q))
        || (q.length > 0 && (customer.cpf ?? "").replace(/\D/g, "").includes(q));
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 30);
  res.json(customers);
}));

app.post("/customers", asyncHandler(async (req, res) => {
  const data = customerSchema.parse(req.body);
  const now = new Date().toISOString();
  const customer = await transact((db) => {
    const existing = db.customers.find((item) =>
      (data.phone && item.phone === data.phone) || (data.cpf && item.cpf === data.cpf)
    );
    if (existing) {
      Object.assign(existing, data, { updatedAt: now });
      return existing;
    }
    const created: Customer = { id: id(), ...data, cashbackBalance: data.cashbackBalance ?? 0, createdAt: now, updatedAt: now };
    db.customers.push(created);
    return created;
  });
  res.status(201).json(customer);
}));

app.put("/customers/:id", asyncHandler(async (req, res) => {
  const data = customerSchema.partial().parse(req.body);
  const customer = await transact((db) => {
    const current = db.customers.find((item) => item.id === req.params.id);
    if (!current) throw new AppError("Cliente nao encontrado", 404);
    Object.assign(current, data, { updatedAt: new Date().toISOString() });
    return current;
  });
  res.json(customer);
}));

app.get("/orders", asyncHandler(async (_req, res) => {
  const data = await snapshot();
  const orders = data.orders
    .map((order) => ({ ...order, items: order.items.map((item) => ({ ...item, product: data.products.find((product) => product.id === item.productId) })) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(orders);
}));

app.post("/orders", asyncHandler(async (req, res) => {
  const data = orderSchema.parse(req.body);
  const order = await transact((db) => {
    let customer: Customer | undefined;
    if (data.saleType === "cliente") {
      customer = data.customerId ? db.customers.find((item) => item.id === data.customerId) : undefined;
      if (!customer) {
        const name = data.customerName.trim();
        if (!name) throw new AppError("Informe o nome do cliente");
        const now = new Date().toISOString();
        customer = {
          id: id(),
          name,
          phone: data.customerPhone,
          cpf: data.customerCpf,
          creditLimit: 10,
          cashbackBalance: 0,
          createdAt: now,
          updatedAt: now
        };
        db.customers.push(customer);
      }
    }

    const lines: string[] = [];
    let total = 0;
    const items = data.items.flatMap((item) => {
      const product = db.products.find((candidate) => candidate.id === item.productId && candidate.active);
      if (!product) throw new AppError("Produto indisponivel");
      if (product.stock < item.quantity) throw new AppError(`Estoque insuficiente: ${product.name}`);
      total += product.salePrice * item.quantity;
      lines.push(`${item.quantity}x ${product.name} - R$ ${(product.salePrice * item.quantity).toFixed(2)}`);
      let remaining = item.quantity;
      const lots = db.productLots
        .filter((lot) => lot.productId === item.productId && lot.currentStock > 0)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const soldItems: Order["items"] = [];

      for (const lot of lots) {
        if (remaining <= 0) break;
        const quantity = Math.min(remaining, lot.currentStock);
        lot.currentStock -= quantity;
        remaining -= quantity;
        soldItems.push({
          id: id(),
          productId: item.productId,
          quantity,
          unitPrice: product.salePrice,
          costPrice: lot.costPrice,
          lotCode: lot.code
        });
      }

      if (remaining > 0) {
        soldItems.push({ id: id(), productId: item.productId, quantity: remaining, unitPrice: product.salePrice, costPrice: product.costPrice, lotCode: product.lotCode });
      }

      return soldItems;
    });

    if (data.paymentMethod === "fiado" && data.saleType !== "cliente") {
      throw new AppError("Venda fiada precisa ser para cliente cadastrado");
    }

    const cashbackUsed = data.useCashback && customer ? cashbackDiscount(Number(customer.cashbackBalance ?? 0), total) : 0;
    if (data.useCashback && !customer) throw new AppError("Cashback so pode ser usado por cliente cadastrado");
    if (cashbackUsed > 0 && customer) {
      customer.cashbackBalance = Number((Number(customer.cashbackBalance ?? 0) - cashbackUsed).toFixed(2));
    }
    const payableTotal = Math.max(total - cashbackUsed, 0);
    const amountPaid = data.paymentMethod === "fiado" ? Math.min(Number(data.amountPaid ?? 0), payableTotal) : payableTotal;
    const amountDue = Math.max(payableTotal - amountPaid, 0);
    if (data.paymentMethod === "fiado" && customer) {
      const currentDebt = db.orders
        .filter((order) => order.customerId === customer?.id)
        .reduce((sum, order) => sum + Number(order.amountDue ?? 0), 0);
      const creditLimit = Number(customer.creditLimit ?? 10);
      if (currentDebt + amountDue > creditLimit) {
        throw new AppError(`Limite de fiado excedido. Limite: R$ ${creditLimit.toFixed(2)}`);
      }
    }
    const paymentStatus = amountDue <= 0 ? "paid" : amountPaid > 0 ? "partial" : "pending";
    const created: Order = {
      id: id(),
      source: data.source,
      saleType: data.saleType,
      customerId: customer?.id,
      customerName: customer?.name ?? (data.customerName || "Avulso"),
      customerPhone: customer?.phone ?? data.customerPhone,
      paymentMethod: data.paymentMethod,
      paymentStatus,
      amountPaid,
      amountDue,
      cashbackUsed,
      cashbackEarned: 0,
      cashbackReleased: data.paymentMethod !== "fiado",
      status: "pending",
      total,
      createdAt: new Date().toISOString(),
      items
    };

    created.whatsappUrl = whatsappUrl(created.id, data.customerName, lines, total);
    db.orders.push(created);

    if (customer && (data.paymentMethod === "pix" || data.paymentMethod === "dinheiro") && amountDue <= 0 && amountPaid > 0) {
      const earned = Number((amountPaid * 0.1).toFixed(2));
      customer.cashbackBalance = Number((Number(customer.cashbackBalance ?? 0) + earned).toFixed(2));
      created.cashbackEarned = earned;
    }

    for (const item of items) {
      const product = db.products.find((candidate) => candidate.id === item.productId);
      if (!product) continue;
      product.stock -= item.quantity;
      product.updatedAt = new Date().toISOString();
      db.stockMovements.push({ id: id(), productId: item.productId, type: "out", quantity: item.quantity, lotCode: item.lotCode, note: `Pedido ${created.id}`, createdAt: new Date().toISOString() });
    }

    if (amountPaid > 0) {
      db.financeEntries.push({
        id: id(),
        type: "income",
        description: `Pagamento venda ${created.id} - ${data.paymentMethod}`,
        amount: amountPaid,
        category: `Vendas/${data.paymentMethod}`,
        createdAt: created.createdAt
      });
    }

    if (amountDue > 0) {
      db.financeEntries.push({
        id: id(),
        type: "receivable",
        description: `A receber venda ${created.id}`,
        amount: amountDue,
        category: "Vendas/fiado",
        createdAt: created.createdAt
      });
    }

    return { ...created, items: created.items.map((item) => ({ ...item, product: db.products.find((product) => product.id === item.productId) })) };
  });

  res.status(201).json(order);
}));

app.post("/orders/:id/payments", asyncHandler(async (req, res) => {
  const data = paymentSchema.parse(req.body);
  const order = await transact((db) => {
    const current = db.orders.find((item) => item.id === req.params.id);
    if (!current) throw new AppError("Venda nao encontrada", 404);
    const amount = Math.min(data.amount, current.amountDue ?? 0);
    current.amountPaid = Number(current.amountPaid ?? 0) + amount;
    current.amountDue = Math.max(Number(current.amountDue ?? 0) - amount, 0);
    current.paymentStatus = current.amountDue <= 0 ? "paid" : "partial";
    const customer = current.customerId ? db.customers.find((item) => item.id === current.customerId) : undefined;
    maybeReleaseFiadoCashback(current, customer);
    db.financeEntries.push({
      id: id(),
      type: "income",
      description: `Pagamento recebido venda ${current.id}`,
      amount,
      category: "Vendas/fiado",
      createdAt: new Date().toISOString()
    });
    return current;
  });
  res.json(order);
}));

app.put("/orders/:id/payment", asyncHandler(async (req, res) => {
  const data = z.object({
    paymentMethod: z.enum(["dinheiro", "pix", "cartao", "fiado"]).optional(),
    paymentStatus: z.enum(["paid", "partial", "pending"]).optional(),
    amountPaid: money.optional()
  }).parse(req.body);

  const order = await transact((db) => {
    const current = db.orders.find((item) => item.id === req.params.id);
    if (!current) throw new AppError("Venda nao encontrada", 404);

    if (data.paymentMethod) current.paymentMethod = data.paymentMethod;
    if (data.amountPaid !== undefined) {
      current.amountPaid = Math.min(data.amountPaid, current.total);
      current.amountDue = Math.max(current.total - current.amountPaid, 0);
    }
    if (data.paymentStatus) {
      current.paymentStatus = data.paymentStatus;
      if (data.paymentStatus === "paid") {
        current.amountPaid = current.total;
        current.amountDue = 0;
      }
      if (data.paymentStatus === "pending") {
        current.amountPaid = 0;
        current.amountDue = current.total;
      }
    } else {
      current.paymentStatus = current.amountDue <= 0 ? "paid" : current.amountPaid > 0 ? "partial" : "pending";
    }
    const customer = current.customerId ? db.customers.find((item) => item.id === current.customerId) : undefined;
    maybeReleaseFiadoCashback(current, customer);

    return current;
  });

  res.json(order);
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

  const order = await transact((db) => {
    const current = db.orders.find((item) => item.id === req.params.id);
    if (!current) throw new AppError("Pedido nao encontrado", 404);
    const wasCancelled = current.status === "cancelled";
    current.status = data.status;
    if (data.status === "cancelled" && !wasCancelled) {
      current.cancelledAt = now;
      current.cancelledBy = user.id;
      current.cancelledByName = user.name;
      for (const item of current.items) {
        const product = db.products.find((candidate) => candidate.id === item.productId);
        if (!product) continue;
        product.stock += item.quantity;
        product.updatedAt = now;
        const lot = item.lotCode ? db.productLots.find((candidate) => candidate.code === item.lotCode && candidate.productId === item.productId) : undefined;
        if (lot) lot.currentStock += item.quantity;
        db.stockMovements.push({
          id: id(),
          productId: item.productId,
          type: "in",
          quantity: item.quantity,
          lotCode: item.lotCode ?? product.lotCode,
          note: `Cancelamento pedido ${current.id}`,
          createdAt: now
        });
      }
    }
    return current;
  });

  res.json(order);
}));

app.delete("/orders/:id", asyncHandler(async (req, res) => {
  const data = deleteOrderSchema.parse(req.body);
  const expectedKey = (process.env.REMOVAL_KEY ?? "admin-remover").trim().replace(/^["']|["']$/g, "");
  if (data.removalKey !== expectedKey) throw new AppError("Chave de remocao invalida", 403);

  await transact((db) => {
    const index = db.orders.findIndex((item) => item.id === req.params.id);
    if (index < 0) throw new AppError("Venda nao encontrada", 404);
    const [removed] = db.orders.splice(index, 1);
    for (const item of removed.items) {
      const product = db.products.find((candidate) => candidate.id === item.productId);
      if (!product) continue;
      product.stock += item.quantity;
      product.updatedAt = new Date().toISOString();
      const lot = item.lotCode ? db.productLots.find((candidate) => candidate.code === item.lotCode && candidate.productId === item.productId) : undefined;
      if (lot) lot.currentStock += item.quantity;
      db.stockMovements.push({
        id: id(),
        productId: item.productId,
        type: "in",
        quantity: item.quantity,
        lotCode: item.lotCode ?? product.lotCode,
        note: `Estorno venda ${removed.id}`,
        createdAt: new Date().toISOString()
      });
    }
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
    const db = await snapshot().catch(() => null);
    const user = session && db ? db.users.find((item) => item.id === session.id) : undefined;
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

app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
  startKeepAlive();
});
