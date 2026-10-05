const TERMS = [
  "互关", "回关", "互fo", "互粉", "关注我", "求关注", "关注必回", "回粉", "蓝V", "蓝 v", "蓝色认证",
  "你关我回", "关我回", "你关我也关", "互关互粉", "互粉互关", "求互关", "互关团", "互fo团", "秒跟", "开团秒跟",
  "回复", "互动", "follow back", "follow for follow", "follow me i follow back", "f4f", "follow train", "mutuals"
];
const BADGE = "x-mutual-helper-badge";
const REPLIED_AUTHORS_KEY = "repliedAuthors";
const REPLIED_POSTS_KEY = "repliedPostIds";
let settings = {
  automationTask: "engagement",
  autoFollowBack: false,
  homeFollowMutualPosts: false,
  homeReplyMutualPosts: false,
  ownPostCommentReply: false,
  idleRefreshMinutes: 3,
  unfollowAccountLimit: 50,
  unfollowIntervalSeconds: 10,
  followBackAccountLimit: 50,
  followBackIntervalSeconds: 10,
  automationRunning: false
};
let recoveryTimer = null;
let recovering = false;
let taskFeedUrl = null;
let pending = Promise.resolve();
let engagementRoundRunning = false;
let scanningRound = false;
const writtenReplyEditors = new WeakSet();
let actionsThisPage = 0;
let taskGeneration = 0;
const actedPosts = new Set();
const ownPostReplyQueued = new Set();
const OWN_POST_REPLIED_COMMENTS_KEY = "repliedOwnPostComments";
const relationshipQueued = new Set();
const relationshipTried = new Set();
const MAX_ACTIONS_PER_PAGE = 20;
const AUTO_ADVANCE_INTERVAL_MS = 15000;
const ADVANCE_SETTLE_MS = 2500;
const FOLLOW_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;
let autoAdvanceTimer = null;
let relationshipTimer = null;
let relationshipActionsCompleted = 0;
let lastRelationshipActionAt = 0;
let followResumeTimer = null;
let stalledAdvances = 0;
let previousFeedSignature = "";
let lastActivityAt = Date.now();
let lastFeedStatusAt = 0;

function visibleControls() {
  return [...document.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"],[role="option"]')]
    .filter((element) => element.getClientRects().length > 0);
}

function controlLabel(element) {
  return `${element.getAttribute("aria-label") || ""} ${element.innerText || element.textContent || ""}`
    .replace(/\s+/g, " ").trim();
}

function visibleControlText(element) {
  return String(element.innerText || element.textContent || element.getAttribute("aria-label") || "")
    .replace(/\s+/g, " ").trim();
}

function relationshipRowFollowsYou(row) {
  const markerPattern = /^(?:follows you|关注了你)$/i;
  const markers = [...row.querySelectorAll("[aria-label],span")];
  if (markers.some((element) => markerPattern.test(visibleControlText(element)) ||
    markerPattern.test(element.getAttribute("aria-label") || ""))) return true;
  return /(?:^|\s)(?:follows you|关注了你)(?:\s|$)/i.test((row.innerText || "").replace(/\s+/g, " ").trim());
}

function findPostText(article) {
  const markedText = [...article.querySelectorAll('[data-testid="tweetText"]')]
    .map((node) => node.innerText.trim())
    .filter(Boolean)
    .join("\n");
  return markedText;
}

function matchedTerms(text) {
  const normalized = text.toLocaleLowerCase();
  return TERMS.filter((term) => normalized.includes(term.toLocaleLowerCase()));
}

function getPostContainers() {
  const posts = new Set(document.querySelectorAll('article, [data-testid="tweet"]'));
  for (const statusLink of document.querySelectorAll('a[href*="/status/"]')) {
    if (statusLink.closest('article, [data-testid="tweet"]')) continue;
    let candidate = statusLink.parentElement;
    while (candidate && candidate !== document.body) {
      const statusLinks = [...new Set([...candidate.querySelectorAll('a[href*="/status/"]')]
        .map((link) => link.getAttribute("href")))];
      const hasReplyControl = candidate.querySelector('[data-testid="reply"]') ||
        [...candidate.querySelectorAll('button,[role="button"]')].some((button) =>
          /回复|reply/i.test(`${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`));
      if (statusLinks.length === 1 && hasReplyControl && findPostText(candidate)) {
        posts.add(candidate);
        break;
      }
      candidate = candidate.parentElement;
    }
  }
  return [...posts].filter((post) => Boolean(findPostText(post)) && Boolean(getPostId(post)));
}

function getPostId(post) {
  const statusLink = [...post.querySelectorAll('a[href*="/status/"]')]
    .find((link) => /\/status\/\d+/.test(link.getAttribute("href") || ""));
  return statusLink?.getAttribute("href") || null;
}

async function makeDraft(postText, button) {
  button.disabled = true;
  button.textContent = "生成中…";
  try {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      throw new Error("扩展脚本已过期，请刷新 X 页面后重试。");
    }
    const result = await chrome.runtime.sendMessage({
      type: "generateDraft",
      postText
    });
    if (result?.error) throw new Error(result.error);
    if (!result?.draft) throw new Error("扩展后台没有返回草稿，请重新加载扩展后重试");
    showDraft(result.draft);
  } catch (error) {
    alert(`生成失败：${error.message || "扩展后台连接失败"}`);
  } finally {
    button.disabled = false;
    button.textContent = "生成回复草稿";
  }
}

function showDraft(draft) {
  const dialog = document.createElement("dialog");
  dialog.className = "x-mutual-helper-dialog";
  const title = document.createElement("h2");
  title.textContent = "回复草稿（请检查后手动发送）";
  const textarea = document.createElement("textarea");
  textarea.value = draft;
  textarea.rows = 4;
  const close = document.createElement("button");
  close.textContent = "关闭";
  close.addEventListener("click", () => dialog.close());
  dialog.append(title, textarea, close);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

function ownPostThreadContext() {
  const match = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i);
  const ownUsername = getCurrentUsername();
  if (!match || !ownUsername || match[1].toLowerCase() !== ownUsername) return null;
  return { username: ownUsername, postId: match[2] };
}

function isOwnPostThreadPage() {
  return Boolean(ownPostThreadContext());
}

function queueOwnPostCommentReply(article) {
  if (!settings.automationRunning || !article.isConnected || !isTaskActive(taskGeneration)) return;
  const context = ownPostThreadContext();
  const commentId = getPostId(article)?.match(/\/status\/(\d+)/)?.[1];
  const commentAuthor = getAuthor(article);
  const commentText = findPostText(article);
  if (!context || !commentId || commentId === context.postId || !commentAuthor ||
    commentAuthor === context.username || !commentText || actionsThisPage >= MAX_ACTIONS_PER_PAGE) return;

  const rootArticle = getPostContainers().find((post) =>
    getPostId(post)?.match(/\/status\/(\d+)/)?.[1] === context.postId);
  const rootText = rootArticle ? findPostText(rootArticle) : "";
  if (!rootText) return;

  const key = `${context.postId}:${commentId}`;
  if (ownPostReplyQueued.has(key)) return;
  ownPostReplyQueued.add(key);
  const generation = taskGeneration;
  pending = pending.then(async () => {
    try {
      if (!isTaskActive(generation) || !article.isConnected) return;
      const { [OWN_POST_REPLIED_COMMENTS_KEY]: replied = [] } = await chrome.storage.local.get({
        [OWN_POST_REPLIED_COMMENTS_KEY]: []
      });
      if (replied.includes(key)) return;

      const prompt = `你发布的帖子：\n${rootText}\n\n他人对该帖的评论：\n${commentText}`;
      const result = await chrome.runtime.sendMessage({
        type: "generateDraft",
        postText: prompt,
        replyContext: "comment"
      });
      if (!isTaskActive(generation)) return;
      if (result?.error || !result?.draft) throw new Error(result?.error || "模型没有返回评论回复");
      if (await sendReplyToPost(article, result.draft, generation) === false) return;
      const latest = await chrome.storage.local.get({ [OWN_POST_REPLIED_COMMENTS_KEY]: [] });
      const repliedComments = [...new Set([...latest[OWN_POST_REPLIED_COMMENTS_KEY], key])].slice(-5000);
      await chrome.storage.local.set({
        [OWN_POST_REPLIED_COMMENTS_KEY]: repliedComments,
        lastAutomationError: "",
        lastAutomationStatus: `已回复 @${commentAuthor} 对你帖子的评论`
      });
      actionsThisPage += 1;
      lastActivityAt = Date.now();
    } catch (error) {
      console.error("X Mutual Helper own-post reply failed", error);
      scheduleErrorRecovery(error, generation);
    } finally {
      ownPostReplyQueued.delete(key);
    }
  });
}

function processPost(article) {
  if (!article.isConnected || settings.automationTask !== "engagement") return;
  if (settings.ownPostCommentReply && isOwnPostThreadPage()) {
    queueOwnPostCommentReply(article);
    return;
  }
  const text = findPostText(article);
  if (!text) return;
  const hits = matchedTerms(text);
  const postId = getPostId(article);
  const isHomepage = location.pathname === "/home";
  if (!hits.length) return;

  if (!article.querySelector(`.${BADGE}`)) {
    const container = document.createElement("div");
    container.className = BADGE;
    const label = document.createElement("span");
    const labels = [];
    if (hits.length) labels.push(`疑似互关贴：${hits.slice(0, 3).join("、")}`);
    label.textContent = labels.join("；");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "生成回复草稿";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      makeDraft(text, button);
    });
    container.append(label, button);
    const target = article.querySelector('[data-testid="tweetText"]')?.parentElement;
    (target || article).append(container);
  }

  const mutualIntent = hits.length > 0;
  const shouldFollow = mutualIntent && isHomepage && settings.homeFollowMutualPosts;
  const shouldReply = mutualIntent && isHomepage && settings.homeReplyMutualPosts;
  if (isTaskFeedPage() && settings.automationRunning && (shouldFollow || shouldReply) && postId && !actedPosts.has(postId)) {
    actedPosts.add(postId);
    const generation = taskGeneration;
    pending = pending.then(async () => {
      if (!isTaskActive(generation) || !article.isConnected || actionsThisPage >= MAX_ACTIONS_PER_PAGE) {
        actedPosts.delete(postId);
        return;
      }
      await runAutomaticActions(article, text, generation, shouldFollow, shouldReply, postId, true);
    }).catch((error) => {
      console.error("X Mutual Helper automatic action failed", error);
      scheduleErrorRecovery(error, generation);
    });
  }
}

async function runAutomaticActions(article, postText, generation, shouldFollow, shouldReply, postId, dedupeByPost) {
  if (!isTaskActive(generation)) return;
  const author = getAuthor(article);
  if (!author) throw new Error("无法识别互关帖作者账号");
  if (author === getCurrentUsername()) return;

  const {
    [REPLIED_AUTHORS_KEY]: repliedAuthors = [],
    [REPLIED_POSTS_KEY]: repliedPostIds = [],
    followedAuthors = [],
    followCooldownUntil = 0
  } = await chrome.storage.local.get({
    [REPLIED_AUTHORS_KEY]: [],
    [REPLIED_POSTS_KEY]: [],
    followedAuthors: [],
    followCooldownUntil: 0
  });
  const alreadyReplied = shouldReply && (dedupeByPost
    ? repliedPostIds.includes(postId)
    : repliedAuthors.includes(author));

  if (shouldFollow && !followedAuthors.includes(author)) {
    if (Date.now() < followCooldownUntil) {
      scheduleFollowCooldownResume(followCooldownUntil, generation);
      return;
    }
    const follow = await chrome.runtime.sendMessage({ type: "followUser", username: author });
    if (!isTaskActive(generation)) return;
    if (follow?.rateLimited) {
      stopAutoAdvance();
      const until = Date.now() + FOLLOW_RATE_LIMIT_COOLDOWN_MS;
      await chrome.storage.local.set({
        followCooldownUntil: until,
        lastAutomationError: `X 关注限速，暂停至 ${new Date(until).toLocaleTimeString()} 后刷新主页继续。`
      });
      scheduleFollowCooldownResume(until, generation);
      return;
    }
    if (follow?.error) throw new Error(`关注未完成，已跳过评论：${follow.error}`);
    await chrome.storage.local.set({
      followedAuthors: [...new Set([...followedAuthors, author])],
      lastAutomationStatus: `已关注 @${author}`
    });
  }

  if (!shouldReply || alreadyReplied) {
    actionsThisPage += 1;
    lastActivityAt = Date.now();
    if (alreadyReplied) {
      await chrome.storage.local.set({ lastAutomationStatus: `@${author} 已评论过，跳过重复评论；关注步骤已单独执行。` });
    }
    return;
  }

  const result = await chrome.runtime.sendMessage({ type: "generateDraft", postText });
  if (!isTaskActive(generation)) return;
  if (result?.error || !result?.draft) throw new Error(result?.error || "模型没有返回回复");
  if (await sendReplyToPost(article, result.draft, generation) === false) return;
  const postReplyHistory = dedupeByPost
    ? { [REPLIED_POSTS_KEY]: [...new Set([...repliedPostIds, postId])].slice(-5000) }
    : {};
  await chrome.storage.local.set({
    [REPLIED_AUTHORS_KEY]: [...new Set([...repliedAuthors, author])],
    ...postReplyHistory
  });
  lastActivityAt = Date.now();
  actionsThisPage += 1;
  await chrome.storage.local.set({ lastAutomationStatus: `已评论 @${author}` });
}

async function sendReplyToPost(article, draft, generation) {
  if (!isTaskActive(generation)) throw new Error("任务已停止");
  const targetId = getPostId(article)?.match(/\/status\/(\d+)/)?.[1];
  const targetArticle = article.isConnected ? article : getPostContainers().find((post) =>
    getPostId(post)?.match(/\/status\/(\d+)/)?.[1] === targetId);
  if (!targetArticle || !targetId) throw new Error("目标帖子已离开页面，已跳过");
  const { uncertainReplyPostIds = [] } = await chrome.storage.local.get({ uncertainReplyPostIds: [] });
  if (uncertainReplyPostIds.includes(targetId)) {
    await chrome.storage.local.set({ lastAutomationStatus: "此帖已有发送尝试记录，跳过重发以避免重复评论" });
    return false;
  }
  const targetAuthor = getAuthor(targetArticle);
  const targetText = findPostText(targetArticle);
  const replyButton = targetArticle.querySelector('[data-testid="reply"]');
  if (!replyButton) throw new Error("找不到此帖的回复按钮");
  const editorSelector = '[contenteditable="true"][role="textbox"], [contenteditable="true"][data-testid^="tweetTextarea_"]';
  const visibleEditorsBeforeClick = new Set([...document.querySelectorAll(editorSelector)]
    .filter((editor) => editor.getClientRects().length > 0));
  let composerStage = "未发现回复弹窗或行内输入框";
  await chrome.storage.local.set({ lastAutomationStatus: `已读取回复内容（${draft.length} 字符），正在定位回复框` });
  targetArticle.scrollIntoView({ block: "center", behavior: "instant" });
  replyButton.click();
  const confirmedAudienceButtons = new Set();
  const composer = await waitForElement(() => {
    if (!isTaskActive(generation)) return { stopped: true };
    const done = findReplyAudienceDoneButton(editorSelector);
    if (done && !confirmedAudienceButtons.has(done)) {
      confirmedAudienceButtons.add(done);
      done.click();
      return null;
    }
    const scopes = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
      .filter((dialog) => dialog.getClientRects().length > 0);
    const currentArticle = getPostContainers().find((post) =>
      getPostId(post)?.match(/\/status\/(\d+)/)?.[1] === targetId);
    if (currentArticle) scopes.push(currentArticle);
    // Detail pages can place the inline composer beside, rather than inside, the article.
    if (location.pathname.match(/\/status\/(\d+)/)?.[1] === targetId) {
      const column = document.querySelector('[data-testid="primaryColumn"]');
      if (column) scopes.push(column);
    }
    for (const scope of scopes) {
      const targetPresent = replyScopeMatchesTarget(scope, targetId, targetAuthor, targetText,
        scope.matches('[role="dialog"],[role="alertdialog"]'));
      if (!targetPresent) {
        composerStage = "发现容器，但目标作者或正文未匹配";
        continue;
      }
      composerStage = "目标帖子已匹配，等待可编辑的空回复框";
      const editor = [...scope.querySelectorAll(editorSelector)].find((candidate) =>
        candidate.getClientRects().length > 0 &&
        (!visibleEditorsBeforeClick.has(candidate) || scope.matches('[role="dialog"],[role="alertdialog"]')) &&
        !getEditorText(candidate));
      if (editor) return { editor, scope };
    }
    return null;
  }, 15000);
  if (composer?.stopped) throw new Error("任务已停止");
  if (!composer) throw new Error(`回复框定位超时：${composerStage}；未写入文字`);
  const { editor, scope } = composer;
  try {
    if (!isTaskActive(generation)) throw new Error("任务已停止");
    const replyModeButton = await waitForElement(() => findReplySubmitButton(scope, false, editor), 1500);
    if (!replyModeButton) throw new Error("新弹窗没有可确认的回复按钮；已阻止输入内容");
    await chrome.storage.local.set({ lastAutomationStatus: "已找到回复框，正在写入回复内容" });
    insertTextIntoEditor(editor, draft);
    const populatedEditor = await waitForElement(() =>
      editor.isConnected && normalizeReplyText(getEditorText(editor)) === normalizeReplyText(draft) ? editor : null, 5000);
    if (!populatedEditor) throw new Error(getEditorText(editor)
      ? "回复框内容与预期不一致；未重复写入或发送"
      : "X 编辑器没有接收回复文本");

    const sendButton = await waitForElement(() => findReplySubmitButton(scope, true, editor), 5000);
    if (!isTaskActive(generation)) {
      closeEmptyReplyDialog(scope, editor, draft);
      throw new Error("回复发送前任务已停止");
    }
    if (!sendButton) throw new Error("回复按钮没有启用；已阻止点击“发帖”按钮");
    const uncertain = await chrome.storage.local.get({ uncertainReplyPostIds: [] });
    await chrome.storage.local.set({ uncertainReplyPostIds: [...new Set([...uncertain.uncertainReplyPostIds, targetId])] });
    if (!isTaskActive(generation)) throw new Error("任务已停止");
    sendButton.click();
    const sent = await waitForElement(() => {
      const successNotice = [...document.querySelectorAll('[role="status"],[role="alert"]')]
        .some((notice) => /reply sent|回复已发送|你的回复已发送|已发送/.test(notice.innerText || ""));
      const dialogClosed = !scope.isConnected || scope.getClientRects().length === 0;
      const editorCleared = !getEditorText(editor);
      return successNotice || dialogClosed || editorCleared ? true : null;
    }, 5000);
    if (!sent) throw new Error("点击回复后未确认 X 已发送；未记录为已评论");
  } catch (error) {
    if (getEditorText(editor)) {
      await chrome.storage.local.set({ lastFailedReplyDraft: { postId: targetId, text: getEditorText(editor), savedAt: Date.now() } });
      throw new Error(`${error.message}；草稿已备份到扩展本地存储`);
    }
    closeEmptyReplyDialog(scope, editor);
    throw error;
  }
}

function normalizeReplyText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").trim();
}

function replyScopeMatchesTarget(scope, targetId, author, text, isNewDialog) {
  if ([...scope.querySelectorAll('a[href*="/status/"]')]
    .some((link) => link.getAttribute("href")?.match(/\/status\/(\d+)/)?.[1] === targetId)) return true;
  if (!isNewDialog || !author || !text) return false;
  const authorMatches = [...scope.querySelectorAll('a[href]')].some((link) => {
    try {
      const path = new URL(link.getAttribute("href"), location.origin).pathname;
      return path.replace(/\/$/, "").toLowerCase() === `/${author.toLowerCase()}`;
    } catch { return false; }
  }) || (scope.innerText || "").match(/@[A-Za-z0-9_]{1,15}/g)
    ?.some((handle) => handle.toLowerCase() === `@${author.toLowerCase()}`);
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const textMatches = [...scope.querySelectorAll('[data-testid="tweetText"]')]
    .some((node) => normalize(node.innerText) === normalize(text)) ||
    normalize(scope.innerText).includes(normalize(text));
  return authorMatches && textMatches;
}

function findReplyAudienceDoneButton(editorSelector) {
  const doneButtons = [...document.querySelectorAll('button,[role="button"]')]
    .filter((button) => button.getClientRects().length > 0 && /^(?:完成|done)$/i.test(visibleControlText(button)));
  for (const button of doneButtons) {
    let container = button.parentElement;
    for (let depth = 0; container && container !== document.body && depth < 9; depth += 1, container = container.parentElement) {
      if (!container.getClientRects().length ||
        [...container.querySelectorAll(editorSelector)].some((editor) => editor.getClientRects().length > 0)) continue;
      const heading = [...container.querySelectorAll('h1,h2,[role="heading"]')]
        .some((element) => /^(?:回复|reply)$/i.test(visibleControlText(element)));
      const firstLine = (container.innerText || "").split("\n").map((line) => line.trim()).find(Boolean) || "";
      if (heading || /^(?:回复|reply)$/i.test(firstLine)) return button;
    }
  }
  return null;
}

function findReplySubmitButton(scope, requireEnabled, editor) {
  if (!editor?.isConnected || !scope?.contains(editor)) return null;
  let container = editor.parentElement;
  while (container && scope.contains(container)) {
    const candidates = [...container.querySelectorAll('[data-testid^="tweetButton"],button,[role="button"]')]
      .filter((candidate) => {
        if (!candidate.getClientRects().length || candidate.matches('[data-testid="reply"]') ||
          !container.contains(candidate) || candidate === editor) return false;
        const labels = [candidate.getAttribute("aria-label"), candidate.innerText || candidate.textContent]
          .map((label) => String(label || "").replace(/\s+/g, " ").trim());
        const isReplyLabel = labels.some((label) => /^(?:回复|reply)(?:\s*\(.*\))?$/i.test(label));
        return candidate.matches('[data-testid^="tweetButton"]') && isReplyLabel &&
          (!requireEnabled || (!candidate.disabled && candidate.getAttribute("aria-disabled") !== "true"));
      });
    if (candidates.length) return candidates[0];
    if (container === scope) break;
    container = container.parentElement;
  }
  return null;
}

function getEditorText(editor) {
  const blocks = [...editor.querySelectorAll('[data-block="true"]')];
  // Read logical lines so decorated links and visual wrapping do not alter the draft.
  const text = blocks.length
    ? blocks.map((block) => block.textContent || "").join("\n")
    : editor.innerText || editor.textContent || "";
  return normalizeReplyText(text);
}

function insertTextIntoEditor(editor, text) {
  if (!editor.isConnected) throw new Error("回复编辑框已关闭；未写入文字");
  if (writtenReplyEditors.has(editor)) throw new Error("此回复框已尝试写入；已阻止重复插入");
  if (getEditorText(editor)) throw new Error("回复框已有草稿；未追加文字");
  if (!normalizeReplyText(text)) throw new Error("回复内容为空；未写入文字");
  editor.focus();
  if (document.activeElement !== editor) throw new Error("无法聚焦回复编辑框；未写入文字");
  const selection = window.getSelection();
  if (!selection) throw new Error("无法定位回复输入光标；未写入文字");
  const caret = document.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(false);
  selection.removeAllRanges();
  selection.addRange(caret);
  // Let the controlled editor own insertion; never combine this with DOM or native insertion.
  try {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    const paste = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData
    });
    writtenReplyEditors.add(editor);
    editor.dispatchEvent(paste);
  } catch {
    throw new Error("无法向回复编辑框传递粘贴内容；未尝试重复插入");
  }
}

function closeEmptyReplyDialog(scope, editor, generatedText = "") {
  const currentText = getEditorText(editor);
  if (currentText && currentText !== generatedText.trim()) return;
  if (currentText) {
    editor.replaceChildren();
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
  }
  if (!scope.matches('[role="dialog"],[role="alertdialog"]')) return;
  const closeButton = [...scope.querySelectorAll('button,[role="button"]')]
    .find((button) => /(close|关闭|取消)/i.test(
      `${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`
    ));
  closeButton?.click();
}

function isTaskActive(generation) {
  return settings.automationRunning && !recovering && generation === taskGeneration;
}

function scheduleErrorRecovery(error, generation) {
  if (!settings.automationRunning || generation !== taskGeneration || recovering) return;
  stopAutoAdvance();
  recovering = true;
  chrome.storage.local.set({
    lastAutomationError: String(error?.message || "任务失败").slice(0, 240),
    lastAutomationStatus: "任务恢复中：30 秒后刷新 X 并重试；点击停止可取消"
  }).catch(() => {});
  recoveryTimer = setTimeout(async () => {
    recoveryTimer = null;
    if (!settings.automationRunning || generation !== taskGeneration) return;
    try {
      const state = await chrome.runtime.sendMessage({ type: "getTaskStateForTab" });
      if (!settings.automationRunning || generation !== taskGeneration) return;
      if (!state?.running) {
        updateTaskState(false);
        return;
      }
      // A full reload also releases stale dialogs and restarts the failed API request via scanning.
      await chrome.storage.local.set({ lastAutomationStatus: "等待结束，正在刷新 X；页面加载后继续扫描" });
      if (!settings.automationRunning || generation !== taskGeneration) return;
      if (taskFeedUrl && !isTaskFeedPage()) location.replace(taskFeedUrl);
      else location.reload();
    } catch (nextError) {
      recovering = false;
      scheduleErrorRecovery(nextError, generation);
    }
  }, 30000);
}

function scheduleAutoAdvance(generation, delay = AUTO_ADVANCE_INTERVAL_MS) {
  clearTimeout(autoAdvanceTimer);
  if (!isTaskActive(generation) || !isTaskFeedPage()) return;
  autoAdvanceTimer = setTimeout(() => {
    autoAdvanceTimer = null;
    if (isTaskActive(generation) && !isTaskFeedPage()) {
      scheduleErrorRecovery(new Error("页面已离开任务信息流，准备返回后继续"), generation);
      return;
    }
    runEngagementRound(generation).catch((error) => {
      if (!isTaskActive(generation)) return;
      scheduleErrorRecovery(error, generation);
    });
  }, delay);
}

async function runEngagementRound(generation) {
  autoAdvanceTimer = null;
  if (engagementRoundRunning || !isTaskActive(generation) || !isTaskFeedPage()) return;
  engagementRoundRunning = true;
  taskFeedUrl = location.href;
  startFollowerMonitor();
  try {
    // Freeze this round so DOM mutations cannot keep extending its queue.
    const posts = getPostContainers();
    actionsThisPage = 0;
    for (let index = 0; index < posts.length; index += 1) {
      if (!isTaskActive(generation) || !isTaskFeedPage()) return;
      if (settings.homeFollowMutualPosts && location.pathname === "/home") {
        const { followCooldownUntil = 0 } = await chrome.storage.local.get({ followCooldownUntil: 0 });
        if (Date.now() < followCooldownUntil) {
          scheduleFollowCooldownResume(followCooldownUntil, generation);
          return;
        }
      }
      if (actionsThisPage >= MAX_ACTIONS_PER_PAGE) {
        scheduleAutoAdvance(generation, 1000);
        return;
      }
      await chrome.storage.local.set({ lastAutomationError: "", lastAutomationStatus: `本轮正在识别并处理第 ${index + 1}/${posts.length} 条帖子` });
      scanningRound = true;
      try { processPost(posts[index]); } finally { scanningRound = false; }
      // Finish queued actions before processing the next post.
      let current;
      do {
        current = pending;
        await current;
        if (!isTaskActive(generation)) return;
      } while (current !== pending);
    }
    if (!isTaskActive(generation)) return;
    if (settings.homeFollowMutualPosts && location.pathname === "/home") {
      const { followCooldownUntil = 0 } = await chrome.storage.local.get({ followCooldownUntil: 0 });
      if (Date.now() < followCooldownUntil) {
        scheduleFollowCooldownResume(followCooldownUntil, generation);
        return;
      }
    }
    const noActions = actionsThisPage === 0;
    await chrome.storage.local.set({ lastAutomationError: "", lastAutomationStatus: noActions
      ? "本轮没有可执行的新目标，正在下滑获取新内容…"
      : "本轮处理完毕，正在下滑寻找下一批帖子…" });
    await autoAdvance(generation);
  } finally {
    engagementRoundRunning = false;
    if (settings.automationRunning && taskGeneration !== generation && isTaskFeedPage()) {
      scheduleAutoAdvance(taskGeneration, 1000);
    } else if (isTaskActive(generation) && !autoAdvanceTimer && !followResumeTimer) {
      if (isTaskFeedPage()) {
        scheduleAutoAdvance(generation, 1000);
      } else {
        scheduleErrorRecovery(new Error("评论后未返回任务信息流，准备刷新恢复"), generation);
      }
    }
  }
}

async function autoAdvance(generation) {
  autoAdvanceTimer = null;
  if (!isTaskActive(generation) || !isTaskFeedPage()) return;
  const nextRoundDelay = 1000;

  const before = getFeedSignature();
  if (previousFeedSignature && previousFeedSignature !== before) {
    stalledAdvances = 0;
    lastActivityAt = Date.now();
  }
  previousFeedSignature = before;

  const lastPost = getPostContainers().at(-1);
  lastPost?.scrollIntoView({ block: "end", behavior: "instant" });
  window.scrollTo({ top: document.scrollingElement?.scrollHeight || document.documentElement.scrollHeight, behavior: "instant" });
  await new Promise((resolve) => setTimeout(resolve, ADVANCE_SETTLE_MS));
  if (!isTaskActive(generation)) return;

  scan();
  const after = getFeedSignature();
  if (after !== before) {
    stalledAdvances = 0;
    lastActivityAt = Date.now();
    actionsThisPage = 0;
    previousFeedSignature = after;
    scheduleAutoAdvance(generation, nextRoundDelay);
    return;
  }

  const idleLimit = Math.max(1, Number(settings.idleRefreshMinutes) || 3) * 60_000;
  if (Date.now() - lastActivityAt >= idleLimit) {
    await chrome.storage.local.set({ autoRefreshAt: Date.now() });
    if (!isTaskActive(generation)) return;
    await refreshCurrentView(generation);
    return;
  }

  stalledAdvances += 1;
  if (stalledAdvances >= 2) {
    const { autoRefreshAt = 0 } = await chrome.storage.local.get({ autoRefreshAt: 0 });
    if (!isTaskActive(generation)) return;
    if (Date.now() - autoRefreshAt >= 30000) {
      await chrome.storage.local.set({ autoRefreshAt: Date.now() });
      if (!isTaskActive(generation)) return;
      await chrome.storage.local.set({ lastAutomationStatus: "连续下滑没有新内容，正在刷新后继续扫描…" });
      await refreshCurrentView(generation);
      return;
    }
    stalledAdvances = 0;
  }
  scheduleAutoAdvance(generation, nextRoundDelay);
}

async function refreshCurrentView(generation) {
  if (!isTaskActive(generation)) return;
  if (location.pathname === "/home") {
    const findHomeLink = () => {
      const link = document.querySelector('[data-testid="AppTabBar_Home_Link"], a[href="/home"]');
      return link?.getClientRects().length ? link : null;
    };
    const firstClick = findHomeLink();
    if (firstClick) {
      firstClick.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!isTaskActive(generation)) return;
      const secondClick = findHomeLink();
      if (secondClick) {
        secondClick.click();
        await new Promise((resolve) => setTimeout(resolve, 1800));
        if (!isTaskActive(generation)) return;
        scan();
        lastActivityAt = Date.now();
        previousFeedSignature = getFeedSignature();
        stalledAdvances = 0;
        scheduleAutoAdvance(generation, 1000);
        return;
      }
    }
  }

  location.reload();
}

function getFeedSignature() {
  const postLinks = getPostContainers()
    .map((post) => getPostId(post))
    .filter(Boolean);
  const uniquePosts = [...new Set(postLinks)];
  return uniquePosts.join(",");
}

function isTaskFeedPage() {
  return location.pathname === "/home" || isOwnPostThreadPage();
}

function relationshipListPath(taskMode) {
  const username = getCurrentUsername();
  if (!username) return null;
  const list = taskMode === "unfollowNonMutual" ? "following" : "followers";
  return `/${username}/${list}`;
}

function relationshipTaskConfig(taskMode) {
  const unfollow = taskMode === "unfollowNonMutual";
  const limitKey = unfollow ? "unfollowAccountLimit" : "followBackAccountLimit";
  const intervalKey = unfollow ? "unfollowIntervalSeconds" : "followBackIntervalSeconds";
  return {
    limit: Math.min(1000, Math.max(1, Math.floor(Number(settings[limitKey]) || 50))),
    intervalSeconds: Math.min(3600, Math.max(1, Math.floor(Number(settings[intervalKey]) || 10)))
  };
}

async function waitForRelationshipRateSlot(taskMode, generation) {
  const interval = relationshipTaskConfig(taskMode).intervalSeconds * 1000;
  while (lastRelationshipActionAt && Date.now() - lastRelationshipActionAt < interval) {
    if (!isTaskActive(generation)) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, interval - (Date.now() - lastRelationshipActionAt))));
  }
  return isTaskActive(generation);
}

function scrollRelationshipList() {
  const step = Math.max(500, Math.round(window.innerHeight * 0.8));
  let element = document.querySelector('[data-testid="UserCell"]');
  while (element && element !== document.body && element !== document.documentElement) {
    const style = getComputedStyle(element);
    if (element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 80 &&
      /auto|scroll/.test(style.overflowY)) {
      element.scrollBy({ top: step, behavior: "smooth" });
      return;
    }
    element = element.parentElement;
  }
  window.scrollBy({ top: step, behavior: "smooth" });
}

function startRelationshipTask(taskMode, generation) {
  const expectedPath = relationshipListPath(taskMode);
  if (!expectedPath) throw new Error("无法识别当前 X 账号，不能打开关注列表");
  if (location.pathname.toLowerCase() !== expectedPath.toLowerCase()) {
    location.assign(`${location.origin}${expectedPath}`);
    return;
  }
  relationshipTried.clear();
  relationshipActionsCompleted = 0;
  lastRelationshipActionAt = 0;
  const { limit, intervalSeconds } = relationshipTaskConfig(taskMode);
  chrome.storage.local.set({ lastAutomationStatus: `任务已启动：每个账号间隔 ${intervalSeconds} 秒，本次最多执行 ${limit} 个账号` });
  scanRelationshipList(taskMode, generation);
  scheduleRelationshipScan(taskMode, generation);
}

function scheduleRelationshipScan(taskMode, generation) {
  clearTimeout(relationshipTimer);
  relationshipTimer = setTimeout(() => {
    if (!isTaskActive(generation) || settings.automationTask !== taskMode) return;
    if (relationshipActionsCompleted >= relationshipTaskConfig(taskMode).limit) {
      chrome.storage.local.set({ automationRunning: false, lastAutomationStatus: `已达到本次执行数量：${relationshipActionsCompleted} 个账号` });
      return;
    }
    scanRelationshipList(taskMode, generation);
    if (relationshipQueued.size === 0) {
      scrollRelationshipList();
    }
    scheduleRelationshipScan(taskMode, generation);
  }, 4000);
}

function scanRelationshipList(taskMode, generation) {
  if (!isTaskActive(generation) || settings.automationTask !== taskMode) return;
  const expectedPath = relationshipListPath(taskMode);
  if (!expectedPath || location.pathname.toLowerCase() !== expectedPath.toLowerCase()) return;
  const ownUsername = getCurrentUsername();
  const rows = [...document.querySelectorAll('[data-testid="UserCell"]')];
  for (const row of rows) {
    const username = getRelationshipUsername(row);
    if (!username || username === ownUsername || relationshipTried.has(username) || relationshipQueued.has(username)) continue;
    const buttons = [...row.querySelectorAll('button,[role="button"]')];
    const followButton = buttons.find((button) => button.getAttribute("data-testid") === "follow") ||
      buttons.find((button) => /^(?:follow|关注|回关)(?:\s|$)/i.test(controlLabel(button)));
    const unfollowButton = buttons.find((button) => button.getAttribute("data-testid") === "unfollow") ||
      buttons.find((button) => /^(?:following|正在关注|已关注|取消关注)(?:\s|$)/i.test(controlLabel(button)));
    const followsYou = relationshipRowFollowsYou(row);
    const needsUnfollow = taskMode === "unfollowNonMutual" && unfollowButton && !followsYou;
    const needsFollowBack = taskMode === "followBackFollowers" && followButton;
    if (!needsUnfollow && !needsFollowBack) continue;

    relationshipQueued.add(username);
    relationshipTried.add(username);
    pending = pending.then(async () => {
      try {
        if (!isTaskActive(generation) || relationshipActionsCompleted >= relationshipTaskConfig(taskMode).limit) return;
        await processRelationshipUser(row, username, taskMode, needsUnfollow ? unfollowButton : followButton, generation);
      } catch (error) {
        scheduleErrorRecovery(error, generation);
      } finally {
        relationshipQueued.delete(username);
      }
    });
  }
}

function getRelationshipUsername(row) {
  for (const link of row.querySelectorAll('a[href^="/"]')) {
    const match = link.getAttribute("href")?.match(/^\/(?!i\/)([^/?#]+)\/?$/);
    if (match && /^[A-Za-z0-9_]{1,15}$/.test(match[1])) return match[1].toLowerCase();
  }
  return null;
}

async function processRelationshipUser(row, username, taskMode, actionButton, generation) {
  if (!row.isConnected || !isTaskActive(generation)) return;
  if (relationshipActionsCompleted >= relationshipTaskConfig(taskMode).limit) return;
  if (!await waitForRelationshipRateSlot(taskMode, generation)) return;
  if (taskMode === "unfollowNonMutual" && relationshipRowFollowsYou(row)) {
    await chrome.storage.local.set({ lastAutomationStatus: `已跳过 @${username}：对方关注了你` });
    return;
  }
  if (taskMode === "unfollowNonMutual" && !row.contains(actionButton)) {
    throw new Error(`@${username} 的关注状态已变化，请重新扫描`);
  }
  lastRelationshipActionAt = Date.now();
  actionButton.click();

  if (taskMode === "unfollowNonMutual") {
    const confirmButton = await waitForElement(() => [...document.querySelectorAll('button,[role="button"]')]
      .filter((button) => button.getClientRects().length > 0)
      .find((button) => /^(?:取消关注|unfollow)(?:\s|$)/i.test(visibleControlText(button))), 5000);
    if (confirmButton) {
      confirmButton.click();
    } else {
      const alreadyUnfollowed = [...row.querySelectorAll('button,[role="button"]')].some((button) =>
        button.getAttribute("data-testid") === "follow" || /^(?:关注|follow)(?:\s|$)/i.test(visibleControlText(button)));
      if (!alreadyUnfollowed) throw new Error(`点击 @${username} 的关注按钮后，没有出现取消关注确认按钮`);
    }
  }

  const completed = await waitForElement(() => {
    if (!row.isConnected) return true;
    const currentButtons = [...row.querySelectorAll('button,[role="button"]')];
    if (taskMode === "unfollowNonMutual") {
      return currentButtons.some((button) => button.getAttribute("data-testid") === "follow" ||
        /^(?:关注|follow)(?:\s|$)/i.test(visibleControlText(button))) ? true : null;
    }
    return currentButtons.some((button) => button.getAttribute("data-testid") === "unfollow" ||
      /^(?:following|正在关注|已关注)(?:\s|$)/i.test(controlLabel(button))) ? true : null;
  }, 5000);
  if (!completed) throw new Error(`X 未确认对 @${username} 的${taskMode === "unfollowNonMutual" ? "取消关注" : "回关"}`);

  const key = taskMode === "unfollowNonMutual" ? "unfollowedNonMutual" : "followedBackAuthors";
  const stored = await chrome.storage.local.get({ [key]: [] });
  await chrome.storage.local.set({
    [key]: [...new Set([...(stored[key] || []), username])],
    lastAutomationStatus: taskMode === "unfollowNonMutual" ? `已取消关注 @${username}` : `已回关 @${username}`
  });
  relationshipActionsCompleted += 1;
  lastActivityAt = Date.now();
  const { limit, intervalSeconds } = relationshipTaskConfig(taskMode);
  if (relationshipActionsCompleted >= limit) {
    await chrome.storage.local.set({
      automationRunning: false,
      lastAutomationStatus: `已达到本次执行数量：${relationshipActionsCompleted} 个账号`
    });
  } else {
    await chrome.storage.local.set({
      lastAutomationStatus: `${taskMode === "unfollowNonMutual" ? "已取消关注" : "已回关"} @${username}；本次 ${relationshipActionsCompleted}/${limit} 个，每个账号间隔 ${intervalSeconds} 秒`
    });
  }
}

function stopAutoAdvance() {
  clearTimeout(autoAdvanceTimer);
  autoAdvanceTimer = null;
  clearTimeout(relationshipTimer);
  relationshipTimer = null;
  clearTimeout(followResumeTimer);
  followResumeTimer = null;
  stalledAdvances = 0;
  previousFeedSignature = "";
}

function scheduleFollowCooldownResume(until, generation) {
  clearTimeout(followResumeTimer);
  const delay = Math.max(1000, until - Date.now());
  followResumeTimer = setTimeout(async () => {
    followResumeTimer = null;
    if (!isTaskActive(generation) || location.pathname !== "/home") return;
    const { followCooldownUntil = 0 } = await chrome.storage.local.get({ followCooldownUntil: 0 });
    if (Date.now() < followCooldownUntil) {
      scheduleFollowCooldownResume(followCooldownUntil, generation);
      return;
    }
    await chrome.storage.local.set({ followCooldownUntil: 0, lastAutomationError: "" });
    lastActivityAt = Date.now();
    await refreshCurrentView(generation);
  }, delay);
}

function restoreFollowCooldown(generation) {
  if (!settings.homeFollowMutualPosts || location.pathname !== "/home") return;
  chrome.storage.local.get({ followCooldownUntil: 0 }).then(({ followCooldownUntil }) => {
    if (!isTaskActive(generation) || Date.now() >= followCooldownUntil) return;
    stopAutoAdvance();
    scheduleFollowCooldownResume(followCooldownUntil, generation);
  });
}

function waitForElement(find, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const element = find();
      if (element || Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve(element || null);
      }
    }, 100);
  });
}

function getAuthor(article) {
  const statusLink = [...article.querySelectorAll('a[href*="/status/"]')]
    .find((link) => /\/status\/\d+/.test(link.getAttribute("href") || ""));
  const statusMatch = statusLink?.getAttribute("href")?.match(/^\/(?!i\/)([^/]+)\/status\//);
  if (statusMatch) return statusMatch[1].replace(/^@/, "").toLowerCase();

  const usernameLink = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
  const usernameMatch = usernameLink?.getAttribute("href")?.match(/^\/(?!i\/)([^/?#]+)\/?$/);
  if (usernameMatch) return usernameMatch[1].replace(/^@/, "").toLowerCase();
  const handleMatch = article.querySelector('[data-testid="User-Name"]')?.innerText.match(/@([A-Za-z0-9_]{1,15})/);
  return handleMatch?.[1]?.toLowerCase() || null;
}

function getCurrentUsername() {
  const profileLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"]') ||
    [...document.querySelectorAll('a[href^="/"]')].find((link) => {
      const label = `${link.getAttribute("aria-label") || ""} ${link.innerText || link.textContent || ""}`;
      return /个人资料|profile/i.test(label);
    });
  const match = profileLink?.getAttribute("href")?.match(/^\/([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/);
  return match?.[1]?.toLowerCase() || "";
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "taskHandshake") {
    sendResponse({
      controllerVersion: 23,
      identityAvailable: Boolean(getCurrentUsername()),
      feedSupported: isTaskFeedPage(),
      ownPostReplySupported: Boolean(ownPostThreadContext())
    });
    return;
  }
  if (message?.type !== "taskControl") return;
  if (["engagement", "unfollowNonMutual", "followBackFollowers"].includes(message.taskMode)) {
    settings.automationTask = message.taskMode;
  }
  if (message.settings && typeof message.settings === "object") {
    for (const key of ["autoFollowBack", "homeFollowMutualPosts", "homeReplyMutualPosts", "ownPostCommentReply"]) {
      if (typeof message.settings[key] === "boolean") settings[key] = message.settings[key];
    }
  }
  try {
    updateTaskState(message.running === true);
  } catch (error) {
    chrome.storage.local.set({
      automationRunning: false,
      lastAutomationError: String(error?.message || "任务无法启动").slice(0, 240)
    });
    sendResponse({ running: false, supported: false, error: String(error?.message || "任务无法启动") });
    return;
  }
  const posts = getPostContainers();
  const ownThread = ownPostThreadContext();
  const ownCommentCount = ownThread
    ? posts.filter((post) => getPostId(post)?.match(/\/status\/(\d+)/)?.[1] !== ownThread.postId &&
      getAuthor(post) && getAuthor(post) !== ownThread.username).length
    : 0;
  const matchCount = posts.filter((post) => {
    if (settings.ownPostCommentReply && ownThread) return false;
    const hits = matchedTerms(findPostText(post));
    return location.pathname === "/home" && (hits.length > 0) &&
      (settings.homeFollowMutualPosts || settings.homeReplyMutualPosts);
  }).length + (settings.ownPostCommentReply ? ownCommentCount : 0);
  const relationshipTask = ["unfollowNonMutual", "followBackFollowers"].includes(settings.automationTask);
  const expectedRelationshipPath = relationshipTask ? relationshipListPath(settings.automationTask) : null;
  const supported = relationshipTask ? Boolean(expectedRelationshipPath) :
    settings.ownPostCommentReply && ownThread ? true :
      (settings.autoFollowBack || settings.homeFollowMutualPosts || settings.homeReplyMutualPosts) && location.pathname === "/home";
  const status = relationshipTask
    ? location.pathname.toLowerCase() === expectedRelationshipPath?.toLowerCase()
      ? `正在扫描 @${getCurrentUsername()} 的${settings.automationTask === "unfollowNonMutual" ? "正在关注" : "关注者"}列表`
      : `正在打开 @${getCurrentUsername()} 的${settings.automationTask === "unfollowNonMutual" ? "正在关注" : "关注者"}列表…`
    : settings.ownPostCommentReply && ownThread
      ? `正在扫描你发布的帖子评论，当前找到 ${ownCommentCount} 条他人评论`
      : null;
  sendResponse({
    controllerVersion: 23,
    running: settings.automationRunning,
    supported,
    status,
    error: supported ? "" : "当前页面不支持所选任务，请打开 X 首页或自己发布的帖子详情页。",
    postCount: posts.length,
    matchCount,
    relationshipCount: document.querySelectorAll('[data-testid="UserCell"]').length
  });
});

chrome.storage.local.get({
  automationTask: "engagement",
  autoFollowBack: false,
  homeFollowMutualPosts: false,
  homeReplyMutualPosts: false,
  ownPostCommentReply: false,
  idleRefreshMinutes: settings.idleRefreshMinutes,
  unfollowAccountLimit: settings.unfollowAccountLimit,
  unfollowIntervalSeconds: settings.unfollowIntervalSeconds,
  followBackAccountLimit: settings.followBackAccountLimit,
  followBackIntervalSeconds: settings.followBackIntervalSeconds,
  automationRunning: false
}).then((value) => {
  settings = value;
  settings.automationRunning = false;
  chrome.runtime.sendMessage({ type: "getTaskStateForTab" }).then((taskState) => {
    if (taskState?.followerMonitor) { runFollowerMonitor(); return; }
    settings.automationTask = taskState?.taskMode || settings.automationTask;
    if (taskState?.running === true) {
      try {
        updateTaskState(true);
      } catch (error) {
        chrome.storage.local.set({ automationRunning: false, lastAutomationError: String(error?.message || "任务无法启动").slice(0, 240) });
      }
    }
    scan();
  }).catch(() => scan());
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.autoFollowBack) {
    settings.autoFollowBack = changes.autoFollowBack.newValue === true;
    if (settings.automationRunning && settings.autoFollowBack) startFollowerMonitor();
  }
  if (changes.automationTask) settings.automationTask = changes.automationTask.newValue || "engagement";
  if (changes.homeFollowMutualPosts) settings.homeFollowMutualPosts = changes.homeFollowMutualPosts.newValue === true;
  if (changes.homeReplyMutualPosts) settings.homeReplyMutualPosts = changes.homeReplyMutualPosts.newValue === true;
  if (changes.ownPostCommentReply) settings.ownPostCommentReply = changes.ownPostCommentReply.newValue === true;
  if (changes.idleRefreshMinutes) {
    settings.idleRefreshMinutes = [1, 3, 5, 10].includes(Number(changes.idleRefreshMinutes.newValue))
      ? Number(changes.idleRefreshMinutes.newValue)
      : 3;
  }
  for (const key of ["unfollowAccountLimit", "unfollowIntervalSeconds", "followBackAccountLimit", "followBackIntervalSeconds"]) {
    if (changes[key]) settings[key] = Number(changes[key].newValue) || settings[key];
  }
  if (changes.automationRunning && changes.automationRunning.newValue === false) {
    updateTaskState(false);
  }
  if ((changes.homeFollowMutualPosts || changes.homeReplyMutualPosts || changes.ownPostCommentReply) &&
    settings.automationRunning) scan();
});

function updateTaskState(running) {
  if (settings.automationRunning === running) return;
  clearTimeout(recoveryTimer);
  recoveryTimer = null;
  recovering = false;
  settings.automationRunning = running;
  taskGeneration += 1;
  if (running) {
    stopAutoAdvance();
    actedPosts.clear();
    actionsThisPage = 0;
    stalledAdvances = 0;
    previousFeedSignature = getFeedSignature();
    lastActivityAt = Date.now();
    startCurrentTask(taskGeneration);
    restoreFollowCooldown(taskGeneration);
  } else {
    stopAutoAdvance();
    actedPosts.clear();
    relationshipQueued.clear();
    ownPostReplyQueued.clear();
  }
}

function startFollowerMonitor() {
  if (!settings.autoFollowBack || settings.automationTask !== "engagement") return;
  chrome.runtime.sendMessage({ type: "ensureFollowerMonitor", username: getCurrentUsername() }).then((result) => {
    if (result?.error) chrome.storage.local.set({ followerMonitorStatus: result.error });
  }).catch(() => {});
}

function startCurrentTask(generation) {
  startFollowerMonitor();
  if (settings.automationTask === "unfollowNonMutual" || settings.automationTask === "followBackFollowers") {
    startRelationshipTask(settings.automationTask, generation);
    return;
  }
  scan();
  if (isTaskFeedPage()) scheduleAutoAdvance(generation, 500);
}

function scan() {
  if (settings.automationTask === "unfollowNonMutual" || settings.automationTask === "followBackFollowers") {
    scanRelationshipList(settings.automationTask, taskGeneration);
    return;
  }
  if (settings.automationRunning && !scanningRound) return;
  const posts = getPostContainers();
  if (settings.automationRunning && settings.automationTask === "engagement" && Date.now() - lastFeedStatusAt >= 10000) {
    const matches = posts.filter((post) => {
      const hits = matchedTerms(findPostText(post));
      return (location.pathname === "/home" && (settings.homeFollowMutualPosts || settings.homeReplyMutualPosts) &&
        (hits.length > 0)) ||
        (settings.ownPostCommentReply && isOwnPostThreadPage() && getPostId(post)?.match(/\/status\/(\d+)/)?.[1] !== ownPostThreadContext()?.postId);
    }).length;
    chrome.storage.local.set({
      lastAutomationStatus: `扫描进度：当前已加载 ${posts.length} 条帖子，${matches} 条符合所选任务`
    });
    lastFeedStatusAt = Date.now();
  }
  posts.forEach(processPost);
}

scan();
const observer = new MutationObserver(scan);
observer.observe(document.body, { childList: true, subtree: true });
