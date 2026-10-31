async function waitForAutomaticCommentSlot(generation) {
  while (isTaskActive(generation)) {
    const result = await chrome.runtime.sendMessage({ type: "requestAutomaticCommentSlot", runId: settings.automationRunId || "" });
    if (!isTaskActive(generation)) {
      if (result?.token) await chrome.runtime.sendMessage({ type: "cancelAutomaticCommentSlot", token: result.token }).catch(() => {});
      throw new Error("任务已停止");
    }
    if (result?.stopped) throw new Error("任务已停止");
    if (result?.error) throw new Error(result.error);
    if (result?.token) return result.token;
    const waitMs = Math.max(100, Number(result?.retryAfterMs) || 1000);
    const text = `评论间隔为 15 秒，等待 ${Math.ceil(waitMs / 1000)} 秒后发送`;
    await chrome.storage.local.set({ lastAutomationStatus: text });
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, waitMs)));
  }
  throw new Error("任务已停止");
}
