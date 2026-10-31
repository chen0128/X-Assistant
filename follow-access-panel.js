const accessLabel = document.getElementById("followAccessStatus");
const accessVerifyButton = document.getElementById("verifyFollowAccess");
function renderFollowAccess(status) {
  const option = document.getElementById("homeReplyMutualPosts");
  const active = status?.active === true;
  if (!active) option.checked = false;
  accessLabel.textContent = active ? "验证通过 · 已解锁，请勾选功能二并开始任务" : status?.message || "尚未验证 · 关注后点击下方按钮";
  accessLabel.dataset.verified = String(active);
  updateTaskStatus();
}
accessVerifyButton.addEventListener("click", async () => {
  accessVerifyButton.disabled = true;
  accessLabel.textContent = "正在验证，请稍候…验证完成后会自动关闭临时主页。";
  try {
    const result = await chrome.runtime.sendMessage({ type: "verifyFollowAccess", tabId: boundTabId });
    if (result?.error) throw new Error(result.error);
    renderFollowAccess(result?.status);
  } catch (error) { renderFollowAccess({ active: false, message: error.message || "验证失败" }); }
  finally { accessVerifyButton.disabled = false; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.followAccessStatus) {
    if (!changes.followAccessStatus.newValue?.active) { renderFollowAccess(changes.followAccessStatus.newValue); return; }
    // A stored UI status alone never unlocks the option; ask the background again.
    chrome.runtime.sendMessage({ type: "followAccessStatus", tabId: boundTabId })
      .then((result) => renderFollowAccess(result?.status)).catch(() => renderFollowAccess(null));
  }
});
