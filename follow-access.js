const FOLLOW_ACCESS_TARGET = "jixu_ai";
const FOLLOW_ACCESS_DISPLAY_NAME = "@灰小王";
const FOLLOW_ACCESS_WHITELIST = new Set(["jixu_ai"]);
const FOLLOW_ACCESS_TTL_MS = 5 * 60 * 1000;
let followAccessQueue = Promise.resolve();
function serializeFollowAccess(operation) {
  const next = followAccessQueue.then(operation);
  followAccessQueue = next.catch(() => {});
  return next;
}
async function readFollowAccessOwner(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https:\/\/(x|twitter)\.com\//.test(tab.url || "")) throw new Error("请先选择已登录的 X 页面");
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const href = document.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.getAttribute("href") || "";
      return href.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1]?.toLowerCase() || "";
    }
  });
  if (!result) throw new Error("无法识别登录账号，请等待 X 加载后重试");
  return { owner: result, windowId: tab.windowId };
}
// Runs read-only inside the temporary profile tab; never clicks Follow.
async function inspectRequiredFollow(expectedTarget, expectedOwner) {
  const target = expectedTarget.toLowerCase();
  const startedAt = Date.now();
  while (Date.now() - startedAt < 12000) {
    const owner = document.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.getAttribute("href")?.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1]?.toLowerCase();
    if (owner && owner !== expectedOwner) return { error: "验证过程中登录账号发生变化，请重试" };
    const scope = document.querySelector('[data-testid="primaryColumn"]');
    const heading = [...(scope?.querySelectorAll('[data-testid="UserName"]') || [])]
      .find((node) => !node.closest('article,[data-testid="UserCell"]'));
    const handles = (heading?.innerText || "").match(/@[A-Za-z0-9_]{1,15}\b/g) || [];
    if (owner === expectedOwner && location.pathname.replace(/\/$/, "").toLowerCase() === `/${target}` &&
        handles.some((handle) => handle.toLowerCase() === `@${target}`)) {
      const buttons = [...scope.querySelectorAll('button,[role="button"]')].filter((button) =>
        button.getClientRects().length && getComputedStyle(button).visibility !== "hidden" &&
        !button.closest('article,[data-testid="UserCell"],[role="dialog"]'));
      // X's profile follow control carries an account-id suffix. Ignore text-only recommendations.
      const following = buttons.filter((button) => /^\d+-unfollow$/.test(button.getAttribute("data-testid") || ""));
      const notFollowing = buttons.filter((button) => /^\d+-follow$/.test(button.getAttribute("data-testid") || ""));
      if (following.length === 1 && notFollowing.length === 0) return { following: true, owner };
      if (notFollowing.length === 1 && following.length === 0) return { following: false, owner };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { error: "无法确认博主主页的关注状态，请打开主页检查后重试" };
}
async function lockFollowAccess(message) {
  await chrome.storage.session.remove("followAccessProof");
  const state = await chrome.storage.local.get({ automationTask: "engagement", automationRunning: false, homeReplyMutualPosts: false, homeFollowMutualPosts: false });
  const status = { active: false, target: FOLLOW_ACCESS_TARGET, message };
  const update = { followAccessStatus: status, homeReplyMutualPosts: false };
  if (state.automationRunning && state.automationTask === "engagement" && state.homeReplyMutualPosts) {
    update.lastAutomationStatus = message;
    if (!state.homeFollowMutualPosts) update.automationRunning = false;
  }
  await chrome.storage.local.set(update);
  return status;
}
function followProofMatches(proof, owner, tabId, now = Date.now()) {
  return Boolean(proof && proof.owner === owner && proof.tabId === tabId && proof.target === FOLLOW_ACCESS_TARGET &&
    Number.isFinite(proof.checkedAt) && proof.checkedAt <= now && proof.expiresAt > now &&
    proof.expiresAt - proof.checkedAt === FOLLOW_ACCESS_TTL_MS);
}
async function checkFollowAccess(tabId, force = false, statusOnly = false) {
  return serializeFollowAccess(async () => {
    let profileTab;
    try {
      const { owner, windowId } = await readFollowAccessOwner(tabId);
      if (FOLLOW_ACCESS_WHITELIST.has(owner)) {
        return { active: true, owner, target: FOLLOW_ACCESS_TARGET, whitelisted: true,
          message: "白名单账号 · 可直接使用功能二", expiresAt: Date.now() + FOLLOW_ACCESS_TTL_MS };
      }
      const { followAccessProof: proof } = await chrome.storage.session.get("followAccessProof");
      if (!force && followProofMatches(proof, owner, tabId)) {
        return { active: true, owner, target: FOLLOW_ACCESS_TARGET, message: `@${owner} 已通过关注验证`, expiresAt: proof.expiresAt };
      }
      if (statusOnly && !proof) return { active: false, target: FOLLOW_ACCESS_TARGET, message: `关注 ${FOLLOW_ACCESS_DISPLAY_NAME} 后点击验证，解锁功能二` };
      profileTab = await chrome.tabs.create({ url: `https://x.com/${FOLLOW_ACCESS_TARGET}`, windowId, active: false });
      await waitForTabLoad(profileTab.id);
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: profileTab.id }, args: [FOLLOW_ACCESS_TARGET, owner], func: inspectRequiredFollow });
      if (result?.error) throw new Error(result.error);
      if (!result?.following || result.owner !== owner) return lockFollowAccess(`尚未确认 @${owner} 已关注 ${FOLLOW_ACCESS_DISPLAY_NAME}`);
      const current = await readFollowAccessOwner(tabId);
      if (current.owner !== owner) throw new Error("登录账号已变化，请重新验证");
      const checkedAt = Date.now();
      const status = { active: true, owner, target: FOLLOW_ACCESS_TARGET, message: `@${owner} 已通过关注验证`, expiresAt: checkedAt + FOLLOW_ACCESS_TTL_MS };
      await chrome.storage.session.set({ followAccessProof: { ...status, tabId, checkedAt } });
      await chrome.storage.local.set({ followAccessStatus: status });
      return status;
    } catch (error) {
      return lockFollowAccess(error.message || "关注验证失败，自动评论已关闭");
    } finally {
      if (profileTab?.id) await chrome.tabs.remove(profileTab.id).catch(() => {});
    }
  });
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!["followAccessStatus", "verifyFollowAccess"].includes(message?.type)) return;
  if (sender.url?.split("?")[0] !== chrome.runtime.getURL("dashboard.html")) return;
  if (!Number.isInteger(message.tabId)) { reply({ error: "未连接 X 标签页" }); return; }
  checkFollowAccess(message.tabId, message.type === "verifyFollowAccess", message.type === "followAccessStatus")
    .then((status) => reply({ status })).catch(() => reply({ error: "关注验证失败" }));
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "automaticReplyAccessCheck" || !sender.tab?.id) return;
  chrome.storage.local.get({ automationTargetTabId: null, automationRunning: false, automationRunId: "" }).then(async (state) => {
    if (!state.automationRunning || state.automationTargetTabId !== sender.tab.id || state.automationRunId !== message.runId) return { active: false };
    return checkFollowAccess(sender.tab.id);
  }).then((status) => reply({ status })).catch(() => reply({ status: { active: false } }));
  return true;
});
