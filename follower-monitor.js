// Runs only in the follower-list tab registered by the background script.
async function runFollowerMonitor() {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const state = () => chrome.storage.local.get({ automationRunning: false, automationTask: "", autoFollowBack: false, followerMonitorTabId: null, followerMonitorCooldownUntil: 0, followBackIntervalSeconds: 10 });
  const enabled = async () => {
    const value = await state();
    return value.automationRunning && value.automationTask === "engagement" && value.autoFollowBack;
  };
  const status = (text) => chrome.storage.local.set({ followerMonitorStatus: text });
  const wait = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!await enabled()) return false;
      await pause(Math.min(1000, until - Date.now()));
    }
    return enabled();
  };
  let idleRounds = 0;
  try {
    while (await enabled()) {
      const config = await state();
      if (Date.now() < config.followerMonitorCooldownUntil) {
        await status(`回关限速，等待至 ${new Date(config.followerMonitorCooldownUntil).toLocaleTimeString()} 后重试（3 分钟）`);
        if (!await wait(config.followerMonitorCooldownUntil - Date.now())) return;
        location.reload();
        return;
      }
      const owner = getCurrentUsername();
      if (!owner || location.pathname.toLowerCase() !== `/${owner}/followers`.toLowerCase()) {
        await status("等待自己的关注者列表加载…");
        if (!await wait(3000)) return;
        continue;
      }
      const rows = [...document.querySelectorAll('[data-testid="UserCell"]')];
      let acted = false;
      for (const row of rows) {
        if (!await enabled()) return;
        const username = getRelationshipUsername(row);
        if (!username || username === owner || !row.isConnected) continue;
        const follow = [...row.querySelectorAll('button,[role="button"]')].find((button) =>
          button.getClientRects().length && !button.disabled && button.getAttribute("aria-disabled") !== "true" &&
          /^(关注|回关|follow|follow back)$/i.test(visibleControlText(button)));
        if (!follow) continue;
        // Membership in the signed-in account's followers list is the evidence for follow-back.
        if (!await enabled() || !row.isConnected) return;
        follow.click();
        acted = true;
        let confirmed = false;
        let limited = false;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (!await wait(250)) return;
          const alerts = [...document.querySelectorAll('[role="alert"],[role="status"],[role="dialog"]')].map((node) => node.innerText || "").join(" ");
          limited = /rate limit|follow limit|unable to follow|cannot follow|try again later|限速|稍后再试|操作频繁|关注.{0,12}(?:上限|限制|频繁)/i.test(alerts);
          confirmed = row.isConnected && [...row.querySelectorAll('button,[role="button"]')].some((button) => /^(正在关注|已关注|following|取消关注|unfollow)$/i.test(visibleControlText(button)));
          if (limited || confirmed) break;
        }
        if (!confirmed || limited) {
          const until = Date.now() + 180000;
          await chrome.storage.local.set({ followerMonitorCooldownUntil: until });
          await status(`${limited ? "检测到回关限速" : "未确认回关结果"}，3 分钟后重新检查并重试`);
          if (!await wait(180000)) return;
          location.reload();
          return;
        }
        await status(`已回关 @${username}，继续检查关注者`);
        if (!await wait(Math.max(1, Number(config.followBackIntervalSeconds) || 10) * 1000)) return;
      }
      idleRounds = acted ? 0 : idleRounds + 1;
      if (idleRounds >= 5) {
        await status("本轮关注者已检查，30 秒后刷新检查新关注者");
        if (!await wait(30000)) return;
        location.reload();
        return;
      }
      scrollRelationshipList();
      if (!await wait(3000)) return;
    }
  } catch (error) {
    await status(`回关检查失败：${String(error.message || error).slice(0, 120)}；30 秒后重试`);
    if (await wait(30000)) location.reload();
  }
}
