import { showLoginForm } from "../../auth-login-form.js";

const EXPECTED_USER = "admin";
const EXPECTED_PASS = "admin";

export async function authenticate() {
  return showLoginForm({
    onSubmit: async ({ user, pass }) => {
      if (user !== EXPECTED_USER || pass !== EXPECTED_PASS) {
        throw new Error("認証に失敗しました");
      }
      try {
        localStorage.setItem("kasugaiLocalUser", user);
      } catch (e) {}
      return { token: "local", user: { name: user, role: "local" } };
    }
  });
}
