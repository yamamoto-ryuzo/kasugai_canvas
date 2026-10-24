import { initI18n, t } from "./i18n.js";

export async function showLoginForm({ onSubmit }) {
  await initI18n();
  return new Promise((resolve, reject) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(255,255,255,0.96);display:flex;align-items:center;justify-content:center;z-index:100000;font-family:sans-serif;";

    const box = document.createElement("div");
    box.style.cssText = "width:320px;padding:24px;border:1px solid #cbd9de;border-radius:8px;background:#fff;box-shadow:0 4px 20px rgba(0,0,0,0.1);";

    const title = document.createElement("h2");
    title.textContent = t("auth.loginTitle");
    title.style.cssText = "margin:0 0 16px;font-size:1.2em;color:#1d2b35;";

    const userLabel = document.createElement("label");
    userLabel.textContent = t("auth.userId");
    userLabel.style.cssText = "display:block;margin-bottom:4px;font-size:0.9em;color:#4a5a65;";

    const userInput = document.createElement("input");
    userInput.type = "text";
    userInput.autocomplete = "username";
    userInput.style.cssText = "width:100%;padding:8px;margin-bottom:12px;border:1px solid #cbd9de;border-radius:4px;box-sizing:border-box;";

    const passLabel = document.createElement("label");
    passLabel.textContent = t("auth.password");
    passLabel.style.cssText = "display:block;margin-bottom:4px;font-size:0.9em;color:#4a5a65;";

    const passInput = document.createElement("input");
    passInput.type = "password";
    passInput.autocomplete = "current-password";
    passInput.style.cssText = "width:100%;padding:8px;margin-bottom:16px;border:1px solid #cbd9de;border-radius:4px;box-sizing:border-box;";

    const error = document.createElement("div");
    error.style.cssText = "color:#a82020;font-size:0.85em;margin-bottom:12px;min-height:1.2em;";

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = t("auth.submit");
    submit.style.cssText = "width:100%;padding:10px;background:#1d6a96;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:0.95em;";

    const form = document.createElement("form");
    form.appendChild(title);
    form.appendChild(userLabel);
    form.appendChild(userInput);
    form.appendChild(passLabel);
    form.appendChild(passInput);
    form.appendChild(error);
    form.appendChild(submit);
    box.appendChild(form);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.textContent = "";
      const user = userInput.value.trim();
      const pass = passInput.value;
      if (!user || !pass) {
        error.textContent = t("auth.required");
        return;
      }
      submit.disabled = true;
      submit.textContent = t("auth.authenticating");
      try {
        const result = await onSubmit({ user, pass });
        document.body.removeChild(overlay);
        resolve(result);
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : t("auth.failed");
        submit.disabled = false;
        submit.textContent = t("auth.submit");
      }
    });
  });
}
