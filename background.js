let followerMonitorStarting = null;
async function ensureFollowerMonitor(username, senderTabId) {
  if (followerMonitorStarting) return followerMonitorStarting;
  followerMonitorStarting = (async () => {
    const state = await chrome.storage.local.get(["automationRunning", "automationTask", "autoFollowBack", "automationTargetTabId", "followerMonitorTabId"]);
    if (!state.automationRunning || state.automationTask !== "engagement" || !state.autoFollowBack || senderTabId !== state.automationTargetTabId) return;
    if (!/^[A-Za-z0-9_]{1,15}$/.test(username || "")) throw new Error("无法识别当前账号，请等待 X 加载后重新启动");
    if (state.followerMonitorTabId) {
      const existing = await chrome.tabs.get(state.followerMonitorTabId).catch(() => null);
      if (existing) return;
    }
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    await chrome.storage.local.set({ followerMonitorTabId: tab.id, followerMonitorStatus: "正在打开关注者列表…" });
    const current = await chrome.storage.local.get(["automationRunning", "autoFollowBack"]);
    if (!current.automationRunning || !current.autoFollowBack) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      return;
    }
    await chrome.tabs.update(tab.id, { url: `https://x.com/${username}/followers` });
  })().finally(() => { followerMonitorStarting = null; });
  return followerMonitorStarting;
}
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !(changes.automationRunning || changes.autoFollowBack || changes.automationTask)) return;
  const state = await chrome.storage.local.get(["automationRunning", "automationTask", "autoFollowBack", "followerMonitorTabId"]);
  if (state.automationRunning && state.automationTask === "engagement" && state.autoFollowBack) return;
  if (state.followerMonitorTabId) await chrome.tabs.remove(state.followerMonitorTabId).catch(() => {});
  await chrome.storage.local.set({ followerMonitorTabId: null, followerMonitorStatus: "自动回关已停止" });
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await chrome.storage.local.get(["followerMonitorTabId"]);
  if (state.followerMonitorTabId === tabId) await chrome.storage.local.set({ followerMonitorTabId: null, followerMonitorStatus: "回关标签页已关闭" });
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ensureFollowerMonitor") {
    ensureFollowerMonitor(message.username, _sender.tab?.id).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "getTaskStateForTab") {
    chrome.storage.local.get({ automationRunning: false, automationTask: "engagement", automationTargetTabId: null, followerMonitorTabId: null, autoFollowBack: false })
      .then((state) => sendResponse({
        running: state.automationRunning === true && state.automationTargetTabId === _sender.tab?.id,
        followerMonitor: state.automationRunning && state.autoFollowBack && state.automationTask === "engagement" && state.followerMonitorTabId === _sender.tab?.id,
        taskMode: state.automationTask
      }))
      .catch(() => sendResponse({ running: false, taskMode: "engagement" }));
    return true;
  }
  if (message?.type === "followUser") {
    followUser(message.username)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error.message || "无法关注作者" }));
    return true;
  }
  if (message?.type !== "generateDraft") return;

  generateDraft(message.postText, message.replyContext)
    .then((draft) => sendResponse({ draft }))
    .catch((error) => sendResponse({ error: error.message || "请求失败" }));

  return true;
});

async function followUser(username) {
  const safeUsername = String(username || "").replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(safeUsername)) throw new Error("作者账号名无效");
  const tab = await chrome.tabs.create({ url: `https://x.com/${safeUsername}`, active: false });
  if (!tab?.id) throw new Error("无法打开作者主页");
  try {
    await waitForTabLoad(tab.id);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const { automationRunning = false } = await chrome.storage.local.get({ automationRunning: false });
    if (!automationRunning) throw new Error("任务已停止");
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [safeUsername],
      func: async (expectedUsername) => {
        const expected = expectedUsername.toLowerCase();
        const waitForProfile = async () => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < 10000) {
            const heading = document.querySelector('[data-testid="UserName"]');
            if (heading?.innerText) return heading;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          return null;
        };
        const profileHeading = await waitForProfile();
        const headingText = profileHeading?.innerText?.toLowerCase() || "";
        if (location.pathname.toLowerCase() !== `/${expected}` || !headingText.includes(`@${expected}`)) {
          return { error: "主页身份校验失败，未执行关注" };
        }
        const startedAt = Date.now();
        let clickedFollow = false;
        while (Date.now() - startedAt < 8000) {
          const alerts = [...document.querySelectorAll('[role="alert"],[role="status"],[data-testid*="toast"],[role="dialog"]')]
            .map((node) => node.innerText || "").join(" ").toLowerCase();
          if (/unable to follow more|cannot follow more|follow limit|rate limit.{0,20}follow|follow more accounts|cannot follow|无法关注|不能关注|关注.{0,12}(?:过多|频繁|限制|上限)|(?:过于频繁|操作频繁)/.test(alerts)) {
            return { rateLimited: true };
          }
          const buttons = [...document.querySelectorAll('button,[role="button"]')];
          const labels = buttons.map((button) => ({
            button,
            label: `${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`.trim().toLowerCase()
          }));
          const followed = labels.some(({ label }) => /(^|\s)(已关注|正在关注|following|unfollow)(\s|$)/i.test(label));
          if (followed) return { followed: clickedFollow, alreadyFollowing: !clickedFollow };
          const follow = labels.find(({ label }) => /(^|\s)(关注|follow)(\s|$)/i.test(label));
          if (follow && !clickedFollow) {
            follow.button.click();
            clickedFollow = true;
          }
          if (clickedFollow && follow && Date.now() - startedAt >= 2500) return { rateLimited: true };
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (clickedFollow) return { error: "点击关注后未能确认关注状态，请检查作者主页" };
        return { error: "主页未找到可确认的关注按钮" };
      }
    });
    if (result?.error) throw new Error(result.error);
    return result || { followed: false };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("作者主页加载超时"));
    }, 15000);
    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((currentTab) => {
      if (currentTab.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }).catch((error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(error);
    });
  });
}

async function generateDraft(postText, replyContext = "post") {
  const { replyMode = "ai", fixedReplyText = "" } = await chrome.storage.local.get({
    replyMode: "ai", fixedReplyText: ""
  });
  if (replyMode === "fixed") {
    const text = String(fixedReplyText).trim();
    if (!text) throw new Error("请先在设置中填写固定回复内容并保存。");
    return text;
  }
  const { apiKey, model, endpoint } = await chrome.storage.local.get({
    apiKey: "",
    model: "gpt-6-sol",
    endpoint: "https://heidawang.top/v1/chat/completions"
  });
  if (!apiKey) throw new Error("请先在扩展选项中配置 API Key。");

  const data = await requestModelJson(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      max_tokens: 120,
      messages: [
        { role: "system", content: replyContext === "comment"
          ? "根据用户提供的自己发布的帖子和他人的评论，先识别评论的主要语言，再用同一种语言写一条简短、友善、切题的回复。优先回应评论具体内容，不要重复原帖，不要翻译评论，不要声称自己是人类，不要编造经历，不要请求关注，不要输出多个选项。只返回回复文本。"
          : "根据用户提供的社交媒体帖子，先识别原帖的主要语言，再用同一种语言写一条简短、友善、相关的回复。不要翻译原帖，不要声称自己是人类，不要编造经历，不要请求关注，不要输出多个选项。只返回回复文本。" },
        { role: "user", content: `帖子内容：\n${String(postText || "").slice(0, 4000)}` }
      ]
    })
  });

  const draft = data.choices?.[0]?.message?.content?.trim();
  if (!draft) throw new Error("模型没有返回草稿");
  return draft;
}

function chatCompletionsEndpoint(endpoint) {
  const configuredEndpoint = endpoint === "https://api.openai.com/v1/chat/completions"
    ? "https://heidawang.top/v1/chat/completions"
    : endpoint;
  const url = new URL(configuredEndpoint);
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) url.pathname = `${path}/chat/completions`;
  return url.toString();
}

async function requestModelJson(endpoint, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(chatCompletionsEndpoint(endpoint), { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`API 返回 ${response.status}，请检查模型、密钥和服务状态`);
    }
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error("模型请求超过 45 秒，已取消本次请求");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
