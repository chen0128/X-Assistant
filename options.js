const defaults = {
  endpoint: "https://api.daitu.cc/v1/chat/completions",
  model: "gpt-6-sol",
  apiKey: "",
  replyMode: "ai",
  fixedReplyText: ""
};

function updateReplyMode() {
  document.getElementById("fixedReplySettings").hidden = document.getElementById("replyMode").value !== "fixed";
}

document.getElementById("replyMode").addEventListener("change", updateReplyMode);

async function load() {
  const values = await chrome.storage.local.get({ ...defaults, apiKey: "" });
  values.replyMode = values.replyMode === "fixed" ? "fixed" : "ai";
  for (const field of Object.keys(defaults)) {
    document.getElementById(field).value = values[field];
  }
  updateReplyMode();
}

document.getElementById("save").addEventListener("click", async () => {
  const values = Object.fromEntries(Object.keys(defaults).map((field) => [
    field,
    document.getElementById(field).value.trim()
  ]));
  if (values.replyMode === "fixed" && !values.fixedReplyText) {
    document.getElementById("status").textContent = "请输入固定回复内容";
    document.getElementById("fixedReplyText").focus();
    return;
  }
  if (!values.endpoint.startsWith("https://")) {
    document.getElementById("status").textContent = "API 地址必须使用 HTTPS";
    return;
  }
  try {
    const url = new URL(values.endpoint);
    const path = url.pathname.replace(/\/+$/, "");
    if (!path) url.pathname = "/v1/chat/completions";
    else if (path.endsWith("/v1")) url.pathname = `${path}/chat/completions`;
    values.endpoint = url.toString();
  } catch {
    document.getElementById("status").textContent = "请填写有效的 API 地址";
    return;
  }
  await chrome.storage.local.set({ ...values, apiEndpointRevision: "daitu-1" });
  document.getElementById("status").textContent = "已保存";
  setTimeout(() => { document.getElementById("status").textContent = ""; }, 2000);
});

load();
