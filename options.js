const defaults = {
  endpoint: "https://heidawang.top/v1/chat/completions",
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
  if (values.endpoint === "https://api.openai.com/v1/chat/completions") {
    values.endpoint = defaults.endpoint;
  }
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
  await chrome.storage.local.set(values);
  document.getElementById("status").textContent = "已保存";
  setTimeout(() => { document.getElementById("status").textContent = ""; }, 2000);
});

load();
