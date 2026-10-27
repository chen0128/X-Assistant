const AUTOMATIC_COMMENT_INTERVAL_MS = 15000;
const AUTOMATIC_COMMENT_LEASE_MS = 5000;
let automaticCommentOperations = Promise.resolve();
function withAutomaticCommentLock(operation) {
  const next = automaticCommentOperations.then(operation);
  automaticCommentOperations = next.catch(() => {});
  return next;
}
async function automaticCommentState() {
  return chrome.storage.local.get(["automationRunning", "automationTask", "automationRunId", "automationTargetTabId", "rankingPool", "automaticCommentRate"]);
}
function automaticCommentSenderAllowed(state, sender, runId) {
  if (!state.automationRunning || (state.automationRunId || "") !== (runId || "")) return false;
  if (state.automationTask === "engagement") return state.automationTargetTabId === sender.tab?.id;
  return state.automationTask === "ranking" && state.rankingPool?.workers.some((worker) => worker.tabId === sender.tab?.id && !worker.done);
}
async function handleAutomaticComment(message, sender) {
  const state = await automaticCommentState();
  const rate = state.automaticCommentRate || { nextAllowedAt: 0, lease: null };
  const now = Date.now();
  if (message.type === "cancelAutomaticCommentSlot") {
    if (rate.lease?.token === message.token && rate.lease.tabId === sender.tab?.id) {
      await chrome.storage.local.set({ automaticCommentRate: { ...rate, lease: null } });
    }
    return { canceled: true };
  }
  if (!automaticCommentSenderAllowed(state, sender, message.runId)) return { stopped: true, notSent: true };
  if (message.type === "requestAutomaticCommentSlot") {
    if (rate.lease && rate.lease.expiresAt > now && rate.lease.runId === (message.runId || "")) {
      return { retryAfterMs: Math.min(1000, rate.lease.expiresAt - now) };
    }
    if (rate.nextAllowedAt > now) return { retryAfterMs: rate.nextAllowedAt - now };
    const lease = { token: crypto.randomUUID(), tabId: sender.tab.id, runId: message.runId || "", expiresAt: now + AUTOMATIC_COMMENT_LEASE_MS };
    await chrome.storage.local.set({ automaticCommentRate: { ...rate, lease } });
    return { token: lease.token };
  }
  if (!rate.lease || rate.lease.token !== message.token || rate.lease.tabId !== sender.tab?.id || rate.lease.expiresAt <= now) {
    return { error: "评论发送许可已过期，请重试", notSent: true };
  }
  // Persist before clicking so a worker restart cannot immediately issue another send.
  await chrome.storage.local.set({ automaticCommentRate: { nextAllowedAt: now + AUTOMATIC_COMMENT_LEASE_MS + AUTOMATIC_COMMENT_INTERVAL_MS, lease: null, sending: { token: message.token, tabId: sender.tab.id, runId: message.runId || "", expiresAt: now + AUTOMATIC_COMMENT_LEASE_MS } } });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: sender.tab.id }, args: [message.token, message.runId || "", message.expectedText],
    func: async (token, runId, expectedText) => {
      const current = await chrome.storage.local.get(["automationRunning", "automationRunId", "automaticCommentRate"]);
      if (!current.automationRunning || (current.automationRunId || "") !== runId) return { stopped: true, notSent: true };
      const sending = current.automaticCommentRate?.sending;
      if (!sending || sending.token !== token || sending.runId !== runId || Date.now() > sending.expiresAt) return { error: "评论发送许可已失效，未发送", notSent: true };
      const scopes = [...document.querySelectorAll('[data-x-helper-comment-scope]')].filter((node) => node.getAttribute('data-x-helper-comment-scope') === token);
      const buttons = [...document.querySelectorAll('[data-x-helper-comment-send]')].filter((node) => node.getAttribute('data-x-helper-comment-send') === token);
      const editors = [...document.querySelectorAll('[data-x-helper-comment-editor]')].filter((node) => node.getAttribute('data-x-helper-comment-editor') === token);
      if (scopes.length !== 1 || buttons.length !== 1 || editors.length !== 1) return { error: "回复编辑器或按钮已变化，未发送", notSent: true };
      const button = buttons[0], editor = editors[0], scope = scopes[0];
      const normalize = (text) => String(text || "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").trim();
      const blocks = [...editor.querySelectorAll('[data-block="true"]')];
      const text = blocks.length ? blocks.map((block) => block.textContent || "").join("\n") : editor.innerText || editor.textContent || "";
      if (!scope.isConnected || !scope.contains(editor) || !scope.contains(button) || normalize(text) !== normalize(expectedText)) return { error: "回复内容或容器已变化，未发送", notSent: true };
      if (!button.isConnected || !editor.isConnected || !button.getClientRects().length || !editor.getClientRects().length ||
        button.disabled || button.getAttribute("aria-disabled") === "true" || !editor.isContentEditable || !(editor.textContent || "").trim()) {
        return { error: "回复按钮未启用或编辑器为空，未发送", notSent: true };
      }
      const label = String(button.innerText || button.textContent || "").replace(/\s+/g, " ").trim();
      if (!button.matches('[data-testid^="tweetButton"]') || !/^(?:回复|reply)(?:\s*\(.*\))?$/i.test(label)) return { error: "未确认回复按钮，未发送", notSent: true };
      button.click();
      return { clicked: true, clickedAt: Date.now() };
    }
  });
  if (result?.clicked) {
    const sentAt = Math.max(Date.now(), Number(result.clickedAt) || 0);
    await chrome.storage.local.set({ automaticCommentRate: { lastSentAt: sentAt, nextAllowedAt: sentAt + AUTOMATIC_COMMENT_INTERVAL_MS, lease: null } });
  }
  return result || { error: "未收到评论发送结果" };
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["requestAutomaticCommentSlot", "sendAutomaticComment", "cancelAutomaticCommentSlot"].includes(message?.type)) return;
  withAutomaticCommentLock(() => handleAutomaticComment(message, sender)).then(sendResponse).catch((error) => sendResponse({ error: error.message || "评论限速处理失败" }));
  return true;
});
