import { showLoginForm } from "../../auth-login-form.js";
import { t } from "../../i18n.js";

const EXPECTED_USER = "admin";
const EXPECTED_PASS = "admin";

export async function authenticate() {
  return showLoginForm({
    onSubmit: async ({ user, pass }) => {
      if (user !== EXPECTED_USER || pass !== EXPECTED_PASS) {
        throw new Error(t("auth.failed"));
      }
      try {
        localStorage.setItem("kasugaiLocalUser", user);
      } catch (e) {}
      return { token: "local", user: { name: user, role: "local" } };
    }
  });
}
