const TERMS = [
  "互关", "回关", "互fo", "互粉", "关注我", "求关注", "关注必回", "回粉", "蓝V", "蓝 v", "蓝色认证",
  "你关我回", "关我回", "你关我也关", "互关互粉", "互粉互关", "求互关", "互关团", "互fo团", "秒跟", "开团秒跟",
  "回复", "互动", "follow back", "follow for follow", "follow me i follow back", "f4f", "follow train", "mutuals"
];
const BADGE = "x-mutual-helper-badge";
const REPLIED_AUTHORS_KEY = "repliedAuthors";
const REPLIED_POSTS_KEY = "repliedPostIds";
const AI_POST_CLASSIFICATIONS_KEY = "mutualPostClassifications";
let settings = {
  automationTask: "engagement",
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
let pending = Promise.resolve();
let actionsThisPage = 0;
let taskGeneration = 0;
const actedPosts = new Set();
const aiPostClassifications = new Map();
const aiClassificationQueued = new Set();
const ownPostReplyQueued = new Set();
const OWN_POST_REPLIED_COMMENTS_KEY = "repliedOwnPostComments";
const relationshipQueued = new Set();
const relationshipTried = new Set();
const MAX_ACTIONS_PER_PAGE = 20;
const AUTO_ADVANCE_INTERVAL_MS = 15000;
const ADVANCE_SETTLE_MS = 2500;
const STALLED_ADVANCES_BEFORE_REFRESH = 4;
const REFRESH_COOLDOWN_MS = 180000;
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
      await sendReplyToPost(article, result.draft, generation);
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
      await chrome.storage.local.set({ lastAutomationError: String(error?.message || "回复帖子评论失败").slice(0, 240) });
    } finally {
      ownPostReplyQueued.delete(key);
    }
  });
}

function queueMutualPostClassification(article, postText, postId) {
  if (aiClassificationQueued.has(postId) || aiPostClassifications.has(postId)) return;
  aiClassificationQueued.add(postId);
  const generation = taskGeneration;
  pending = pending.then(async () => {
    if (!isTaskActive(generation)) return;
    const saved = await chrome.storage.local.get({ [AI_POST_CLASSIFICATIONS_KEY]: {} });
    const cache = saved[AI_POST_CLASSIFICATIONS_KEY] && typeof saved[AI_POST_CLASSIFICATIONS_KEY] === "object"
      ? saved[AI_POST_CLASSIFICATIONS_KEY]
      : {};
    let category = cache[postId];
    if (!["mutual", "friendship", "none"].includes(category)) {
      const result = await chrome.runtime.sendMessage({ type: "classifyMutualPost", postText });
      if (!isTaskActive(generation)) return;
      if (result?.error) throw new Error(result.error);
      if (!["mutual", "friendship", "none"].includes(result?.category)) {
        throw new Error("AI 没有返回有效的帖子分类");
      }
      category = result.category;
      cache[postId] = category;
      const recentEntries = Object.entries(cache).slice(-1000);
      await chrome.storage.local.set({ [AI_POST_CLASSIFICATIONS_KEY]: Object.fromEntries(recentEntries) });
    }
    aiPostClassifications.set(postId, category);
    if (!isTaskActive(generation) || !article.isConnected) return;
    if (category === "mutual" || category === "friendship") {
      await chrome.storage.local.set({
        lastAutomationError: "",
        lastAutomationStatus: `AI 识别为${category === "mutual" ? "互关贴" : "交友贴"}，正在处理`
      });
      processPost(article);
    }
  }).catch((error) => {
    aiPostClassifications.set(postId, "error");
    console.error("X Mutual Helper post classification failed", error);
    chrome.storage.local.set({ lastAutomationError: String(error?.message || "AI 帖子分类失败").slice(0, 240) });
  }).finally(() => {
    aiClassificationQueued.delete(postId);
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
  const aiCategory = postId ? aiPostClassifications.get(postId) : null;
  const aiMutualIntent = aiCategory === "mutual" || aiCategory === "friendship";
  const isHomepage = location.pathname === "/home";
  const shouldUseAI = settings.automationRunning && isHomepage && postId && !hits.length &&
    !aiPostClassifications.has(postId) &&
    (settings.homeFollowMutualPosts || settings.homeReplyMutualPosts);
  if (shouldUseAI) {
    queueMutualPostClassification(article, text, postId);
    return;
  }
  if (!hits.length && !aiMutualIntent) return;

  if (!article.querySelector(`.${BADGE}`)) {
    const container = document.createElement("div");
    container.className = BADGE;
    const label = document.createElement("span");
    const labels = [];
    if (hits.length) labels.push(`疑似互关贴：${hits.slice(0, 3).join("、")}`);
    if (aiCategory === "mutual") labels.push("AI 识别：互关贴");
    if (aiCategory === "friendship") labels.push("AI 识别：交友贴");
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

  const mutualIntent = hits.length > 0 || aiMutualIntent;
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
      chrome.storage.local.set({ lastAutomationError: String(error?.message || "自动回复失败").slice(0, 240) });
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
  await sendReplyToPost(article, result.draft, generation);
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
  const replyButton = article.querySelector('[data-testid="reply"]') || [...article.querySelectorAll('button,[role="button"]')]
    .find((button) => /回复|reply/i.test(`${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`));
  if (!replyButton) throw new Error("找不到此帖的回复按钮");
  const editorSelector = '[data-testid="tweetTextarea_0"], [role="textbox"][contenteditable="true"]';
  const visibleEditorsBeforeClick = new Set([...document.querySelectorAll(editorSelector)]
    .filter((editor) => editor.getClientRects().length > 0));
  replyButton.click();
  const replyAudienceDoneButton = await waitForElement(() => {
    return findReplyAudienceDoneButton(editorSelector);
  }, 5000);
  if (replyAudienceDoneButton) replyAudienceDoneButton.click();
  const composer = await waitForElement(() => {
    const newDialog = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
      .find((dialog) => dialog.getClientRects().length > 0 &&
        [...dialog.querySelectorAll(editorSelector)].some((editor) =>
          editor.getClientRects().length > 0 && !visibleEditorsBeforeClick.has(editor)));
    const dialogEditor = newDialog && [...newDialog.querySelectorAll(editorSelector)]
      .find((editor) => editor.getClientRects().length > 0 && !visibleEditorsBeforeClick.has(editor));
    if (dialogEditor) return { editor: dialogEditor, scope: newDialog };

    const inlineEditor = [...article.querySelectorAll(editorSelector)]
      .find((editor) => editor.getClientRects().length > 0 && !visibleEditorsBeforeClick.has(editor));
    if (inlineEditor) return { editor: inlineEditor, scope: article };

    const focusedEditor = document.activeElement?.matches?.(editorSelector) &&
      document.activeElement.getClientRects().length > 0 && !visibleEditorsBeforeClick.has(document.activeElement)
      ? document.activeElement
      : null;
    if (focusedEditor) return {
      editor: focusedEditor,
      scope: focusedEditor.closest('[role="dialog"],[role="alertdialog"],article,[data-testid="cellInnerDiv"]') || focusedEditor.parentElement
    };
    return null;
  }, 8000);
  if (!composer) throw new Error("点击回复后没有出现新的回复编辑框；已跳过，未写入其他编辑框");
  const { editor, scope } = composer;
  try {
    const replyModeButton = await waitForElement(() => findReplySubmitButton(scope, false, editor), 1500);
    if (!replyModeButton) throw new Error("新弹窗没有可确认的回复按钮；已阻止输入内容");
    insertTextIntoEditor(editor, draft);
    const populatedEditor = await waitForElement(() =>
      getEditorText(editor).includes(draft) ? editor : null, 2500);
    if (!populatedEditor) throw new Error("X 编辑器没有接收回复文本");

    const sendButton = await waitForElement(() => findReplySubmitButton(scope, true, editor), 5000);
    if (!isTaskActive(generation)) {
      closeEmptyReplyDialog(scope, editor, draft);
      throw new Error("回复发送前任务已停止");
    }
    if (!sendButton) throw new Error("回复按钮没有启用；已阻止点击“发帖”按钮");
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
    closeEmptyReplyDialog(scope, editor, draft);
    throw error;
  }
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
        const label = `${candidate.getAttribute("aria-label") || ""} ${candidate.innerText || candidate.textContent || ""}`
          .replace(/\s+/g, " ").trim().toLocaleLowerCase();
        const isSubmitControl = candidate.matches('[data-testid^="tweetButton"]');
        const isReplyLabel = /^(?:回复|reply)(?:\s*\(.*\))?$/.test(label);
        return (isSubmitControl || isReplyLabel) && (!requireEnabled || !candidate.disabled);
      });
    if (candidates.length) return candidates[0];
    if (container === scope) break;
    container = container.parentElement;
  }
  return null;
}

function getEditorText(editor) {
  return String(editor.innerText || editor.textContent || "").replace(/\u00a0/g, " ").trim();
}

function insertTextIntoEditor(editor, text) {
  editor.focus();
  try {
    document.execCommand("insertText", false, text);
  } catch {
    // Use the DOM input path below when execCommand is unavailable.
  }
  if (getEditorText(editor).includes(text)) {
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return;
  }

  editor.dispatchEvent(new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "insertText",
    data: text
  }));
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  editor.dispatchEvent(new Event("change", { bubbles: true }));
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
  return settings.automationRunning && generation === taskGeneration;
}

function scheduleAutoAdvance(generation, delay = AUTO_ADVANCE_INTERVAL_MS) {
  clearTimeout(autoAdvanceTimer);
  if (!isTaskActive(generation) || !isTaskFeedPage()) return;
  autoAdvanceTimer = setTimeout(() => autoAdvance(generation), delay);
}

async function autoAdvance(generation) {
  autoAdvanceTimer = null;
  if (!isTaskActive(generation) || !isTaskFeedPage()) return;
  await waitForPendingActions();
  if (!isTaskActive(generation)) return;

  const before = getFeedSignature();
  if (previousFeedSignature && previousFeedSignature !== before) {
    stalledAdvances = 0;
    lastActivityAt = Date.now();
  }
  previousFeedSignature = before;

  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
  await new Promise((resolve) => setTimeout(resolve, ADVANCE_SETTLE_MS));
  if (!isTaskActive(generation)) return;

  scan();
  const after = getFeedSignature();
  if (after !== before) {
    stalledAdvances = 0;
    lastActivityAt = Date.now();
    actionsThisPage = 0;
    previousFeedSignature = after;
    scheduleAutoAdvance(generation);
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
  if (stalledAdvances >= STALLED_ADVANCES_BEFORE_REFRESH) {
    const { autoRefreshAt = 0 } = await chrome.storage.local.get({ autoRefreshAt: 0 });
    if (!isTaskActive(generation)) return;
    if (Date.now() - autoRefreshAt >= REFRESH_COOLDOWN_MS) {
      await chrome.storage.local.set({ autoRefreshAt: Date.now() });
      if (!isTaskActive(generation)) return;
      await refreshCurrentView(generation);
      return;
    }
    stalledAdvances = 0;
  }
  scheduleAutoAdvance(generation);
}

async function waitForPendingActions() {
  while (true) {
    const current = pending;
    await current;
    if (current === pending) return;
  }
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
        scheduleAutoAdvance(generation);
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
  return `${document.documentElement.scrollHeight}:${uniquePosts.length}:${uniquePosts.slice(0, 3).join(",")}:${uniquePosts.slice(-3).join(",")}`;
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
        await chrome.storage.local.set({ lastAutomationError: String(error?.message || "关注列表操作失败").slice(0, 240) });
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
      controllerVersion: 10,
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
    for (const key of ["homeFollowMutualPosts", "homeReplyMutualPosts", "ownPostCommentReply"]) {
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
    const aiCategory = aiPostClassifications.get(getPostId(post));
    const aiMatch = aiCategory === "mutual" || aiCategory === "friendship";
    return location.pathname === "/home" && (hits.length > 0 || aiMatch) &&
      (settings.homeFollowMutualPosts || settings.homeReplyMutualPosts);
  }).length + (settings.ownPostCommentReply ? ownCommentCount : 0);
  const relationshipTask = ["unfollowNonMutual", "followBackFollowers"].includes(settings.automationTask);
  const expectedRelationshipPath = relationshipTask ? relationshipListPath(settings.automationTask) : null;
  const supported = relationshipTask ? Boolean(expectedRelationshipPath) :
    settings.ownPostCommentReply && ownThread ? true :
      (settings.homeFollowMutualPosts || settings.homeReplyMutualPosts) && location.pathname === "/home";
  const status = relationshipTask
    ? location.pathname.toLowerCase() === expectedRelationshipPath?.toLowerCase()
      ? `正在扫描 @${getCurrentUsername()} 的${settings.automationTask === "unfollowNonMutual" ? "正在关注" : "关注者"}列表`
      : `正在打开 @${getCurrentUsername()} 的${settings.automationTask === "unfollowNonMutual" ? "正在关注" : "关注者"}列表…`
    : settings.ownPostCommentReply && ownThread
      ? `正在扫描你发布的帖子评论，当前找到 ${ownCommentCount} 条他人评论`
      : null;
  sendResponse({
    controllerVersion: 10,
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
  settings.automationRunning = running;
  taskGeneration += 1;
  if (running) {
    stopAutoAdvance();
    actedPosts.clear();
    aiPostClassifications.clear();
    aiClassificationQueued.clear();
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

function startCurrentTask(generation) {
  if (settings.automationTask === "unfollowNonMutual" || settings.automationTask === "followBackFollowers") {
    startRelationshipTask(settings.automationTask, generation);
    return;
  }
  scan();
  if (isTaskFeedPage()) scheduleAutoAdvance(generation);
}

function scan() {
  if (settings.automationTask === "unfollowNonMutual" || settings.automationTask === "followBackFollowers") {
    scanRelationshipList(settings.automationTask, taskGeneration);
    return;
  }
  const posts = getPostContainers();
  if (settings.automationRunning && settings.automationTask === "engagement" && Date.now() - lastFeedStatusAt >= 10000) {
    const matches = posts.filter((post) => {
      const hits = matchedTerms(findPostText(post));
      const aiCategory = aiPostClassifications.get(getPostId(post));
      const aiMatch = aiCategory === "mutual" || aiCategory === "friendship";
      return (location.pathname === "/home" && (settings.homeFollowMutualPosts || settings.homeReplyMutualPosts) &&
        (hits.length > 0 || aiMatch)) ||
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
