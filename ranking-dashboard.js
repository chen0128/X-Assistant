const rankingSource = document.getElementById("rankingSource");
const rankingImportStatus = document.getElementById("rankingImportStatus");
const rankingFilterIds = ["rankingMode", "rankingSort", "rankingPeriod", "rankingCategory", "rankingAudience"];
const rankingFiltersReady = chrome.storage.local.get({ rankingFilters: {} }).then(({ rankingFilters }) => {
  for (const id of rankingFilterIds) {
    const input = document.getElementById(id);
    if ([...input.options].some((option) => option.value === rankingFilters[id])) input.value = rankingFilters[id];
  }
});
for (const id of rankingFilterIds) document.getElementById(id).addEventListener("change", () => {
  chrome.storage.local.set({ rankingFilters: Object.fromEntries(rankingFilterIds.map((key) => [key, document.getElementById(key).value])) });
  rankingImportStatus.textContent = "筛选条件已更改，请重新导入后启动";
});
function readRankingLimit() {
  const value = Number(document.getElementById("rankingLimit").value);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("请填写大于 0 的整数作为博主数量");
  return value;
}
async function refreshRankingSources() {
  const tabs = await chrome.tabs.query({ url: "https://xbangdan.com/accounts/*" });
  const selected = Number(rankingSource.value);
  rankingSource.replaceChildren();
  for (const tab of tabs) {
    const option = document.createElement("option");
    option.value = String(tab.id);
    option.textContent = tab.title || tab.url;
    rankingSource.append(option);
  }
  if (tabs.some((tab) => tab.id === selected)) rankingSource.value = String(selected);
}
document.getElementById("openRanking").addEventListener("click", async () => {
  await chrome.tabs.create({ url: "https://xbangdan.com/accounts/?rising=1" });
  await refreshRankingSources();
});
document.getElementById("refreshRankingSources").addEventListener("click", refreshRankingSources);
document.getElementById("importRanking").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const tabId = Number(rankingSource.value);
    if (!tabId) throw new Error("请先打开榜单、选择分类，再刷新榜单标签页列表");
    await rankingFiltersReady;
    const filters = Object.fromEntries(rankingFilterIds.map((id) => [id, document.getElementById(id).value]));
    const limit = readRankingLimit();
    rankingImportStatus.textContent = `正在导入，目标 ${limit} 位博主，将自动向后翻页…`;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId }, args: [limit, filters],
      func: async (maximum, requestedFilters) => {
        const table = document.querySelector("#ac-tb");
        if (!table) return { error: "没有找到账号榜，请等待榜单加载完成" };
        const label = (value) => String(value || "").replace(/[\s▼▽↓↑▲△]/g, "").replace(/[–—]/g, "-");
        const visibleButtons = () => [...document.querySelectorAll("button")].filter((node) => node.getClientRects().length);
        const selected = (node) => node.matches('.on,.active,.selected,[aria-pressed="true"],[aria-selected="true"]');
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const risingMode = () => visibleButtons().some((node) => label(node.textContent) === "5000粉以下");
        if (requestedFilters.rankingMode) {
          const rising = requestedFilters.rankingMode === "rising";
          if (risingMode() !== rising) {
            const toggle = document.querySelector("#dk-only");
            if (!toggle) return { error: "找不到黑马榜切换按钮，请在网站选择榜单类型" };
            toggle.click();
            for (let count = 0; count < 30 && risingMode() !== rising; count += 1) await wait(200);
            if (risingMode() !== rising) return { error: "榜单类型切换未完成，请检查网站" };
          }
        }
        const groups = [
          ["rankingSort", ["粉丝", "推文曝光", "发帖", "评论"]],
          ["rankingPeriod", ["今天", "昨日", "7天", "30天"]],
          ["rankingCategory", ["全部", "AI", "财经", "自媒体"]],
          ["rankingAudience", risingMode() ? ["5000粉以下", "5000到1万粉"] : ["全部", "1千以下", "1千-1万"]]
        ];
        for (const [key, names] of groups) {
          if (!requestedFilters[key]) continue;
          const buttons = visibleButtons();
          const seed = buttons.find((node) => label(node.textContent) === names[1]);
          let group = seed?.parentElement;
          while (group && group !== document.body) {
            const choices = [...group.querySelectorAll("button")].filter((node) => node.getClientRects().length);
            if (names.every((name) => choices.some((node) => label(node.textContent) === name))) break;
            group = group.parentElement;
          }
          if (!group || group === document.body) return { error: `无法识别筛选分组：${requestedFilters[key]}，请检查网站选项` };
          const matches = [...group.querySelectorAll("button")].filter((node) => node.getClientRects().length && label(node.textContent) === label(requestedFilters[key]));
          if (matches.length !== 1) return { error: `当前榜单不支持或无法唯一识别选项：${requestedFilters[key]}，请检查榜单类型和粉丝范围` };
          const button = matches[0];
          if (!selected(button)) button.click();
          await wait(350);
          const confirmed = [...group.querySelectorAll("button")].some((node) => label(node.textContent) === label(requestedFilters[key]) && selected(node));
          if (!confirmed) return { error: `未确认筛选已生效：${requestedFilters[key]}，请检查网站后重试` };
        }
        const firstPage = document.querySelector('#ac-pager button[data-go="1"]');
        if (firstPage && !selected(firstPage)) {
          firstPage.click();
          let ready = false;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            await wait(200);
            const current = document.querySelector('#ac-pager button[data-go="1"]');
            if (current && selected(current)) { ready = true; break; }
          }
          if (!ready) return { error: "无法返回榜单第一页，请手动切到第一页后重试" };
        }
        await wait(500);
        const queue = new Map();
        const seenPages = new Set();
        let stopReason = "已达到指定数量";
        const snapshot = () => [...document.querySelectorAll('#ac-tb tbody tr[data-h]')]
          .filter((row) => row.getClientRects().length > 0);
        const signature = () => snapshot().map((row) => row.getAttribute("data-h")).join(",");
        const filterText = [...document.querySelectorAll('button.on,button.active,[aria-pressed="true"]')]
          .filter((node) => !node.closest("#ac-pager") && node.getClientRects().length).map((node) => node.textContent.trim()).join(" / ");
        const number = (row, name) => {
          const raw = row.getAttribute(name);
          return raw !== null && Number.isFinite(Number(raw)) ? Number(raw) : null;
        };
        while (queue.size < maximum) {
          const pageSignature = signature();
          if (!pageSignature || seenPages.has(pageSignature)) {
            stopReason = "页面为空或重复，已停止翻页";
            break;
          }
          seenPages.add(pageSignature);
          for (const row of snapshot()) {
            const username = row.getAttribute("data-h");
            if (!/^[A-Za-z0-9_]{1,15}$/.test(username || "")) continue;
            queue.set(username.toLowerCase(), { username: username.toLowerCase(), category: row.getAttribute("data-cat"),
              posts7: number(row, "data-posts-7"), posts30: number(row, "data-posts-30"),
              replies7: number(row, "data-reply-7"), replies30: number(row, "data-reply-30") });
            if (queue.size >= maximum) break;
          }
          if (queue.size >= maximum) break;
          const next = document.querySelector('#ac-pager button[data-go="next"]');
          if (!next || next.disabled) { stopReason = "已到榜单末页"; break; }
          const before = signature();
          next.click();
          let changed = false;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            if (signature() && signature() !== before) { changed = true; break; }
          }
          if (!changed) { stopReason = "下一页加载超时，已保留本次读取的账号"; break; }
        }
        return { queue: [...queue.values()], requestedFilters, stopReason, source: location.href, filters: filterText, importedAt: Date.now() };
      }
    });
    if (result?.error || !result?.queue?.length) throw new Error(result?.error || "当前分类没有可导入账号");
    await chrome.storage.local.set({ rankingImport: result });
    rankingImportStatus.textContent = `已导入 ${result.queue.length} 位博主（目标 ${limit} 位，从第一页向后读取；${result.stopReason}）；${result.filters || "使用榜单当前筛选条件"}`;
  } catch (error) { rankingImportStatus.textContent = error.message; }
  finally { button.disabled = false; }
});
async function prepareRankingJob(controller) {
  const { rankingImport, rankingHistory = {} } = await chrome.storage.local.get(["rankingImport", "rankingHistory"]);
  if (!rankingImport?.queue?.length) throw new Error("请先选择榜单分类并导入博主");
  if (Date.now() - rankingImport.importedAt > 86400000) throw new Error("榜单数据超过 24 小时，请重新导入");
  await rankingFiltersReady;
  const currentFilters = Object.fromEntries(rankingFilterIds.map((id) => [id, document.getElementById(id).value]));
  if (rankingFilterIds.some((id) => currentFilters[id] !== (rankingImport.requestedFilters?.[id] || ""))) {
    throw new Error("筛选条件已更改，请重新导入博主后启动");
  }
  const owner = controller.username;
  if (!owner) throw new Error("无法识别当前登录的 X 账号");
  const interval = Math.min(3600, Math.max(5, Number(document.getElementById("rankingInterval").value) || 30));
  const limit = readRankingLimit();
  const concurrency = Number(document.getElementById("rankingConcurrency").value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error("同时处理博主数请填写 1–10 的整数");
  const accountRecords = await chrome.storage.local.get(rankingImport.queue.map((entry) => `rankingAccount:${owner}:${entry.username}`));
  const uniqueAccounts = [...new Map(rankingImport.queue.map((entry) => [entry.username.toLowerCase(), { ...entry, username: entry.username.toLowerCase() }])).values()];
  const queue = uniqueAccounts.filter((entry) => entry.username !== owner && (accountRecords[`rankingAccount:${owner}:${entry.username}`] || rankingHistory[`${owner}:${entry.username}`])?.state !== "done").slice(0, limit);
  if (!queue.length) throw new Error("导入的博主均已完成互动，请导入其他账号");
  await chrome.storage.local.set({ rankingJob: { id: crypto.randomUUID(), owner, queue, index: 0, stage: "posts", selectionVersion: 2, concurrency, interval, posts: [], commentPostId: null, retryAt: 0 }, rankingStatus: `准备检查 ${queue.length} 位博主` });
}
chrome.storage.local.get("rankingImport").then(({ rankingImport }) => {
  if (rankingImport?.queue?.length) rankingImportStatus.textContent = `已导入 ${rankingImport.queue.length} 位博主；${rankingImport.filters || "榜单当前分类"}`;
});
refreshRankingSources();

const rankingConcurrencyInput = document.getElementById("rankingConcurrency");
chrome.storage.local.get({ rankingConcurrency: 1 }).then(({ rankingConcurrency }) => {
  rankingConcurrencyInput.value = String(Math.max(1, Math.min(10, Math.floor(Number(rankingConcurrency) || 1))));
});
rankingConcurrencyInput.addEventListener("change", () => {
  const value = Number(rankingConcurrencyInput.value);
  if (Number.isInteger(value) && value >= 1 && value <= 10) chrome.storage.local.set({ rankingConcurrency: value });
});
