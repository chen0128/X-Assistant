const X_FOLLOW_RATE_LIMIT_PATTERN = "抱歉[，,]?你受到速度限制[。.]?请稍等片刻[，,]?然后再试一次[。.]?";
function hasXFollowRateLimit() {
  return [...document.querySelectorAll('[role="alert"],[role="status"],[data-testid*="toast"],[role="dialog"]')]
    .some((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden" &&
      new RegExp(X_FOLLOW_RATE_LIMIT_PATTERN).test((node.innerText || "").replace(/\s+/g, "")));
}
