/**
 * 有限并发批量执行异步任务（CR-4）：按 limit 启动固定数量的 lane，逐个从队列取任务。
 * 单个任务失败不中断其余任务（Promise.allSettled 语义），结果按输入顺序返回。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index]!;
      try {
        results[index] = { status: 'fulfilled', value: await worker(item, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(lanes);
  return results;
}
