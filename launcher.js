const pageStatus = document.getElementById("pageStatus");
const openDashboardButton = document.getElementById("openDashboard");
let selectedTabId = null;

async function updateStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isX = Boolean(tab?.url && /^https:\/\/(www\.)?(x|twitter)\.com\//.test(tab.url));
  selectedTabId = isX ? tab.id : null;
  pageStatus.textContent = isX ? "检测到当前 X 页面，可直接连接。" : "打开控制台后可选择任意已打开的 X 页面。";
}

openDashboardButton.addEventListener("click", async () => {
  const suffix = selectedTabId ? `?tabId=${selectedTabId}` : "";
  await chrome.tabs.create({ url: `${chrome.runtime.getURL("dashboard.html")}${suffix}` });
  window.close();
});

updateStatus();
