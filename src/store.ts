import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type Product = {
  id: string;
  name: string;
  sku: string;
  categoryId?: string;
  brand?: string;
  productType?: string;
  manufactureDate?: string;
  expirationDate?: string;
  lotCode?: string;
  description?: string | null;
  imageUrl?: string | null;
  costPrice: number;
  salePrice: number;
  stock: number;
  minStock: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProductCategory = {
  id: string;
  name: string;
  description?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type StockMovement = {
  id: string;
  productId: string;
  type: "in" | "out" | "adjustment";
  quantity: number;
  totalCost?: number;
  costPrice?: number;
  salePrice?: number;
  manufactureDate?: string;
  expirationDate?: string;
  lotCode?: string;
  note?: string;
  createdAt: string;
};

export type ProductLot = {
  id: string;
  productId: string;
  code: string;
  initialStock: number;
  currentStock: number;
  costPrice: number;
  totalCost?: number;
  salePrice: number;
  manufactureDate?: string;
  expirationDate?: string;
  createdAt: string;
};

export type FinanceEntry = {
  id: string;
  type: "income" | "expense" | "receivable";
  description: string;
  amount: number;
  category?: string;
  createdAt: string;
};

export type Customer = {
  id: string;
  name: string;
  phone?: string;
  cpf?: string;
  email?: string;
  address?: string;
  notes?: string;
  creditLimit?: number;
  cashbackBalance?: number;
  createdAt: string;
  updatedAt: string;
};

export type UserRole = "admin" | "usuario" | "cliente";

export type User = {
  id: string;
  name: string;
  username: string;
  role: UserRole;
  passwordHash: string;
  salt: string;
  permissions: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SystemLog = {
  id: string;
  type: "login" | "error";
  level: "info" | "error";
  userId?: string;
  username?: string;
  role?: UserRole;
  action: string;
  route?: string;
  method?: string;
  message: string;
  createdAt: string;
};

export type Order = {
  id: string;
  saleType: "avulso" | "cliente";
  customerId?: string;
  customerName: string;
  customerPhone: string;
  paymentMethod: string;
  paymentStatus: "paid" | "partial" | "pending";
  source?: "admin" | "client_page";
  amountPaid: number;
  amountDue: number;
  cashbackUsed?: number;
  cashbackEarned?: number;
  cashbackReleased?: boolean;
  status: string;
  cancelledAt?: string;
  cancelledBy?: string;
  cancelledByName?: string;
  total: number;
  whatsappUrl?: string;
  createdAt: string;
  items: Array<{ id: string; productId: string; quantity: number; unitPrice: number; costPrice?: number; lotCode?: string; product?: Product }>;
};

type Data = {
  products: Product[];
  categories: ProductCategory[];
  productLots: ProductLot[];
  stockMovements: StockMovement[];
  financeEntries: FinanceEntry[];
  orders: Order[];
  customers: Customer[];
  users: User[];
  logs: SystemLog[];
};

const empty: Data = { products: [], categories: [], productLots: [], stockMovements: [], financeEntries: [], orders: [], customers: [], users: [], logs: [] };
const file = resolve(process.env.DATA_FILE ?? "./data/pedidos.json");

function skuPart(value: string, fallback: string) {
  const letters = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  return (letters || fallback).slice(0, 3).padEnd(3, fallback.slice(0, 1));
}

function lotCodeFromProduct(product: Product) {
  const parts = product.sku?.split("-").filter(Boolean) ?? [];
  const prefix = parts.length >= 2 ? `LOTE-${parts[0]}-${parts[1]}-` : `LOTE-${skuPart(product.name, "PRO")}-`;
  return `${prefix}001`;
}

async function readData(): Promise<Data> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as Partial<Data>;
    const normalized: Data = {
      products: data.products ?? [],
      categories: data.categories ?? [],
      productLots: data.productLots ?? [],
      stockMovements: data.stockMovements ?? [],
      financeEntries: data.financeEntries ?? [],
      orders: data.orders ?? [],
      customers: data.customers ?? [],
      users: data.users ?? [],
      logs: data.logs ?? []
    };
    for (const product of normalized.products) {
      const hasLot = normalized.productLots.some((lot) => lot.productId === product.id);
      if (hasLot) continue;
      const soldQuantity = normalized.orders
        .flatMap((order) => order.items)
        .filter((item) => item.productId === product.id)
        .reduce((sum, item) => sum + item.quantity, 0);
      const code = product.lotCode || lotCodeFromProduct(product);
      product.lotCode = code;
      normalized.productLots.push({
        id: crypto.randomUUID(),
        productId: product.id,
        code,
        initialStock: product.stock + soldQuantity,
        currentStock: product.stock,
        costPrice: product.costPrice,
        salePrice: product.salePrice,
        createdAt: product.createdAt
      });
    }
    return normalized;
  } catch {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(empty, null, 2));
    return structuredClone(empty);
  }
}

async function writeData(data: Data) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

export async function transact<T>(fn: (data: Data) => T | Promise<T>) {
  const data = await readData();
  const result = await fn(data);
  await writeData(data);
  return result;
}

export async function snapshot() {
  return readData();
}

export function id() {
  return crypto.randomUUID();
}
