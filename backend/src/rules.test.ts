import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateOldestFirst, calculateAfter, normalizeUniqueSkus, stockLabel, summarizeCost, summarizeOldBatches } from './rules.js';

test('receipts and reductions preserve nonnegative integer stock', () => {
  assert.equal(calculateAfter(4, 3), 7);
  assert.equal(calculateAfter(4, -2), 2);
  assert.throws(() => calculateAfter(1, -2), /Stock cannot be reduced below zero/);
  assert.throws(() => calculateAfter(1.5, -1), /Invalid quantity/);
});

test('classifies low, empty, and available variants', () => {
  assert.equal(stockLabel(0, 2), 'OUT');
  assert.equal(stockLabel(2, 2), 'LOW');
  assert.equal(stockLabel(3, 2), 'IN');
});

test('normalizes SKU values and rejects duplicates without regard to case', () => {
  assert.deepEqual(normalizeUniqueSkus([' tf-1-m ', 'TF-1-L']), ['TF-1-M', 'TF-1-L']);
  assert.throws(() => normalizeUniqueSkus(['tf-1-m', ' TF-1-M ']), /must be unique/);
});

test('reports known stock cost and explicitly counts missing costs', () => {
  const value = summarizeCost([
    { remainingQty: 2, unitCostPaise: 12500, receivedAt: new Date('2026-01-01T00:00:00Z') },
    { remainingQty: 3, unitCostPaise: null, receivedAt: new Date('2026-02-01T00:00:00Z') },
  ]);
  assert.deepEqual(value, { valuePaise: 25000, unknownCostPieces: 3 });
});

test('old-stock classification is based on remaining batch receipt dates and handles missing history', () => {
  const cutoff = new Date('2026-04-01T00:00:00Z');
  const result = summarizeOldBatches([
    { remainingQty: 2, unitCostPaise: 10000, receivedAt: new Date('2026-01-01T00:00:00Z') },
    { remainingQty: 4, unitCostPaise: 10000, receivedAt: new Date('2026-05-01T00:00:00Z') },
    { remainingQty: 0, unitCostPaise: null, receivedAt: new Date('2025-01-01T00:00:00Z') },
  ], cutoff);
  assert.equal(result.oldQuantity, 2);
  assert.equal(result.valuePaise, 20000);
  assert.equal(result.unknownCostPieces, 0);
  assert.equal(summarizeOldBatches([], cutoff).oldestReceipt, null);
});

test('reductions consume the oldest batches first and reject inconsistent batch totals', () => {
  assert.deepEqual(allocateOldestFirst([{id:'old',remainingQty:2},{id:'new',remainingQty:4}],3),[
    {id:'old',quantity:2},{id:'new',quantity:1},
  ]);
  assert.throws(() => allocateOldestFirst([{id:'old',remainingQty:1}],2),/do not match/);
});
