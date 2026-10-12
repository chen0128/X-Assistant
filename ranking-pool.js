let rankingPoolOperations = Promise.resolve();
function withRankingPoolLock(operation) {
  const next = rankingPoolOperations.then(operation);
  rankingPoolOperations = next.catch(() => {});
  return next;
}
async function rankingPoolState() {
  return chrome.storage.local.get(["rankingPool", "automationRunning", "automationTask", "automationTargetTabId", "rankingJob"]);
}
async function publishRankingPool(pool) {
  const completed = pool.workers.filter((worker) => worker.done).length;
  const text = `榜单并行：${pool.workers.length - completed} 路运行，${completed}/${pool.workers.length} 路完成\n` +
    pool.workers.map((worker, index) => `${index + 1}：${worker.status || "准备中"}`).join("\n");
  await chrome.storage.local.set({ rankingPool: pool, rankingStatus: text, lastAutomationStatus: text, lastAutomationError: "" });
}
async function startRankingPool(senderTabId) {
  const state = await rankingPoolState();
  if (!state.automationRunning || state.automationTask !== "ranking" || state.automationTargetTabId !== senderTabId) throw new Error("榜单任务已停止或控制标签页不匹配");
  const job = state.rankingJob;
  if (!job?.queue?.length) throw new Error("榜单队列为空");
  if (state.rankingPool?.id === job.id) return;
  if (state.rankingPool) {
    await chrome.storage.local.set({ rankingPool: null });
    for (const worker of state.rankingPool.workers) await chrome.tabs.remove(worker.tabId).catch(() => {});
  }
  const count = Math.min(job.queue.length, Math.max(1, Math.min(10, Number(job.concurrency) || 1)));
  const pool = { id: job.id, coordinatorTabId: senderTabId, workers: [] };
  try {
    for (let index = 0; index < count; index += 1) {
      const current = await rankingPoolState();
      if (!current.automationRunning || current.automationTask !== "ranking" || current.rankingJob?.id !== job.id) throw new Error("任务已停止");
      const queue = job.queue.filter((_, position) => position % count === index);
      const jobKey = `rankingWorkerJob:${job.id}:${index}`;
      const tab = await chrome.tabs.create({ url: "about:blank", active: false });
      pool.workers.push({ tabId: tab.id, jobKey, done: false, status: `待处理 ${queue.length} 位博主` });
      await chrome.storage.local.set({ [jobKey]: { ...job, queue, index: 0, stage: "posts", commentPostId: null, retryAt: 0 } });
      await publishRankingPool(pool);
      await chrome.tabs.update(tab.id, { url: `https://x.com/${queue[0].username}` });
    }
  } catch (error) {
    await chrome.storage.local.set({ rankingPool: null });
    for (const worker of pool.workers) await chrome.tabs.remove(worker.tabId).catch(() => {});
    throw error;
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["startRankingPool", "rankingWorkerStatus", "rankingWorkerDone"].includes(message?.type)) return;
  withRankingPoolLock(async () => {
    if (message.type === "startRankingPool") { await startRankingPool(sender.tab?.id); return { ok: true }; }
    const state = await rankingPoolState();
    const pool = state.rankingPool;
    const worker = pool?.workers.find((item) => item.tabId === sender.tab?.id && item.jobKey === message.jobKey);
    if (!worker || !state.automationRunning || state.automationTask !== "ranking" || state.rankingJob?.id !== pool.id) return { stopped: true };
    worker.status = String(message.status || "").slice(0, 300);
    if (message.type === "rankingWorkerDone") worker.done = true;
    await publishRankingPool(pool);
    if (pool.workers.every((item) => item.done)) {
      await chrome.storage.local.set({ automationRunning: false, lastAutomationStatus: "榜单并行任务已完成，所有分配账号均已检查" });
    }
    return { ok: true };
  }).then(sendResponse).catch((error) => sendResponse({ error: error.message }));
  return true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(changes.automationRunning || changes.automationTask)) return;
  withRankingPoolLock(async () => {
    const state = await rankingPoolState();
    if (state.automationRunning && state.automationTask === "ranking") return;
    if (!state.rankingPool) return;
    await chrome.storage.local.set({ rankingPool: null });
    for (const worker of state.rankingPool.workers) await chrome.tabs.remove(worker.tabId).catch(() => {});
  }).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  withRankingPoolLock(async () => {
    const state = await rankingPoolState();
    if (!state.rankingPool || !state.automationRunning || state.automationTask !== "ranking") return;
    const worker = state.rankingPool.workers.find((item) => item.tabId === tabId && !item.done);
    if (worker || state.rankingPool.coordinatorTabId === tabId) {
      await chrome.storage.local.set({ automationRunning: false, lastAutomationStatus: "榜单任务标签页已关闭，已停止全部并行任务" });
    }
  }).catch(() => {});
});
