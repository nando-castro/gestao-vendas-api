import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "dotenv";
import {
  FinanceEntryType,
  LogLevel,
  LogType,
  OrderSource,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
  SaleType,
  StockMovementType,
  UserRole
} from "@prisma/client";

config({ path: resolve(process.cwd(), ".env") });

const prisma = new PrismaClient();
const dataFile = resolve(process.env.DATA_FILE ?? "./data/pedidos.json");

type JsonData = {
  products?: any[];
  categories?: any[];
  productLots?: any[];
  stockMovements?: any[];
  financeEntries?: any[];
  orders?: any[];
  customers?: any[];
  users?: any[];
  logs?: any[];
};

function date(value?: string | null) {
  return value ? new Date(value) : undefined;
}

function decimal(value: unknown, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function role(value?: string) {
  if (value === "admin") return UserRole.ADMIN;
  if (value === "cliente") return UserRole.CLIENTE;
  return UserRole.USUARIO;
}

function movementType(value?: string) {
  if (value === "in") return StockMovementType.IN;
  if (value === "out") return StockMovementType.OUT;
  return StockMovementType.ADJUSTMENT;
}

function financeType(value?: string) {
  if (value === "expense") return FinanceEntryType.EXPENSE;
  if (value === "receivable") return FinanceEntryType.RECEIVABLE;
  return FinanceEntryType.INCOME;
}

function source(value?: string) {
  return value === "client_page" ? OrderSource.CLIENT_PAGE : OrderSource.ADMIN;
}

function saleType(value?: string) {
  return value === "avulso" ? SaleType.AVULSO : SaleType.CLIENTE;
}

function paymentMethod(value?: string) {
  if (value === "dinheiro") return PaymentMethod.DINHEIRO;
  if (value === "cartao") return PaymentMethod.CARTAO;
  if (value === "fiado") return PaymentMethod.FIADO;
  return PaymentMethod.PIX;
}

function paymentStatus(value?: string) {
  if (value === "partial") return PaymentStatus.PARTIAL;
  if (value === "pending") return PaymentStatus.PENDING;
  return PaymentStatus.PAID;
}

function orderStatus(value?: string) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "waiting") return OrderStatus.WAITING;
  if (normalized === "preparing") return OrderStatus.PREPARING;
  if (normalized === "ready") return OrderStatus.READY;
  if (normalized === "cancelled" || normalized === "canceled") return OrderStatus.CANCELLED;
  if (normalized === "delivered" || normalized === "completed") return OrderStatus.DELIVERED;
  return OrderStatus.OPEN;
}

async function main() {
  const json = JSON.parse(await readFile(dataFile, "utf8")) as JsonData;

  for (const category of json.categories ?? []) {
    await prisma.productCategory.upsert({
      where: { id: category.id },
      update: {
        name: category.name,
        description: category.description || null,
        active: category.active ?? true,
        createdAt: date(category.createdAt) ?? new Date(),
        updatedAt: date(category.updatedAt) ?? new Date()
      },
      create: {
        id: category.id,
        name: category.name,
        description: category.description || null,
        active: category.active ?? true,
        createdAt: date(category.createdAt) ?? new Date(),
        updatedAt: date(category.updatedAt) ?? new Date()
      }
    });
  }

  for (const user of json.users ?? []) {
    await prisma.user.upsert({
      where: { id: user.id },
      update: {
        name: user.name,
        username: user.username,
        role: role(user.role),
        passwordHash: user.passwordHash,
        salt: user.salt,
        permissions: user.permissions ?? [],
        active: user.active ?? true,
        createdAt: date(user.createdAt) ?? new Date(),
        updatedAt: date(user.updatedAt) ?? new Date()
      },
      create: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: role(user.role),
        passwordHash: user.passwordHash,
        salt: user.salt,
        permissions: user.permissions ?? [],
        active: user.active ?? true,
        createdAt: date(user.createdAt) ?? new Date(),
        updatedAt: date(user.updatedAt) ?? new Date()
      }
    });
  }

  for (const customer of json.customers ?? []) {
    await prisma.customer.upsert({
      where: { id: customer.id },
      update: {
        name: customer.name,
        phone: customer.phone || null,
        cpf: customer.cpf || null,
        email: customer.email || null,
        address: customer.address || null,
        notes: customer.notes || null,
        creditLimit: decimal(customer.creditLimit, 10),
        cashbackBalance: decimal(customer.cashbackBalance),
        createdAt: date(customer.createdAt) ?? new Date(),
        updatedAt: date(customer.updatedAt) ?? new Date()
      },
      create: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone || null,
        cpf: customer.cpf || null,
        email: customer.email || null,
        address: customer.address || null,
        notes: customer.notes || null,
        creditLimit: decimal(customer.creditLimit, 10),
        cashbackBalance: decimal(customer.cashbackBalance),
        createdAt: date(customer.createdAt) ?? new Date(),
        updatedAt: date(customer.updatedAt) ?? new Date()
      }
    });
  }

  for (const product of json.products ?? []) {
    await prisma.product.upsert({
      where: { id: product.id },
      update: {
        name: product.name,
        sku: product.sku || product.id,
        categoryId: product.categoryId || null,
        brand: product.brand || null,
        productType: product.productType || null,
        manufactureDate: date(product.manufactureDate),
        expirationDate: date(product.expirationDate),
        lotCode: product.lotCode || null,
        description: product.description || null,
        imageUrl: product.imageUrl || null,
        costPrice: decimal(product.costPrice),
        salePrice: decimal(product.salePrice),
        stock: Number(product.stock ?? 0),
        minStock: Number(product.minStock ?? 0),
        onlineAvailable: product.onlineAvailable ?? true,
        active: product.active ?? true,
        createdAt: date(product.createdAt) ?? new Date(),
        updatedAt: date(product.updatedAt) ?? new Date()
      },
      create: {
        id: product.id,
        name: product.name,
        sku: product.sku || product.id,
        categoryId: product.categoryId || null,
        brand: product.brand || null,
        productType: product.productType || null,
        manufactureDate: date(product.manufactureDate),
        expirationDate: date(product.expirationDate),
        lotCode: product.lotCode || null,
        description: product.description || null,
        imageUrl: product.imageUrl || null,
        costPrice: decimal(product.costPrice),
        salePrice: decimal(product.salePrice),
        stock: Number(product.stock ?? 0),
        minStock: Number(product.minStock ?? 0),
        onlineAvailable: product.onlineAvailable ?? true,
        active: product.active ?? true,
        createdAt: date(product.createdAt) ?? new Date(),
        updatedAt: date(product.updatedAt) ?? new Date()
      }
    });
  }

  for (const lot of json.productLots ?? []) {
    await prisma.productLot.upsert({
      where: { id: lot.id },
      update: {
        productId: lot.productId,
        code: lot.code,
        initialStock: Number(lot.initialStock ?? 0),
        currentStock: Number(lot.currentStock ?? 0),
        costPrice: decimal(lot.costPrice),
        totalCost: lot.totalCost === undefined ? null : decimal(lot.totalCost),
        salePrice: decimal(lot.salePrice),
        manufactureDate: date(lot.manufactureDate),
        expirationDate: date(lot.expirationDate),
        createdAt: date(lot.createdAt) ?? new Date()
      },
      create: {
        id: lot.id,
        productId: lot.productId,
        code: lot.code,
        initialStock: Number(lot.initialStock ?? 0),
        currentStock: Number(lot.currentStock ?? 0),
        costPrice: decimal(lot.costPrice),
        totalCost: lot.totalCost === undefined ? null : decimal(lot.totalCost),
        salePrice: decimal(lot.salePrice),
        manufactureDate: date(lot.manufactureDate),
        expirationDate: date(lot.expirationDate),
        createdAt: date(lot.createdAt) ?? new Date()
      }
    });
  }

  for (const movement of json.stockMovements ?? []) {
    await prisma.stockMovement.upsert({
      where: { id: movement.id },
      update: {},
      create: {
        id: movement.id,
        productId: movement.productId,
        type: movementType(movement.type),
        quantity: Number(movement.quantity ?? 0),
        totalCost: movement.totalCost === undefined ? null : decimal(movement.totalCost),
        costPrice: movement.costPrice === undefined ? null : decimal(movement.costPrice),
        salePrice: movement.salePrice === undefined ? null : decimal(movement.salePrice),
        manufactureDate: date(movement.manufactureDate),
        expirationDate: date(movement.expirationDate),
        lotCode: movement.lotCode || null,
        note: movement.note || null,
        createdAt: date(movement.createdAt) ?? new Date()
      }
    });
  }

  for (const entry of json.financeEntries ?? []) {
    await prisma.financeEntry.upsert({
      where: { id: entry.id },
      update: {},
      create: {
        id: entry.id,
        type: financeType(entry.type),
        description: entry.description,
        amount: decimal(entry.amount),
        category: entry.category || null,
        createdAt: date(entry.createdAt) ?? new Date()
      }
    });
  }

  for (const order of json.orders ?? []) {
    await prisma.order.upsert({
      where: { id: order.id },
      update: {},
      create: {
        id: order.id,
        saleType: saleType(order.saleType),
        customerId: order.customerId || null,
        customerName: order.customerName || "",
        customerPhone: order.customerPhone || "",
        customerCpf: order.customerCpf || "",
        paymentMethod: paymentMethod(order.paymentMethod),
        paymentStatus: paymentStatus(order.paymentStatus),
        source: source(order.source),
        amountPaid: decimal(order.amountPaid),
        amountDue: decimal(order.amountDue),
        cashbackUsed: decimal(order.cashbackUsed),
        cashbackEarned: decimal(order.cashbackEarned),
        cashbackReleased: order.cashbackReleased ?? false,
        status: orderStatus(order.status),
        cancelledAt: date(order.cancelledAt),
        cancelledById: order.cancelledBy || null,
        cancelledByName: order.cancelledByName || null,
        total: decimal(order.total),
        whatsappUrl: order.whatsappUrl || null,
        createdAt: date(order.createdAt) ?? new Date(),
        items: {
          create: (order.items ?? []).map((item: any) => ({
            id: item.id,
            productId: item.productId,
            quantity: Number(item.quantity ?? 0),
            unitPrice: decimal(item.unitPrice),
            costPrice: item.costPrice === undefined ? null : decimal(item.costPrice),
            total: decimal(item.unitPrice) * Number(item.quantity ?? 0),
            lotCode: item.lotCode || null
          }))
        }
      }
    });
  }

  for (const log of json.logs ?? []) {
    await prisma.systemLog.upsert({
      where: { id: log.id },
      update: {},
      create: {
        id: log.id,
        type: log.type === "login" ? LogType.LOGIN : LogType.ERROR,
        level: log.level === "error" ? LogLevel.ERROR : LogLevel.INFO,
        userId: log.userId || null,
        username: log.username || null,
        role: log.role ? role(log.role) : null,
        action: log.action,
        route: log.route || null,
        method: log.method || null,
        message: log.message,
        createdAt: date(log.createdAt) ?? new Date()
      }
    });
  }

  console.log("Importacao concluida.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
