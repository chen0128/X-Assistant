const defaults = {
  endpoint: "https://heidawang.top/v1/chat/completions",
  model: "gpt-6-sol",
  apiKey: ""
};

async function load() {
  const values = await chrome.storage.local.get({ ...defaults, apiKey: "" });
  if (values.endpoint === "https://api.openai.com/v1/chat/completions") {
    values.endpoint = defaults.endpoint;
  }
  for (const field of ["endpoint", "model", "apiKey"]) {
    document.getElementById(field).value = values[field];
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const values = Object.fromEntries(["endpoint", "model", "apiKey"].map((field) => [
    field,
    document.getElementById(field).value.trim()
  ]));
  if (!values.endpoint.startsWith("https://")) {
    document.getElementById("status").textContent = "API 地址必须使用 HTTPS";
    return;
  }
  await chrome.storage.local.set(values);
  document.getElementById("status").textContent = "已保存";
  setTimeout(() => { document.getElementById("status").textContent = ""; }, 2000);
});

load();
