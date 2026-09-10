export async function authenticate() {
  let name = "guest";
  try {
    const saved = localStorage.getItem("kasugaiLocalUser");
    if (saved) name = saved;
  } catch (e) {}

  // 実際の認証は行わず、ローカル利用者として扱う
  return {
    token: "local",
    user: { name, role: "local" },
  };
}
