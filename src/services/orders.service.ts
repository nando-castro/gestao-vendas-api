import { FinanceEntryType, Prisma, OrderSource, OrderStatus, PaymentMethod, PaymentStatus, SaleType, StockMovementType } from "@prisma/client";
import { prisma } from "../db/client.js";
import { emitInventoryUpdated, emitOrderCreated } from "../realtime/socket.js";

export type CreateOrderInput = {
  source?: "admin" | "client_page";
  saleType?: "avulso" | "cliente";
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  customerCpf?: string;
  paymentMethod?: "dinheiro" | "pix" | "cartao" | "fiado";
  amountPaid?: number;
  items: Array<{
    productId: string;
    quantity: number;
  }>;
};

type LockedProduct = {
  id: string;
  stock: number;
  onlineAvailable: boolean;
  active: boolean;
};

function toDecimal(value: number | Prisma.Decimal) {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

function mapSource(source: CreateOrderInput["source"]) {
  return source === "client_page" ? OrderSource.CLIENT_PAGE : OrderSource.ADMIN;
}

function mapSaleType(saleType: CreateOrderInput["saleType"]) {
  return saleType === "avulso" ? SaleType.AVULSO : SaleType.CLIENTE;
}

function mapPaymentMethod(method: CreateOrderInput["paymentMethod"]) {
  const value = method ?? "pix";
  const map = {
    dinheiro: PaymentMethod.DINHEIRO,
    pix: PaymentMethod.PIX,
    cartao: PaymentMethod.CARTAO,
    fiado: PaymentMethod.FIADO
  };
  return map[value];
}

export async function createOrderWithStockReservation(input: CreateOrderInput) {
  if (!input.items.length) throw new Error("Informe ao menos um produto.");

  const productIds = [...new Set(input.items.map((item) => item.productId))].sort();
  const quantities = new Map<string, number>();
  for (const item of input.items) {
    if (item.quantity <= 0) throw new Error("Quantidade invalida.");
    quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  }

  const result = await prisma.$transaction(async (tx) => {
    const lockedProducts = await tx.$queryRaw<LockedProduct[]>`
      SELECT id, stock, "onlineAvailable", active
      FROM products
      WHERE id = ANY(${productIds}::uuid[])
      ORDER BY id
      FOR UPDATE
    `;

    if (lockedProducts.length !== productIds.length) {
      throw new Error("Produto nao encontrado.");
    }

    const source = mapSource(input.source);
    for (const product of lockedProducts) {
      const requested = quantities.get(product.id) ?? 0;
      if (!product.active) throw new Error("Produto inativo.");
      if (source === OrderSource.CLIENT_PAGE && !product.onlineAvailable) {
        throw new Error("Produto indisponivel no pedido online.");
      }
      if (product.stock < requested) {
        throw new Error("Estoque insuficiente.");
      }
    }

    await tx.$queryRaw`
      SELECT id
      FROM product_lots
      WHERE "productId" = ANY(${productIds}::uuid[])
      ORDER BY "productId", "createdAt", code
      FOR UPDATE
    `;

    const createdItems: Prisma.OrderItemCreateManyOrderInput[] = [];
    const inventoryUpdates: Array<{ productId: string; stock: number; onlineAvailable: boolean }> = [];
    let orderTotal = new Prisma.Decimal(0);

    for (const productId of productIds) {
      let remaining = quantities.get(productId) ?? 0;
      const lots = await tx.productLot.findMany({
        where: { productId, currentStock: { gt: 0 } },
        orderBy: [{ createdAt: "asc" }, { code: "asc" }]
      });

      for (const lot of lots) {
        if (remaining <= 0) break;
        const quantity = Math.min(remaining, lot.currentStock);
        const unitPrice = toDecimal(lot.salePrice);
        const total = unitPrice.mul(quantity);

        await tx.productLot.update({
          where: { id: lot.id },
          data: { currentStock: { decrement: quantity } }
        });

        createdItems.push({
          productId,
          lotId: lot.id,
          quantity,
          unitPrice,
          costPrice: lot.costPrice,
          total,
          lotCode: lot.code
        });

        await tx.stockMovement.create({
          data: {
            productId,
            type: StockMovementType.OUT,
            quantity,
            costPrice: lot.costPrice,
            salePrice: unitPrice,
            lotCode: lot.code,
            note: "Venda"
          }
        });

        orderTotal = orderTotal.add(total);
        remaining -= quantity;
      }

      if (remaining > 0) throw new Error("Estoque por lote insuficiente.");

      const product = await tx.product.update({
        where: { id: productId },
        data: { stock: { decrement: quantities.get(productId) ?? 0 } },
        select: { id: true, stock: true, onlineAvailable: true }
      });
      inventoryUpdates.push({
        productId: product.id,
        stock: product.stock,
        onlineAvailable: product.onlineAvailable
      });
    }

    const amountPaid = toDecimal(input.amountPaid ?? (mapPaymentMethod(input.paymentMethod) === PaymentMethod.FIADO ? 0 : Number(orderTotal)));
    const amountDue = Prisma.Decimal.max(orderTotal.sub(amountPaid), new Prisma.Decimal(0));
    const paymentStatus = amountDue.equals(0) ? PaymentStatus.PAID : amountPaid.equals(0) ? PaymentStatus.PENDING : PaymentStatus.PARTIAL;

    const order = await tx.order.create({
      data: {
        source,
        saleType: mapSaleType(input.saleType),
        customerId: input.customerId || undefined,
        customerName: input.customerName ?? "",
        customerPhone: input.customerPhone ?? "",
        customerCpf: input.customerCpf ?? "",
        paymentMethod: mapPaymentMethod(input.paymentMethod),
        paymentStatus,
        amountPaid,
        amountDue,
        status: source === OrderSource.CLIENT_PAGE ? OrderStatus.WAITING : OrderStatus.DELIVERED,
        total: orderTotal,
        items: { createMany: { data: createdItems } }
      },
      include: { items: true }
    });

    if (amountPaid.gt(0)) {
      await tx.financeEntry.create({
        data: {
          type: FinanceEntryType.INCOME,
          description: `Pagamento venda ${order.id} - ${input.paymentMethod ?? "pix"}`,
          amount: amountPaid,
          category: `Vendas/${input.paymentMethod ?? "pix"}`
        }
      });
    }

    if (amountDue.gt(0)) {
      await tx.financeEntry.create({
        data: {
          type: FinanceEntryType.RECEIVABLE,
          description: `A receber venda ${order.id}`,
          amount: amountDue,
          category: "Vendas/fiado"
        }
      });
    }

    return { order, inventoryUpdates };
  });

  emitInventoryUpdated(result.inventoryUpdates);
  emitOrderCreated(result.order.id);

  return result.order;
}
