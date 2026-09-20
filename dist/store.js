import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const empty = { products: [], categories: [], productLots: [], stockMovements: [], financeEntries: [], orders: [], customers: [], users: [], logs: [] };
const file = resolve(process.env.DATA_FILE ?? "./data/pedidos.json");
function skuPart(value, fallback) {
    const letters = value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]/g, "")
        .toUpperCase();
    return (letters || fallback).slice(0, 3).padEnd(3, fallback.slice(0, 1));
}
function lotCodeFromProduct(product) {
    const parts = product.sku?.split("-").filter(Boolean) ?? [];
    const prefix = parts.length >= 2 ? `LOTE-${parts[0]}-${parts[1]}-` : `LOTE-${skuPart(product.name, "PRO")}-`;
    return `${prefix}001`;
}
async function readData() {
    try {
        const data = JSON.parse(await readFile(file, "utf8"));
        let changed = false;
        const normalized = {
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
            if (product.onlineAvailable === undefined) {
                product.onlineAvailable = true;
                changed = true;
            }
            const hasLot = normalized.productLots.some((lot) => lot.productId === product.id);
            if (!hasLot) {
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
                changed = true;
            }
            const lots = normalized.productLots
                .filter((lot) => lot.productId === product.id && lot.currentStock > 0)
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            let lotStock = lots.reduce((sum, lot) => sum + lot.currentStock, 0);
            let excess = lotStock - product.stock;
            if (excess > 0) {
                for (const lot of lots) {
                    if (excess <= 0)
                        break;
                    const quantity = Math.min(excess, lot.currentStock);
                    lot.currentStock -= quantity;
                    excess -= quantity;
                }
                changed = true;
            }
        }
        if (changed)
            await writeData(normalized);
        return normalized;
    }
    catch {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(empty, null, 2));
        return structuredClone(empty);
    }
}
async function writeData(data) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2));
}
export async function transact(fn) {
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
