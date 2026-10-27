const AUTOMATIC_REPLY_EDITOR_SELECTOR = '[contenteditable="true"][role="textbox"], [contenteditable="plaintext-only"][role="textbox"], [contenteditable="true"][data-testid^="tweetTextarea_"], [data-testid^="tweetTextarea_"] [contenteditable="true"], .DraftEditor-root [contenteditable="true"]';
let automaticReplyDraft = null;

function trackAutomaticReply(editor, scope, postId, author, text) {
  automaticReplyDraft = { editor, scope, postId, author, text };
}

async function backupAutomaticReply(editor, postId, author) {
  const text = getEditorText(editor);
  if (!text) return;
  const record = { postId, author, text, owner: getCurrentUsername(), savedAt: Date.now() };
  await chrome.storage.local.set({ lastFailedReplyDraft: record,
    [`failedReplyDraft:${record.owner}:${postId}`]: record });
  if (automaticReplyDraft?.postId === postId) automaticReplyDraft.text = text;
}

function visibleReplyRecoveryEditors() {
  return [...document.querySelectorAll(AUTOMATIC_REPLY_EDITOR_SELECTOR)].filter((editor) =>
    editor.isConnected && editor.isContentEditable && editor.getClientRects().length > 0);
}

async function prepareAutomaticReplyRecovery(stillRunning) {
  if (!stillRunning()) return false;
  const editors = visibleReplyRecoveryEditors();
  let draft = automaticReplyDraft;
  if (!draft?.editor?.isConnected) {
    const { lastFailedReplyDraft: saved } = await chrome.storage.local.get("lastFailedReplyDraft");
    if (!stillRunning()) return false;
    const matches = saved?.text && (!saved.owner || saved.owner === getCurrentUsername())
      ? editors.filter((editor) => getEditorText(editor) === normalizeReplyText(saved.text) &&
        editor.closest('[role="dialog"],[role="alertdialog"]')) : [];
    draft = matches.length === 1 ? { ...saved, editor: matches[0], scope: matches[0].closest('[role="dialog"],[role="alertdialog"]') } : null;
  }
  if (draft?.editor?.isConnected) {
    const editor = draft.editor;
    const text = getEditorText(editor);
    if (text) {
      if (normalizeReplyText(text) !== normalizeReplyText(draft.text)) {
        throw new Error("自动回复草稿已被修改，已暂缓刷新以保留内容");
      }
      await backupAutomaticReply(editor, draft.postId, draft.author);
      if (!stillRunning()) return false;
      editor.focus();
      if (document.activeElement !== editor) throw new Error("无法聚焦失败的回复草稿，稍后重试清理");
      const selection = window.getSelection();
      if (!selection) throw new Error("无法选中失败的回复草稿，稍后重试清理");
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      // Native deletion updates X's editor state; changing DOM alone leaves an unsaved draft.
      document.execCommand("delete", false, null);
      const cleared = await waitForElement(() => !stillRunning() ? { stopped: true } :
        editor.isConnected && !getEditorText(editor) ? true : null, 5000);
      if (!stillRunning() || cleared?.stopped) return false;
      if (!cleared) throw new Error("X 尚未清空失败草稿，已暂缓刷新，30 秒后重试");
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (!stillRunning()) return false;
    }
    if (draft.scope?.isConnected && draft.scope.matches('[role="dialog"],[role="alertdialog"]')) {
      closeEmptyReplyDialog(draft.scope, editor);
      const exited = await waitForElement(() => {
        if (!stillRunning()) return { stopped: true };
        // X may ask to discard its own draft even after the visible editor clears.
        for (const dialog of document.querySelectorAll('[role="dialog"],[role="alertdialog"]')) {
          if (!dialog.getClientRects().length || dialog === draft.scope) continue;
          if (!/草稿|保存帖子|save.*(?:draft|post)|discard.*draft/i.test(dialog.innerText || "")) continue;
          const discard = [...dialog.querySelectorAll('button,[role="button"]')].find((button) =>
            button.getClientRects().length && /^(?:放弃|丢弃|不保存|删除|discard|don't save)$/i.test(visibleControlText(button)));
          if (discard) { discard.click(); return null; }
        }
        if (!draft.scope.isConnected || !draft.scope.getClientRects().length) return true;
        return null;
      }, 5000);
      if (!stillRunning() || exited?.stopped) return false;
      if (!exited) throw new Error("回复弹窗尚未关闭，已暂缓刷新，30 秒后重试");
    }
    automaticReplyDraft = null;
  }
  if (visibleReplyRecoveryEditors().some((editor) => getEditorText(editor))) {
    throw new Error("页面仍有未发送草稿，已暂缓刷新以保留内容");
  }
  return stillRunning();
}
