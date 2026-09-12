import { onRequestPost as __api_auth_js_onRequestPost } from "C:\\devin\\kasugai_canvas\\functions\\api\\auth.js"

export const routes = [
    {
      routePath: "/api/auth",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_auth_js_onRequestPost],
    },
  ]