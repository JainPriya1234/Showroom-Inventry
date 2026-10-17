import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { allocateOldestFirst, calculateAfter, normalizeUniqueSkus, summarizeCost, summarizeOldBatches } from '../rules.js';

export const inventoryRouter = Router();
const variantInput = z.object({
  sku: z.string().trim().min(1).max(80), size: z.string().trim().max(40).optional().nullable(), colour: z.string().trim().max(60).optional().nullable(),
  quantity: z.number().int().min(0).max(1_000_000), purchasePaise: z.number().int().min(0).max(2_000_000_000).optional().nullable(),
  sellingPaise: z.number().int().min(0).max(2_000_000_000).optional().nullable(), reorderAt: z.number().int().min(0).max(1_000_000).default(2),
});
const productInput = z.object({
  code: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(120), categoryId: z.string().min(1), supplierId: z.string().optional().nullable(),
  brand: z.string().trim().max(100).optional().nullable(), description: z.string().trim().max(2000).optional().nullable(), imageUrl: z.string().url().optional().or(z.literal('')),
  variants: z.array(variantInput).min(1),
});
const movementInput = z.object({ type: z.enum(['RECEIPT', 'CORRECTION', 'DAMAGE', 'MISSING', 'RETURN', 'OTHER']), delta: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0), reason: z.string().trim().min(2).max(300), unitCostPaise: z.number().int().min(0).max(2_000_000_000).optional().nullable() });

inventoryRouter.get('/dashboard', async (_req, res, next) => {
  try {
    const [products, variants, recent, oldVariants] = await Promise.all([
      prisma.product.count({ where: { active: true } }),
      prisma.variant.findMany({ where: { product: { active: true } }, include: { batches: true, product: { select: { name: true, code: true } } } }),
      prisma.product.findMany({ where: { active: true }, orderBy: { createdAt: 'desc' }, take: 5, include: { category: true, variants: true } }),
      prisma.variant.findMany({ where: { quantity: { gt: 0 }, product: { active: true } }, include: { product: true, batches: { where: { remainingQty: { gt: 0 } }, orderBy: { receivedAt: 'asc' } } } }),
    ]);
    let valuePaise = 0; let unknownCostVariants = 0;
    for (const variant of variants) {
      if (!variant.quantity) continue;
      const cost = summarizeCost(variant.batches.filter((b) => b.remainingQty > 0));
      valuePaise += cost.valuePaise;
      const recordedBatchQty = variant.batches.reduce((sum,b)=>sum+b.remainingQty,0);
      if (cost.unknownCostPieces || recordedBatchQty < variant.quantity) unknownCostVariants++;
    }
    const low = variants.filter((v) => v.quantity > 0 && v.quantity <= v.reorderAt);
    const out = variants.filter((v) => v.quantity === 0);
    const cutoff = new Date(Date.now() - 90 * 86400000);
    const old = oldVariants.filter((v) => v.batches.some((b) => b.remainingQty > 0 && b.receivedAt < cutoff));
    res.json({ productCount: products, totalPieces: variants.reduce((n, v) => n + v.quantity, 0), valuePaise, unknownCostVariants,
      lowStockCount: low.length, outOfStockCount: out.length, oldStockCount: old.length,
      lowStock: low.slice(0, 6), outOfStock: out.slice(0, 6),
      oldStock: old.slice(0, 6).map((v) => ({ ...v, ...summarizeOldBatches(v.batches, cutoff) })), recent });
  } catch (error) { next(error); }
});

inventoryRouter.get('/products', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1); const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 12));
    const search = String(req.query.search ?? '').trim(); const status = String(req.query.status ?? ''); const sort = String(req.query.sort ?? 'name');
    const where: any = { active: req.query.archived === 'true' ? false : true };
    if (search) where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { code: { contains: search, mode: 'insensitive' } },
      { variants: { some: { OR: [
        { sku: { contains: search, mode: 'insensitive' } },
        { size: { contains: search, mode: 'insensitive' } },
        { colour: { contains: search, mode: 'insensitive' } },
      ] } } },
    ];
    if (req.query.categoryId) where.categoryId = String(req.query.categoryId);
    if (req.query.supplierId) where.supplierId = String(req.query.supplierId);
    const relationFilters: object[] = [];
    if (req.query.size) relationFilters.push({ variants: { some: { size: String(req.query.size) } } });
    if (status === 'out') relationFilters.push({ variants: { some: { quantity: 0 } } });
    if (status === 'in') relationFilters.push({ variants: { every: { quantity: { gt: 0 } } } });
    if (relationFilters.length) where.AND = relationFilters;
    if (status === 'low') {
      // Prisma cannot compare two columns in a relation filter, so evaluate each variant threshold here.
      const lowVariants = await prisma.variant.findMany({ where: { quantity: { gt: 0 }, product: { active: true } }, select: { productId: true, quantity: true, reorderAt: true } });
      where.id = { in: [...new Set(lowVariants.filter((v) => v.quantity <= v.reorderAt).map((v) => v.productId))] };
    }
    const total = await prisma.product.count({ where });
    if (sort === 'quantity' || sort === 'value') {
      const candidates = await prisma.product.findMany({ where, include: { category: true, supplier: true, variants: { include: { batches: true } } } });
      candidates.sort((a, b) => {
        if (sort === 'quantity') return b.variants.reduce((n,v)=>n+v.quantity,0) - a.variants.reduce((n,v)=>n+v.quantity,0);
        const inventoryValue = (p: typeof a) => p.variants.reduce((sum,v)=>sum+v.batches.reduce((batchSum,b)=>batchSum+b.remainingQty*(b.unitCostPaise??0),0),0);
        return inventoryValue(b)-inventoryValue(a);
      });
      return res.json({ items: candidates.slice((page-1)*limit,page*limit), page, limit, total, pages: Math.ceil(total/limit) });
    }
    const orderBy = sort === 'oldest' ? { createdAt: 'asc' as const } : sort === 'newest' ? { createdAt: 'desc' as const } : { name: 'asc' as const };
    const rows = await prisma.product.findMany({ where, include: { category: true, supplier: true, variants: true }, orderBy, skip: (page - 1) * limit, take: limit });
    res.json({ items: rows, page, limit, total, pages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
});

inventoryRouter.get('/sizes', async (_req, res, next) => {
  try { const rows = await prisma.variant.findMany({ where: { size: { not: null } }, select: { size: true }, distinct: ['size'], orderBy: { size: 'asc' } }); res.json(rows.map((row) => row.size).filter(Boolean)); } catch (error) { next(error); }
});

inventoryRouter.post('/products', async (req, res, next) => {
  try {
    const input = productInput.parse(req.body);
    let normalizedSkus: string[];
    try { normalizedSkus = normalizeUniqueSkus(input.variants.map((v) => v.sku)); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : 'Variant SKUs must be unique.' }); }
    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({ data: { ...input, code: input.code.toUpperCase(), imageUrl: input.imageUrl || null, variants: { create: input.variants.map(({ quantity, ...v }, index) => ({ ...v, sku: normalizedSkus[index], quantity })) } }, include: { variants: true, category: true, supplier: true } });
      for (const variant of created.variants) if (variant.quantity > 0) {
        await tx.stockBatch.create({ data: { variantId: variant.id, receivedQty: variant.quantity, remainingQty: variant.quantity, unitCostPaise: variant.purchasePaise } });
        await tx.inventoryMovement.create({ data: { variantId: variant.id, type: 'OPENING', delta: variant.quantity, beforeQty: 0, afterQty: variant.quantity, reason: 'Opening stock' } });
      }
      return created;
    });
    res.status(201).json(product);
  } catch (error) { next(error); }
});

inventoryRouter.get('/products/:id', async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: {
        category: true,
        supplier: true,
        variants: {
          include: {
            batches: { orderBy: { receivedAt: 'asc' } },
            movements: { orderBy: { createdAt: 'desc' }, take: 20 },
          },
        },
      },
    });
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    res.json(product);
  } catch (error) { next(error); }
});

inventoryRouter.patch('/products/:id', async (req, res, next) => {
  try {
    const input = z.object({ name: z.string().trim().min(1), code: z.string().trim().min(1), categoryId: z.string(), supplierId: z.string().nullable().optional(), brand: z.string().nullable().optional(), description: z.string().nullable().optional(), imageUrl: z.string().url().nullable().optional() }).parse(req.body);
    res.json(await prisma.product.update({ where: { id: req.params.id }, data: { ...input, code: input.code.toUpperCase() }, include: { category: true, supplier: true, variants: true } }));
  } catch (error) { next(error); }
});

inventoryRouter.post('/products/:id/archive', async (req, res, next) => {
  try { res.json(await prisma.product.update({ where: { id: req.params.id }, data: { active: false } })); } catch (error) { next(error); }
});

inventoryRouter.post('/products/:id/variants', async (req, res, next) => {
  try {
    const input = variantInput.parse(req.body);
    const result = await prisma.$transaction(async (tx) => {
      const variant = await tx.variant.create({ data: { ...input, sku: input.sku.toUpperCase(), quantity: input.quantity, productId: req.params.id } });
      if (input.quantity > 0) {
        await tx.stockBatch.create({ data: { variantId: variant.id, receivedQty: input.quantity, remainingQty: input.quantity, unitCostPaise: input.purchasePaise } });
        await tx.inventoryMovement.create({ data: { variantId: variant.id, type: 'OPENING', delta: input.quantity, beforeQty: 0, afterQty: input.quantity, reason: 'Opening stock' } });
      }
      return variant;
    }, { isolationLevel: 'Serializable' });
    res.status(201).json(result);
  } catch (error) { next(error); }
});

inventoryRouter.post('/variants/:id/movements', async (req, res, next) => {
  try {
    const input = movementInput.parse(req.body);
    if ((input.type === 'RECEIPT' || input.type === 'RETURN') && input.delta < 0) return res.status(400).json({ error: 'Receipts and returns must add pieces.' });
    if ((input.type === 'DAMAGE' || input.type === 'MISSING') && input.delta > 0) return res.status(400).json({ error: 'Damage and missing stock must reduce pieces.' });
    const result = await prisma.$transaction(async (tx) => {
      const variant = await tx.variant.findUniqueOrThrow({ where: { id: req.params.id }, include: { batches: { where: { remainingQty: { gt: 0 } }, orderBy: { receivedAt: 'asc' } } } });
      const afterQty = calculateAfter(variant.quantity, input.delta);
      const batchAllocations = input.delta < 0 ? allocateOldestFirst(variant.batches, -input.delta) : [];
      const updated = await tx.variant.update({ where: { id: variant.id }, data: { quantity: afterQty, ...(input.delta > 0 && input.unitCostPaise != null ? { purchasePaise: input.unitCostPaise } : {}) } });
      if (input.delta > 0) await tx.stockBatch.create({ data: { variantId: variant.id, receivedQty: input.delta, remainingQty: input.delta, unitCostPaise: input.unitCostPaise ?? variant.purchasePaise } });
      for (const allocation of batchAllocations) await tx.stockBatch.update({ where: { id: allocation.id }, data: { remainingQty: { decrement: allocation.quantity } } });
      const movement = await tx.inventoryMovement.create({ data: { variantId: variant.id, type: input.type, delta: input.delta, beforeQty: variant.quantity, afterQty, reason: input.reason } });
      return { variant: updated, movement };
    }, { isolationLevel: 'Serializable' });
    res.status(201).json(result);
  } catch (error) { next(error); }
});

inventoryRouter.get('/products/:id/movements', async (req, res, next) => {
  try { const items = await prisma.inventoryMovement.findMany({ where: { variant: { productId: req.params.id } }, include: { variant: true }, orderBy: { createdAt: 'desc' }, take: 100 }); res.json(items); } catch (error) { next(error); }
});

inventoryRouter.get('/old-stock', async (req, res, next) => {
  try {
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 90)); const cutoff = new Date(Date.now() - days * 86400000);
    const variants = await prisma.variant.findMany({ where: { quantity: { gt: 0 }, product: { active: true } }, include: { product: { include: { category: true } }, batches: { where: { remainingQty: { gt: 0 }, receivedAt: { lt: cutoff } }, orderBy: { receivedAt: 'asc' } }, movements: { orderBy: { createdAt: 'desc' }, take: 1 } } });
    res.json(variants.map((v) => ({ ...v, ...summarizeOldBatches(v.batches, cutoff), lastMovement: v.movements[0]?.createdAt ?? null, salesData: null })).filter((v) => v.oldQuantity > 0));
  } catch (error) { next(error); }
});

inventoryRouter.get('/categories', async (_req, res, next) => { try { res.json(await prisma.category.findMany({ where: { archived: false }, orderBy: { name: 'asc' } })); } catch (error) { next(error); } });
inventoryRouter.post('/categories', async (req, res, next) => { try { const { name } = z.object({ name: z.string().trim().min(2).max(60) }).parse(req.body); res.status(201).json(await prisma.category.create({ data: { name } })); } catch (error) { next(error); } });
inventoryRouter.patch('/categories/:id', async (req, res, next) => { try { const { name, archived } = z.object({ name: z.string().trim().min(2).max(60).optional(), archived: z.boolean().optional() }).parse(req.body); if (archived) { const used = await prisma.product.count({ where: { categoryId: req.params.id } }); if (used) return res.status(409).json({ error: 'This category is used by products. Move them to another category before archiving it.' }); } res.json(await prisma.category.update({ where: { id: req.params.id }, data: { name, archived } })); } catch (error) { next(error); } });
inventoryRouter.get('/suppliers', async (_req, res, next) => { try { res.json(await prisma.supplier.findMany({ where: { archived: false }, orderBy: { name: 'asc' } })); } catch (error) { next(error); } });
inventoryRouter.post('/suppliers', async (req, res, next) => { try { const input = z.object({ name: z.string().trim().min(2), contactPerson: z.string().optional().nullable(), phone: z.string().optional().nullable(), city: z.string().optional().nullable(), notes: z.string().optional().nullable() }).parse(req.body); res.status(201).json(await prisma.supplier.create({ data: input })); } catch (error) { next(error); } });
inventoryRouter.patch('/suppliers/:id', async (req, res, next) => { try { const input = z.object({ name: z.string().trim().min(2).optional(), contactPerson: z.string().nullable().optional(), phone: z.string().nullable().optional(), city: z.string().nullable().optional(), notes: z.string().nullable().optional(), archived: z.boolean().optional() }).parse(req.body); res.json(await prisma.supplier.update({ where: { id: req.params.id }, data: input })); } catch (error) { next(error); } });

inventoryRouter.get('/export.csv', async (_req, res, next) => {
  try {
    const products = await prisma.product.findMany({ where: { active: true }, include: { category: true, supplier: true, variants: true }, orderBy: { name: 'asc' } });
    const quote = (s: unknown) => `"${String(s ?? '').replaceAll('"', '""')}"`;
    const lines = ['Product,Code,Category,Size,Colour,SKU,Quantity,Purchase cost (paise),Selling price (paise),Supplier'];
    for (const p of products) for (const v of p.variants) lines.push([p.name, p.code, p.category.name, v.size, v.colour, v.sku, v.quantity, v.purchasePaise, v.sellingPaise, p.supplier?.name].map(quote).join(','));
    res.type('text/csv').attachment('inventory.csv').send(lines.join('\n'));
  } catch (error) { next(error); }
});

inventoryRouter.get('/old-stock.csv', async (req, res, next) => {
  try {
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 90)); const cutoff = new Date(Date.now() - days * 86400000);
    const variants = await prisma.variant.findMany({
      where: { quantity: { gt: 0 }, product: { active: true } },
      include: {
        product: true,
        batches: { where: { remainingQty: { gt: 0 }, receivedAt: { lt: cutoff } }, orderBy: { receivedAt: 'asc' } },
        movements: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    const quote = (s: unknown) => `"${String(s ?? '').replaceAll('"', '""')}"`;
    const lines = ['Product,Code,Size,Colour,SKU,Old quantity,Oldest receipt,Last stock movement,Known value (paise),Pieces with unknown cost'];
    for (const v of variants.filter((row) => row.batches.length)) {
      const quantity = v.batches.reduce((sum,b)=>sum+b.remainingQty,0); const value = v.batches.reduce((sum,b)=>sum+b.remainingQty*(b.unitCostPaise??0),0); const unknown = v.batches.filter((b)=>b.unitCostPaise==null).reduce((sum,b)=>sum+b.remainingQty,0);
      lines.push([v.product.name,v.product.code,v.size,v.colour,v.sku,quantity,v.batches[0].receivedAt.toISOString(),v.movements[0]?.createdAt.toISOString()??'',value,unknown].map(quote).join(','));
    }
    res.type('text/csv').attachment(`old-stock-${days}-days.csv`).send(lines.join('\n'));
  } catch (error) { next(error); }
});
