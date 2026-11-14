# -*- coding: utf-8 -*-
# copilotapi の GitHub サインイン（OAuth デバイスフロー）用 i18n キーを追加し、
# PAT 前提の既存キー(hint/tokenPlaceholder/noToken)を OAuth 前提へ更新する
import io, json, os, collections

BASE = r"C:\devin\kasugai_canvas\web\shared\i18n"

T = {
  "ja": {
    "chat.copilotapi.hint": "GitHub Copilot を CLI・ブリッジなしで直接利用します。GitHub の OAuth トークンを <code>copilot_internal</code> で短期トークンへ交換して api.githubcopilot.com（OpenAI互換）を呼びます。<strong>GitHub Copilot 契約が必要です</strong>。PAT はこのエンドポイントで拒否されるため、下のボタンで GitHub にサインイン（OAuth デバイスフロー）してください。",
    "chat.copilotapi.tokenPlaceholder": "OAuth トークン（サインインで自動入力）",
    "chat.copilotapi.noToken": "GitHub トークンが未設定です。⚙管理 → AI → チャット でプロバイダを GitHub Copilot【API】にして GitHub でサインインしてください。",
    "chat.copilotapi.signin": "GitHubでサインイン",
    "chat.copilotapi.signinPrompt": "<a href=\"{url}\" target=\"_blank\" rel=\"noopener\">{url}</a> を開いてコード <strong>{code}</strong> を入力してください（承認されるまで待機します…）",
    "chat.copilotapi.signinOk": "サインインしました。GitHub トークンを保存しました。",
    "chat.copilotapi.signinFailed": "GitHub サインインに失敗しました: {error}",
    "chat.copilotapi.signinExpired": "コードの有効期限が切れました。もう一度サインインしてください。",
    "chat.copilotapi.signinProxyFailed": "サインイン中継に失敗しました（/api/mcp プロキシが必要です。ローカルサーバ版で利用してください）: {error}",
  },
  "en": {
    "chat.copilotapi.hint": "Use GitHub Copilot directly without a CLI or bridge. A GitHub OAuth token is exchanged for a short-lived token via <code>copilot_internal</code> to call api.githubcopilot.com (OpenAI-compatible). <strong>A GitHub Copilot subscription is required</strong>. PATs are rejected by this endpoint — sign in with GitHub below (OAuth device flow).",
    "chat.copilotapi.tokenPlaceholder": "OAuth token (auto-filled by sign-in)",
    "chat.copilotapi.noToken": "No GitHub token is set. In ⚙ Manage → AI → Chat, choose the GitHub Copilot [API] provider and sign in with GitHub.",
    "chat.copilotapi.signin": "Sign in with GitHub",
    "chat.copilotapi.signinPrompt": "Open <a href=\"{url}\" target=\"_blank\" rel=\"noopener\">{url}</a> and enter code <strong>{code}</strong> (waiting for approval…)",
    "chat.copilotapi.signinOk": "Signed in. GitHub token saved.",
    "chat.copilotapi.signinFailed": "GitHub sign-in failed: {error}",
    "chat.copilotapi.signinExpired": "The code expired. Please sign in again.",
    "chat.copilotapi.signinProxyFailed": "Sign-in relay failed (requires the /api/mcp proxy — use the local server build): {error}",
  },
  "de": {
    "chat.copilotapi.hint": "GitHub Copilot direkt ohne CLI oder Bridge verwenden. Ein GitHub-OAuth-Token wird über <code>copilot_internal</code> in ein Kurzzeit-Token getauscht, um api.githubcopilot.com (OpenAI-kompatibel) aufzurufen. <strong>Ein GitHub-Copilot-Abonnement ist erforderlich</strong>. PATs werden von diesem Endpunkt abgelehnt — melden Sie sich unten mit GitHub an (OAuth Device Flow).",
    "chat.copilotapi.tokenPlaceholder": "OAuth-Token (wird bei Anmeldung eingefügt)",
    "chat.copilotapi.noToken": "Kein GitHub-Token gesetzt. Wählen Sie unter ⚙ Verwaltung → KI → Chat den Anbieter GitHub Copilot [API] und melden Sie sich mit GitHub an.",
    "chat.copilotapi.signin": "Mit GitHub anmelden",
    "chat.copilotapi.signinPrompt": "Öffnen Sie <a href=\"{url}\" target=\"_blank\" rel=\"noopener\">{url}</a> und geben Sie den Code <strong>{code}</strong> ein (warte auf Bestätigung…)",
    "chat.copilotapi.signinOk": "Angemeldet. GitHub-Token wurde gespeichert.",
    "chat.copilotapi.signinFailed": "GitHub-Anmeldung fehlgeschlagen: {error}",
    "chat.copilotapi.signinExpired": "Der Code ist abgelaufen. Bitte erneut anmelden.",
    "chat.copilotapi.signinProxyFailed": "Anmelde-Weiterleitung fehlgeschlagen (/api/mcp-Proxy erforderlich — lokale Server-Version verwenden): {error}",
  },
  "es": {
    "chat.copilotapi.hint": "Use GitHub Copilot directamente sin CLI ni bridge. Un token OAuth de GitHub se intercambia por un token de corta duración mediante <code>copilot_internal</code> para llamar a api.githubcopilot.com (compatible con OpenAI). <strong>Se requiere suscripción a GitHub Copilot</strong>. Los PAT son rechazados por este endpoint — inicie sesión con GitHub abajo (flujo de dispositivo OAuth).",
    "chat.copilotapi.tokenPlaceholder": "Token OAuth (se rellena al iniciar sesión)",
    "chat.copilotapi.noToken": "No hay token de GitHub. En ⚙ Administrar → IA → Chat elija el proveedor GitHub Copilot [API] e inicie sesión con GitHub.",
    "chat.copilotapi.signin": "Iniciar sesión con GitHub",
    "chat.copilotapi.signinPrompt": "Abra <a href=\"{url}\" target=\"_blank\" rel=\"noopener\">{url}</a> e introduzca el código <strong>{code}</strong> (esperando aprobación…)",
    "chat.copilotapi.signinOk": "Sesión iniciada. Token de GitHub guardado.",
    "chat.copilotapi.signinFailed": "Error al iniciar sesión con GitHub: {error}",
    "chat.copilotapi.signinExpired": "El código caducó. Inicie sesión de nuevo.",
    "chat.copilotapi.signinProxyFailed": "Falló la retransmisión de inicio de sesión (se requiere el proxy /api/mcp — use la versión de servidor local): {error}",
  },
  "fr": {
    "chat.copilotapi.hint": "Utilisez GitHub Copilot directement sans CLI ni bridge. Un jeton OAuth GitHub est échangé contre un jeton de courte durée via <code>copilot_internal</code> pour appeler api.githubcopilot.com (compatible OpenAI). <strong>Un abonnement GitHub Copilot est requis</strong>. Les PAT sont rejetés par ce endpoint — connectez-vous avec GitHub ci-dessous (flux d'appareil OAuth).",
    "chat.copilotapi.tokenPlaceholder": "Jeton OAuth (rempli lors de la connexion)",
    "chat.copilotapi.noToken": "Aucun jeton GitHub défini. Dans ⚙ Gérer → IA → Chat, choisissez le fournisseur GitHub Copilot [API] et connectez-vous avec GitHub.",
    "chat.copilotapi.signin": "Se connecter avec GitHub",
    "chat.copilotapi.signinPrompt": "Ouvrez <a href=\"{url}\" target=\"_blank\" rel=\"noopener\">{url}</a> et saisissez le code <strong>{code}</strong> (en attente d'approbation…)",
    "chat.copilotapi.signinOk": "Connecté. Jeton GitHub enregistré.",
    "chat.copilotapi.signinFailed": "Échec de la connexion GitHub : {error}",
    "chat.copilotapi.signinExpired": "Le code a expiré. Veuillez vous reconnecter.",
    "chat.copilotapi.signinProxyFailed": "Échec du relais de connexion (le proxy /api/mcp est requis — utilisez la version serveur locale) : {error}",
  },
  "ko": {
    "chat.copilotapi.hint": "CLI나 브리지 없이 GitHub Copilot을 직접 사용합니다. GitHub OAuth 토큰을 <code>copilot_internal</code>로 단기 토큰과 교환하여 api.githubcopilot.com(OpenAI 호환)을 호출합니다. <strong>GitHub Copilot 구독이 필요합니다</strong>. PAT는 이 엔드포인트에서 거부되므로 아래 버튼으로 GitHub에 로그인(OAuth 디바이스 플로)하세요.",
    "chat.copilotapi.tokenPlaceholder": "OAuth 토큰(로그인 시 자동 입력)",
    "chat.copilotapi.noToken": "GitHub 토큰이 설정되지 않았습니다. ⚙관리 → AI → 채팅에서 공급자를 GitHub Copilot [API]로 하고 GitHub에 로그인하세요.",
    "chat.copilotapi.signin": "GitHub로 로그인",
    "chat.copilotapi.signinPrompt": "<a href=\"{url}\" target=\"_blank\" rel=\"noopener\">{url}</a>을(를) 열고 코드 <strong>{code}</strong>를 입력하세요(승인 대기 중…)",
    "chat.copilotapi.signinOk": "로그인했습니다. GitHub 토큰을 저장했습니다.",
    "chat.copilotapi.signinFailed": "GitHub 로그인 실패: {error}",
    "chat.copilotapi.signinExpired": "코드가 만료되었습니다. 다시 로그인하세요.",
    "chat.copilotapi.signinProxyFailed": "로그인 중계 실패(/api/mcp 프록시 필요 — 로컬 서버 버전 사용): {error}",
  },
  "pt": {
    "chat.copilotapi.hint": "Use o GitHub Copilot diretamente, sem CLI nem bridge. Um token OAuth do GitHub é trocado por um token de curta duração via <code>copilot_internal</code> para chamar api.githubcopilot.com (compatível com OpenAI). <strong>É necessária uma assinatura do GitHub Copilot</strong>. PATs são rejeitados por este endpoint — entre com o GitHub abaixo (fluxo de dispositivo OAuth).",
    "chat.copilotapi.tokenPlaceholder": "Token OAuth (preenchido ao entrar)",
    "chat.copilotapi.noToken": "Nenhum token do GitHub definido. Em ⚙ Gerenciar → IA → Chat, escolha o provedor GitHub Copilot [API] e entre com o GitHub.",
    "chat.copilotapi.signin": "Entrar com GitHub",
    "chat.copilotapi.signinPrompt": "Abra <a href=\"{url}\" target=\"_blank\" rel=\"noopener\">{url}</a> e digite o código <strong>{code}</strong> (aguardando aprovação…)",
    "chat.copilotapi.signinOk": "Conectado. Token do GitHub salvo.",
    "chat.copilotapi.signinFailed": "Falha ao entrar com GitHub: {error}",
    "chat.copilotapi.signinExpired": "O código expirou. Entre novamente.",
    "chat.copilotapi.signinProxyFailed": "Falha no relay de login (requer o proxy /api/mcp — use a versão de servidor local): {error}",
  },
  "zh": {
    "chat.copilotapi.hint": "无需 CLI 或桥接即可直接使用 GitHub Copilot。GitHub OAuth 令牌通过 <code>copilot_internal</code> 兑换为短期令牌，以调用 api.githubcopilot.com（OpenAI 兼容）。<strong>需要 GitHub Copilot 订阅</strong>。此端点不接受 PAT —— 请使用下方按钮登录 GitHub（OAuth 设备流）。",
    "chat.copilotapi.tokenPlaceholder": "OAuth 令牌（登录时自动填写）",
    "chat.copilotapi.noToken": "未设置 GitHub 令牌。请在 ⚙管理 → AI → 聊天 中选择 GitHub Copilot [API] 提供程序并使用 GitHub 登录。",
    "chat.copilotapi.signin": "使用 GitHub 登录",
    "chat.copilotapi.signinPrompt": "打开 <a href=\"{url}\" target=\"_blank\" rel=\"noopener\">{url}</a> 并输入代码 <strong>{code}</strong>（等待批准…）",
    "chat.copilotapi.signinOk": "已登录。GitHub 令牌已保存。",
    "chat.copilotapi.signinFailed": "GitHub 登录失败：{error}",
    "chat.copilotapi.signinExpired": "代码已过期。请重新登录。",
    "chat.copilotapi.signinProxyFailed": "登录中继失败（需要 /api/mcp 代理 — 请使用本地服务器版本）：{error}",
  },
}

for lang, keys in T.items():
    p = os.path.join(BASE, f"{lang}.json")
    with io.open(p, encoding="utf-8") as f:
        d = json.load(f, object_pairs_hook=collections.OrderedDict)
    for k, v in keys.items():
        d[k] = v
    with io.open(p, "w", encoding="utf-8", newline="\n") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(lang, "updated", len(keys), "keys")
