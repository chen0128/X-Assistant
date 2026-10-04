const pageStatus = document.getElementById("pageStatus");
const taskStatus = document.getElementById("taskStatus");
const actionStatus = document.getElementById("actionStatus");
const startTaskButtons = [...document.querySelectorAll("[data-start-task]")];
const stopTaskButtons = [...document.querySelectorAll("[data-stop-task]")];
const homeFollowMutualOption = document.getElementById("homeFollowMutualPosts");
const homeReplyMutualOption = document.getElementById("homeReplyMutualPosts");
const ownPostCommentReplyOption = document.getElementById("ownPostCommentReply");
const idleRefreshMinutes = document.getElementById("idleRefreshMinutes");
const targetTabSelect = document.getElementById("targetTab");
const refreshTabsButton = document.getElementById("refreshTabs");
const RELATIONSHIP_SETTING_DEFAULTS = {
  unfollowAccountLimit: 50,
  unfollowIntervalSeconds: 10,
  followBackAccountLimit: 50,
  followBackIntervalSeconds: 10
};
const relationshipSettingInputs = Object.fromEntries(Object.keys(RELATIONSHIP_SETTING_DEFAULTS)
  .map((key) => [key, document.getElementById(key)]));
let activeTab;
let activeTabIsX = false;
let taskOptionsReady = false;

async function loadTaskOptions() {
  const values = await chrome.storage.local.get([
    "homeFollowMutualPosts", "homeReplyMutualPosts", "mutualTaskEnabled", "homeAutoFollowMutual", "ownPostCommentReply", "autoReply", "autoFollow",
    "idleRefreshMinutes",
    ...Object.keys(RELATIONSHIP_SETTING_DEFAULTS)
  ]);
  const legacyCombined = values.mutualTaskEnabled ?? (values.autoReply === true || values.autoFollow === true);
  const homeFollowMutualPosts = values.homeFollowMutualPosts ?? (values.homeAutoFollowMutual === true || legacyCombined);
  const homeReplyMutualPosts = values.homeReplyMutualPosts ?? legacyCombined;
  const ownPostCommentReply = values.ownPostCommentReply === true;
  homeFollowMutualOption.checked = homeFollowMutualPosts;
  homeReplyMutualOption.checked = homeReplyMutualPosts;
  ownPostCommentReplyOption.checked = ownPostCommentReply;
  await chrome.storage.local.set({ homeFollowMutualPosts, homeReplyMutualPosts, ownPostCommentReply });
  idleRefreshMinutes.value = String([1, 3, 5, 10].includes(Number(values.idleRefreshMinutes)) ? values.idleRefreshMinutes : 3);
  if (![1, 3, 5, 10].includes(Number(values.idleRefreshMinutes))) {
    await chrome.storage.local.set({ idleRefreshMinutes: 3 });
  }
  const relationshipSettings = {};
  for (const [key, fallback] of Object.entries(RELATIONSHIP_SETTING_DEFAULTS)) {
    const maximum = key.endsWith("IntervalSeconds") ? 3600 : 1000;
    const selected = Math.min(maximum, Math.max(1, Math.floor(Number(values[key]) || fallback)));
    relationshipSettings[key] = selected;
    relationshipSettingInputs[key].value = String(selected);
  }
  await chrome.storage.local.set(relationshipSettings);
  taskOptionsReady = true;
}

async function updateTaskStatus() {
  const { automationRunning = false, automationTask = "engagement", lastAutomationError = "", lastAutomationStatus = "" } = await chrome.storage.local.get({
    automationRunning: false,
    automationTask: "engagement",
    lastAutomationError: "",
    lastAutomationStatus: ""
  });
  const hasSelectedTask = homeFollowMutualOption.checked || homeReplyMutualOption.checked || ownPostCommentReplyOption.checked;
  const taskLabels = {
    engagement: "关注 / 评论",
    unfollowNonMutual: "取消单向关注",
    followBackFollowers: "回关关注者"
  };
  taskStatus.textContent = automationRunning ? `运行中的任务：${taskLabels[automationTask] || automationTask}` : "任务状态：已停止";
  const actionMessage = lastAutomationError
    ? `最近自动任务失败：${lastAutomationError}`
    : lastAutomationStatus;
  actionStatus.hidden = !actionMessage;
  actionStatus.textContent = actionMessage;
  for (const button of startTaskButtons) {
    const mode = button.dataset.startTask;
    button.disabled = !activeTabIsX || (mode === "engagement" && !hasSelectedTask) || !taskOptionsReady;
    button.textContent = automationRunning && automationTask === mode
      ? mode === "engagement" ? "重新开始关注 / 评论" : "重新开始"
      : button.dataset.defaultLabel;
  }
  for (const button of stopTaskButtons) {
    button.disabled = !automationRunning || automationTask !== button.dataset.stopTask;
  }
  for (const state of document.querySelectorAll("[data-state-for]")) {
    const running = automationRunning && automationTask === state.dataset.stateFor;
    state.textContent = running ? "运行中" : "未运行";
    state.classList.toggle("running", running);
  }
}

async function updatePageStatus() {
  const xTabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  const currentSelection = Number(targetTabSelect.value) || Number(new URLSearchParams(location.search).get("tabId"));
  const [focusedTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const chosenTab = xTabs.find((tab) => tab.id === currentSelection) ||
    xTabs.find((tab) => tab.id === focusedTab?.id) || xTabs[0];
  targetTabSelect.replaceChildren();
  for (const tab of xTabs) {
    const option = document.createElement("option");
    option.value = String(tab.id);
    option.textContent = `${tab.title || "X 页面"} · ${new URL(tab.url).pathname}`;
    targetTabSelect.append(option);
  }
  if (chosenTab) targetTabSelect.value = String(chosenTab.id);
  activeTab = chosenTab;
  activeTabIsX = Boolean(activeTab?.url && /^https:\/\/(www\.)?(x|twitter)\.com\//.test(activeTab.url));
  pageStatus.textContent = activeTabIsX
    ? `已连接：${activeTab.title || activeTab.url}`
    : "没有检测到打开的 X 标签页。请先打开 X。";
  await updateTaskStatus();
}

targetTabSelect.addEventListener("change", updatePageStatus);
refreshTabsButton.addEventListener("click", updatePageStatus);

async function startTask(mode) {
  if (!activeTab?.id || !activeTabIsX) return;
  if (mode === "engagement" && !homeFollowMutualOption.checked && !homeReplyMutualOption.checked && !ownPostCommentReplyOption.checked) return;
  startTaskButtons.forEach((button) => { button.disabled = true; });
  try {
    let controller = await checkTaskController(activeTab.id);
    if (controller?.controllerVersion !== 10) {
      taskStatus.textContent = "正在刷新所选 X 页面，以加载新版任务脚本…";
      await chrome.tabs.reload(activeTab.id);
      await waitForTabLoad(activeTab.id);
      controller = await checkTaskController(activeTab.id);
    }
    if (controller?.controllerVersion !== 10) {
      throw new Error("新版任务脚本仍未响应。请确认扩展已重新加载，再刷新 X 页面重试。");
    }
    if (mode !== "engagement" && !controller.identityAvailable) {
      throw new Error("无法识别当前登录账号。请确认 X 已登录并等待页面加载完成。");
    }
    if (mode === "engagement" && !controller.feedSupported) {
      throw new Error("首页互关任务请打开 X 首页；“我的帖子”任务请打开自己发布的帖子详情页。");
    }
    if (mode === "engagement" && ownPostCommentReplyOption.checked && !controller.ownPostReplySupported) {
      throw new Error("请先打开自己发布的帖子详情页，再启动“我的帖子：自动回复他人评论”。");
    }
    const selectedTasks = {
      homeFollowMutualPosts: homeFollowMutualOption.checked,
      homeReplyMutualPosts: homeReplyMutualOption.checked,
      ownPostCommentReply: ownPostCommentReplyOption.checked,
      ...Object.fromEntries(Object.entries(relationshipSettingInputs).map(([key, input]) => [key, Number(input.value)]))
    };
    await chrome.storage.local.set({ automationRunning: false });
    await chrome.tabs.sendMessage(activeTab.id, { type: "taskControl", running: false }).catch(() => {});
    await chrome.storage.local.set({
      ...selectedTasks,
      automationTask: mode,
      automationTargetTabId: activeTab.id,
      automationRunning: true,
      lastAutomationError: "",
      lastAutomationStatus: "任务启动中…"
    });
    const result = await chrome.tabs.sendMessage(activeTab.id, {
      type: "taskControl",
      running: true,
      taskMode: mode,
      settings: selectedTasks
    });
    if (!result?.supported) throw new Error(result?.error || "当前页面不支持此任务");
    await updateTaskStatus();
    taskStatus.textContent = result.status ||
      `任务已启动：当前页 ${result.postCount} 条帖子，其中 ${result.matchCount} 条符合所选任务`;
  } catch (error) {
    await chrome.storage.local.set({ automationRunning: false });
    await updateTaskStatus();
    taskStatus.textContent = `启动失败：${String(error?.message || "内容脚本未响应，请刷新 X 页面后重试。")}`;
    actionStatus.hidden = false;
    actionStatus.textContent = String(error?.message || "扩展与 X 页面连接失败").slice(0, 240);
  }
}

async function checkTaskController(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "taskHandshake" });
  } catch {
    return null;
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("X 页面刷新超时，请确认网络连接后重试。"));
    }, 20000);
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      setTimeout(resolve, 500);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        setTimeout(resolve, 500);
      }
    }).catch((error) => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(error);
    });
  });
}

for (const button of startTaskButtons) {
  button.dataset.defaultLabel = button.textContent;
  button.addEventListener("click", () => startTask(button.dataset.startTask));
}

for (const option of [homeFollowMutualOption, homeReplyMutualOption, ownPostCommentReplyOption]) {
  option.addEventListener("change", async () => {
    if (!taskOptionsReady) return;
    await chrome.storage.local.set({
      homeFollowMutualPosts: homeFollowMutualOption.checked,
      homeReplyMutualPosts: homeReplyMutualOption.checked,
      ownPostCommentReply: ownPostCommentReplyOption.checked
    });
    await updateTaskStatus();
  });
}

for (const button of stopTaskButtons) {
  button.addEventListener("click", async () => {
    const mode = button.dataset.stopTask;
    const { automationRunning = false, automationTask = "engagement" } = await chrome.storage.local.get({
      automationRunning: false,
      automationTask: "engagement"
    });
    if (!automationRunning || automationTask !== mode) return;
    await chrome.storage.local.set({ automationRunning: false, lastAutomationStatus: "任务已停止" });
    if (activeTab?.id) {
      chrome.tabs.sendMessage(activeTab.id, { type: "taskControl", running: false }).catch(() => {});
    }
    await updateTaskStatus();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.automationRunning || changes.lastAutomationError || changes.lastAutomationStatus) updateTaskStatus();
});

idleRefreshMinutes.addEventListener("change", () => {
  chrome.storage.local.set({ idleRefreshMinutes: Number(idleRefreshMinutes.value) });
});

for (const [key, input] of Object.entries(relationshipSettingInputs)) {
  input.addEventListener("change", async () => {
    const maximum = key.endsWith("IntervalSeconds") ? 3600 : 1000;
    const selected = Math.min(maximum, Math.max(1, Math.floor(Number(input.value) || RELATIONSHIP_SETTING_DEFAULTS[key])));
    input.value = String(selected);
    await chrome.storage.local.set({ [key]: selected });
  });
}

document.getElementById("openX").addEventListener("click", async () => {
  const tab = await chrome.tabs.create({ url: "https://x.com/home" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await updatePageStatus();
  if (tab?.id) {
    targetTabSelect.value = String(tab.id);
    activeTab = tab;
    activeTabIsX = true;
    pageStatus.textContent = `已连接：${tab.title || tab.url}`;
    await updateTaskStatus();
  }
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

updatePageStatus();
loadTaskOptions().then(updateTaskStatus);
