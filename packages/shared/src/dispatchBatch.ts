import { MAX_DISPATCH_IMAGE_BYTES, MAX_DISPATCH_IMAGE_COUNT } from './constants.js';

export interface DispatchBatchItem { size_bytes: number }

export function selectDispatchBatch<T extends DispatchBatchItem>(items: readonly T[]): T[] {
  const batch: T[] = [];
  let totalBytes = 0;
  for (const item of items) {
    if (batch.length >= MAX_DISPATCH_IMAGE_COUNT || totalBytes + item.size_bytes > MAX_DISPATCH_IMAGE_BYTES) break;
    batch.push(item);
    totalBytes += item.size_bytes;
  }
  return batch;
}
