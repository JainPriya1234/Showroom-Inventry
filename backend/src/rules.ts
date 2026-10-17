export function calculateAfter(before: number, delta: number) {
  if (!Number.isInteger(before) || !Number.isInteger(delta) || before < 0) throw new Error('Invalid quantity');
  const after = before + delta;
  if (after < 0) throw new Error('Stock cannot be reduced below zero');
  return after;
}

export function stockLabel(quantity: number, reorderAt: number) {
  if (quantity === 0) return 'OUT';
  if (quantity <= reorderAt) return 'LOW';
  return 'IN';
}

export function normalizeUniqueSkus(skus: string[]) {
  const normalized = skus.map((sku) => sku.trim().toUpperCase());
  if (normalized.some((sku) => !sku) || new Set(normalized).size !== normalized.length) throw new Error('Variant SKUs must be unique and non-empty.');
  return normalized;
}

export type CostBatch = { remainingQty: number; unitCostPaise: number | null; receivedAt: Date };

export function summarizeCost(batches: CostBatch[]) {
  return batches.reduce((summary, batch) => {
    if (batch.unitCostPaise == null) summary.unknownCostPieces += batch.remainingQty;
    else summary.valuePaise += batch.remainingQty * batch.unitCostPaise;
    return summary;
  }, { valuePaise: 0, unknownCostPieces: 0 });
}

export function summarizeOldBatches(batches: CostBatch[], cutoff: Date) {
  const oldBatches = batches.filter((batch) => batch.remainingQty > 0 && batch.receivedAt < cutoff);
  const cost = summarizeCost(oldBatches);
  return {
    batches: oldBatches,
    oldQuantity: oldBatches.reduce((sum, batch) => sum + batch.remainingQty, 0),
    oldestReceipt: oldBatches[0]?.receivedAt ?? null,
    ...cost,
  };
}

export function allocateOldestFirst(batches: { id: string; remainingQty: number }[], quantity: number) {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Reduction must be a positive whole number.');
  let remaining = quantity;
  const allocations: { id: string; quantity: number }[] = [];
  for (const batch of batches) {
    const used = Math.min(remaining, batch.remainingQty);
    if (used > 0) allocations.push({ id: batch.id, quantity: used });
    remaining -= used;
    if (!remaining) break;
  }
  if (remaining > 0) throw new Error('Stock batches do not match the current stock balance.');
  return allocations;
}
