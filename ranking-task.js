let rankingTaskBusy = false;
function rankingTargetUrl(job) {
  const entry = job.queue[job.index];
  if (job.stage === "comment") return `https://x.com/${entry.username}/status/${job.commentPostId}`;
  return `https://x.com/${entry.username}`;
}
async function runRankingTask(generation) {
  if (!rankingWorkerJobKey) {
    const result = await chrome.runtime.sendMessage({ type: "startRankingPool" });
    if (result?.error && isTaskActive(generation)) scheduleErrorRecovery(new Error(result.error), generation);
    return;
  }
  if (rankingTaskBusy) {
    setTimeout(() => {
      if (isTaskActive(generation) && settings.automationTask === "ranking") runRankingTask(generation);
    }, 500);
    return;
  }
  rankingTaskBusy = true;
  const active = () => isTaskActive(generation) && settings.automationTask === "ranking";
  const pause = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!active()) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, until - Date.now())));
    }
    return active();
  };
  let job;
  const status = async (text) => {
    if (active()) await chrome.runtime.sendMessage({ type: "rankingWorkerStatus", jobKey: rankingWorkerJobKey, status: text });
  };
  const save = () => chrome.storage.local.set({ [rankingWorkerJobKey]: job });
  const record = async (entry, value) => {
    await chrome.storage.local.set({ [`rankingAccount:${job.owner}:${entry.username}`]: { ...value, updatedAt: Date.now() } });
  };
  const advance = async (reason) => {
    await status(reason);
    job.index += 1;
    job.stage = "posts";
    job.posts = [];
    job.commentPostId = null;
    job.retryAt = Date.now() + job.interval * 1000;
    await save();
  };
  try {
    job = (await chrome.storage.local.get(rankingWorkerJobKey))[rankingWorkerJobKey];
    if (!job?.queue?.length) throw new Error("榜单队列为空，请重新导入并启动");
    if (job.selectionVersion !== 2) {
      if (job.stage !== "follow") { job.stage = "posts"; job.commentPostId = null; }
      job.selectionVersion = 2;
      await save();
    }
    while (active()) {
      if (job.index >= job.queue.length) {
        await status("榜单任务已完成，所有导入账号均已检查");
        await chrome.runtime.sendMessage({ type: "rankingWorkerDone", jobKey: rankingWorkerJobKey, status: "本路账号已全部检查" });
        updateTaskState(false);
        return;
      }
      if (Date.now() < job.retryAt && !await pause(job.retryAt - Date.now())) return;
      const entry = job.queue[job.index];
      const key = `${job.owner}:${entry.username}`;
      const { rankingHistory = {} } = await chrome.storage.local.get({ rankingHistory: {} });
      const recordKey = `rankingAccount:${key}`;
      const prior = (await chrome.storage.local.get(recordKey))[recordKey] || rankingHistory[key];
      if (prior?.state === "done" || prior?.state === "pending") {
        await advance(`跳过 @${entry.username}：${prior.state === "done" ? "已完成" : "上次发送结果不确定，避免重复评论"}`);
        continue;
      }
      if (prior?.state === "commented") {
        job.stage = "follow";
        job.commentPostId = prior.postId;
      }
      const target = rankingTargetUrl(job);
      if (location.pathname.toLowerCase() !== new URL(target).pathname.toLowerCase()) {
        await save();
        if (active()) location.assign(target);
        return;
      }
      await status(`榜单 ${job.index + 1}/${job.queue.length}：正在检查 @${entry.username}`);
      const identity = await waitForElement(() => getCurrentUsername() || null, 15000);
      if (!active()) return;
      if (identity !== job.owner) throw new Error("当前登录账号与启动时不一致，请切回原账号");
      if (job.stage === "posts") {
        await status(`正在选择 @${entry.username} 最近一条未评论的帖子`);
        const samples = await collectRankingSamples(entry.username, active, pause);
        if (!active()) return;
        const { uncertainReplyPostIds = [], repliedPostIds = [] } = await chrome.storage.local.get({ uncertainReplyPostIds: [], repliedPostIds: [] });
        const attempted = new Set([...uncertainReplyPostIds, ...repliedPostIds.map((id) => String(id).match(/\/status\/(\d+)/)?.[1] || String(id))]);
        const attemptKeys = samples.map((post) => `replyAttempt:${job.owner}:${post.id}`);
        const attempts = await chrome.storage.local.get(attemptKeys);
        const latest = samples.find((post) => !attempted.has(post.id) && !attempts[`replyAttempt:${job.owner}:${post.id}`]);
        if (!latest) {
          await advance(`跳过 @${entry.username}：已加载帖子中没有可评论且未处理的帖子`);
          continue;
        }
        job.commentPostId = latest.id;
        job.stage = "comment";
        await save();
        location.assign(rankingTargetUrl(job));
        return;
      }
      if (job.stage === "comment") {
        const article = await waitForElement(() => getPostContainers().find((post) => getPostId(post)?.match(/\/status\/(\d+)/)?.[1] === job.commentPostId && getAuthor(post) === entry.username), 15000);
        if (!active()) return;
        if (!article) throw new Error("未加载到目标博主的帖子");
        const { uncertainReplyPostIds = [], repliedPostIds = [] } = await chrome.storage.local.get({ uncertainReplyPostIds: [], repliedPostIds: [] });
        if (uncertainReplyPostIds.includes(job.commentPostId) || repliedPostIds.some((id) => String(id).endsWith(`/status/${job.commentPostId}`))) {
          await advance(`跳过 @${entry.username}：目标帖子已有评论或发送尝试记录`);
          continue;
        }
        const result = await chrome.runtime.sendMessage({ type: "generateDraft", postText: findPostText(article) });
        if (!active()) return;
        if (result?.error || !result?.draft) throw new Error(result?.error || "未生成评论内容");
        const sent = await sendReplyToPost(article, result.draft, generation, {
          inline: true,
          strict: true,
          beforeSend: () => record(entry, { state: "pending", postId: job.commentPostId })
        });
        if (!active()) return;
        if (sent === false) { await advance(`跳过 @${entry.username}：未确认评论发送`); continue; }
        await record(entry, { state: "commented", postId: job.commentPostId });
        job.stage = "follow";
        await save();
        location.assign(rankingTargetUrl(job));
        return;
      }
      if (job.stage === "follow") {
        const cooldownKey = `rankingFollowCooldown:${job.id}`;
        const sharedCooldown = (await chrome.storage.local.get(cooldownKey))[cooldownKey] || 0;
        if (Date.now() < sharedCooldown) {
          await status("榜单关注共享冷却中，等待后只重试关注");
          if (!await pause(sharedCooldown - Date.now())) return;
          continue;
        }
        await status(`已确认评论成功，正在关注 @${entry.username}`);
        const result = await chrome.runtime.sendMessage({ type: "followUser", username: entry.username });
        if (!active()) return;
        if (result?.rateLimited) {
          job.retryAt = Date.now() + 180000;
          await chrome.storage.local.set({ [cooldownKey]: job.retryAt });
          await save();
          await status("关注限速，3 分钟后重试关注；不会再次评论");
          continue;
        }
        if (result?.error || !(result?.followed || result?.alreadyFollowing)) throw new Error(result?.error || "未确认关注成功");
        await record(entry, { state: "done", postId: job.commentPostId });
        await advance(`已评论并关注 @${entry.username}`);
      }
    }
  } catch (error) {
    if (!active()) return;
    const message = String(error?.message || error).slice(0, 180);
    await status(`${message}；本路等待 30 秒后重试`);
    if (job) { job.retryAt = Date.now() + 30000; await save(); }
    if (await pause(30000)) {
      if (job && job.index < job.queue.length) location.assign(rankingTargetUrl(job));
      else location.reload();
    }
  } finally { rankingTaskBusy = false; }
}

async function collectRankingSamples(username, active, pause) {
  const samples = new Map();
  await waitForElement(() => document.querySelector('article[data-testid="tweet"]'), 12000);
  for (let page = 0; page < 4 && active(); page += 1) {
    for (const article of getPostContainers()) {
      if (getAuthor(article) !== username) continue;
      const time = getOuterPostTime(article);
      const timestamp = Date.parse(time?.getAttribute("datetime") || "");
      const id = getPostId(article)?.match(/\/status\/(\d+)/)?.[1];
      if (!id || !Number.isFinite(timestamp) || timestamp > Date.now()) continue;
      const reply = article.querySelector('[data-testid="reply"]');
      if (!reply || reply.disabled || reply.getAttribute("aria-disabled") === "true") continue;
      const text = findPostText(article);
      if (!text) continue;
      const context = article.innerText || "";
      const textStart = context.indexOf(text);
      const header = textStart >= 0 ? context.slice(0, textStart) : "";
      samples.set(id, { id, author: username, date: new Date(timestamp).toISOString(), text: text.slice(0, 1800), header: header.slice(0, 1000), context: context.slice(0, 3000) });
    }
    if (samples.size >= 20) break;
    window.scrollBy({ top: Math.max(600, window.innerHeight), behavior: "instant" });
    if (!await pause(1500)) break;
  }
  return [...samples.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}
