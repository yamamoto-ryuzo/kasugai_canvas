import io, json

STRINGS = {
"ja": {
 "provider": "【ブリッジ】 ACP エージェント",
 "hint": "ACP（Agent Client Protocol）対応の任意のエージェント CLI をブリッジハブ経由で利用します（:8511 自動検出・空欄可）。ハブの環境変数 <code>KASUGAI_ACP_COMMAND</code> に起動コマンド（例: <code>my-agent acp</code>）を設定すると、ハブがそのプロセスを ACP で駆動します。対象 CLI の導入・認証設定が必要です — 手順と利用条件は bridge-hub/README.md。",
 "endpoint": "接続先: {endpoint}",
 "statusOk": "ブリッジ接続OK: {endpoint}（model: {model}）",
 "statusNg": "ブリッジに接続できません（{endpoint}）— アプリ版ならアプリの起動とハブの KASUGAI_ACP_COMMAND 設定・対象 CLI の導入を、ブラウザ WebGIS 利用時なら bridge-hub の起動（bridge-hub.exe）を確認してください",
 "modelLabel": "モデル",
 "modelHint": "ブリッジから取得した ACP エージェントのモデル一覧です。取得できない場合はブリッジの既定モデルが使われます。",
 "modelDefault": "（ブリッジ既定）",
 "noApiKey": "ACP ブリッジが未接続です。⚙管理 → AI → チャット でプロバイダを ACP エージェントにして保存すると自動設定されます（または同じ画面のブリッジ欄にエンドポイントを入力）。",
},
"en": {
 "provider": "[Bridge] ACP agent",
 "hint": "Use any ACP (Agent Client Protocol)-compatible agent CLI via the bridge hub (auto-detected at :8511, may be left blank). Set the hub's <code>KASUGAI_ACP_COMMAND</code> environment variable to the launch command (e.g. <code>my-agent acp</code>) and the hub drives that process over ACP. The target CLI must be installed and signed in — see bridge-hub/README.md.",
 "endpoint": "Endpoint: {endpoint}",
 "statusOk": "Bridge connected: {endpoint} (model: {model})",
 "statusNg": "Cannot reach the bridge ({endpoint}) — app version: check the app is running and the hub's KASUGAI_ACP_COMMAND and the target CLI are configured; browser WebGIS: start bridge-hub (bridge-hub.exe)",
 "modelLabel": "Model",
 "modelHint": "Available ACP agent models fetched from the bridge. If the list cannot be fetched, the bridge default is used.",
 "modelDefault": "(bridge default)",
 "noApiKey": "The ACP bridge is not connected. Select ACP agent as the AI provider in ⚙ Manage → AI and save to auto-configure, or enter the bridge endpoint shown there.",
},
"de": {
 "provider": "[Bridge] ACP-Agent",
 "hint": "Nutzt ein beliebiges ACP-kompatibles (Agent Client Protocol) Agent-CLI über den Bridge-Hub (automatisch erkannt auf :8511, Feld kann leer bleiben). Setzen Sie die Umgebungsvariable <code>KASUGAI_ACP_COMMAND</code> des Hubs auf den Startbefehl (z. B. <code>my-agent acp</code>); der Hub steuert den Prozess dann über ACP. Das Ziel-CLI muss installiert und angemeldet sein — siehe bridge-hub/README.md.",
 "endpoint": "Endpunkt: {endpoint}",
 "statusOk": "Bridge verbunden: {endpoint} (Modell: {model})",
 "statusNg": "Bridge unter {endpoint} nicht erreichbar — App-Version: App-Start sowie KASUGAI_ACP_COMMAND des Hubs und das eingerichtete Ziel-CLI prüfen; Browser-WebGIS: bridge-hub starten (bridge-hub.exe)",
 "modelLabel": "Modell",
 "modelHint": "Von der Bridge abgerufene ACP-Agent-Modelle. Wenn die Liste nicht abrufbar ist, wird das Bridge-Standardmodell verwendet.",
 "modelDefault": "(Bridge-Standard)",
 "noApiKey": "Die ACP-Bridge ist nicht verbunden. Wählen Sie ACP-Agent als KI-Anbieter unter ⚙ Verwalten → KI und speichern Sie zur automatischen Konfiguration (oder geben Sie dort den Bridge-Endpunkt ein).",
},
"es": {
 "provider": "[Puente] Agente ACP",
 "hint": "Utilice cualquier CLI de agente compatible con ACP (Agent Client Protocol) a través del hub de puentes (detectado automáticamente en :8511, puede quedar vacío). Defina la variable de entorno <code>KASUGAI_ACP_COMMAND</code> del hub con el comando de inicio (p. ej. <code>my-agent acp</code>) y el hub controlará ese proceso por ACP. El CLI de destino debe estar instalado y con sesión iniciada — vea bridge-hub/README.md.",
 "endpoint": "Endpoint: {endpoint}",
 "statusOk": "Puente conectado: {endpoint} (modelo: {model})",
 "statusNg": "No se puede alcanzar el puente en {endpoint} — versión de aplicación: compruebe que la app está en ejecución y que KASUGAI_ACP_COMMAND del hub y el CLI de destino están configurados; WebGIS del navegador: inicie bridge-hub (bridge-hub.exe)",
 "modelLabel": "Modelo",
 "modelHint": "Modelos del agente ACP obtenidos del puente. Si no se puede obtener la lista, se usa el modelo predeterminado del puente.",
 "modelDefault": "(predeterminado del puente)",
 "noApiKey": "El puente ACP no está conectado. Seleccione Agente ACP como proveedor de IA en ⚙ Administrar → IA y guarde para configurar automáticamente (o introduzca allí el endpoint del puente).",
},
"fr": {
 "provider": "[Pont] Agent ACP",
 "hint": "Utilisez n'importe quel CLI d'agent compatible ACP (Agent Client Protocol) via le hub de ponts (détecté automatiquement sur :8511, peut rester vide). Définissez la variable d'environnement <code>KASUGAI_ACP_COMMAND</code> du hub avec la commande de lancement (ex. <code>my-agent acp</code>) ; le hub pilote alors ce processus via ACP. Le CLI cible doit être installé et connecté — voir bridge-hub/README.md.",
 "endpoint": "Point de terminaison : {endpoint}",
 "statusOk": "Pont connecté : {endpoint} (modèle : {model})",
 "statusNg": "Pont injoignable à {endpoint} — version application : vérifiez que l'app tourne et que KASUGAI_ACP_COMMAND du hub ainsi que le CLI cible sont configurés ; autonome : démarrez bridge-hub (bridge-hub.exe)",
 "modelLabel": "Modèle",
 "modelHint": "Modèles de l'agent ACP récupérés auprès du pont. Si la liste est indisponible, le modèle par défaut du pont est utilisé.",
 "modelDefault": "(par défaut du pont)",
 "noApiKey": "Le pont ACP n'est pas connecté. Sélectionnez Agent ACP comme fournisseur d'IA dans ⚙ Gérer → IA et enregistrez pour configurer automatiquement (ou saisissez-y le point de terminaison du pont).",
},
"ko": {
 "provider": "[브리지] ACP 에이전트",
 "hint": "ACP(Agent Client Protocol) 대응 임의의 에이전트 CLI를 브리지 허브 경유로 이용합니다 (:8511 자동 감지·비워둘 수 있음). 허브의 환경변수 <code>KASUGAI_ACP_COMMAND</code>에 기동 명령(예: <code>my-agent acp</code>)을 지정하면 허브가 그 프로세스를 ACP로 구동합니다. 대상 CLI 설치·인증 설정이 필요합니다 — 자세한 내용은 bridge-hub/README.md.",
 "endpoint": "엔드포인트: {endpoint}",
 "statusOk": "브리지 연결됨: {endpoint} (모델: {model})",
 "statusNg": "{endpoint} 의 브리지에 연결할 수 없습니다 — 앱 버전: 앱 실행 여부와 허브의 KASUGAI_ACP_COMMAND 설정·대상 CLI 설치를 확인하세요. 독립 실행: bridge-hub를 시작하세요(bridge-hub.exe)",
 "modelLabel": "모델",
 "modelHint": "브리지에서 가져온 ACP 에이전트 모델 목록입니다. 가져올 수 없으면 브리지 기본 모델이 사용됩니다.",
 "modelDefault": "(브리지 기본값)",
 "noApiKey": "ACP 브리지가 연결되지 않았습니다. ⚙관리 → AI → 채팅에서 프로바이더를 ACP 에이전트로 선택하고 저장하면 자동 설정됩니다(또는 같은 화면의 브리지 항목에 엔드포인트 입력).",
},
"pt": {
 "provider": "[Ponte] Agente ACP",
 "hint": "Use qualquer CLI de agente compatível com ACP (Agent Client Protocol) via hub de pontes (detectado automaticamente em :8511, pode ficar em branco). Defina a variável de ambiente <code>KASUGAI_ACP_COMMAND</code> do hub com o comando de inicialização (ex.: <code>my-agent acp</code>) e o hub controla esse processo via ACP. O CLI de destino deve estar instalado e autenticado — veja bridge-hub/README.md.",
 "endpoint": "Endpoint: {endpoint}",
 "statusOk": "Ponte conectada: {endpoint} (modelo: {model})",
 "statusNg": "Não é possível alcançar a ponte em {endpoint} — versão do aplicativo: verifique se o app está em execução e se KASUGAI_ACP_COMMAND do hub e o CLI de destino estão configurados; autônomo: inicie o bridge-hub (bridge-hub.exe)",
 "modelLabel": "Modelo",
 "modelHint": "Modelos do agente ACP obtidos da ponte. Se a lista não puder ser obtida, o modelo padrão da ponte é usado.",
 "modelDefault": "(padrão da ponte)",
 "noApiKey": "A ponte ACP não está conectada. Selecione Agente ACP como provedor de IA em ⚙ Gerenciar → IA e salve para configurar automaticamente (ou insira aí o endpoint da ponte).",
},
"zh": {
 "provider": "【桥接】 ACP 代理",
 "hint": "通过桥接中心使用任意兼容 ACP（Agent Client Protocol）的代理 CLI（自动检测 :8511，可留空）。将集线器的环境变量 <code>KASUGAI_ACP_COMMAND</code> 设为启动命令（例如 <code>my-agent acp</code>），集线器便会通过 ACP 驱动该进程。需要安装并登录目标 CLI — 详见 bridge-hub/README.md。",
 "endpoint": "端点：{endpoint}",
 "statusOk": "桥接已连接：{endpoint}（模型：{model}）",
 "statusNg": "无法连接 {endpoint} 的桥接 — 应用版：请确认应用正在运行且集线器的 KASUGAI_ACP_COMMAND 与目标 CLI 已配置；独立运行：请启动 bridge-hub（bridge-hub.exe）",
 "modelLabel": "模型",
 "modelHint": "从桥接获取的 ACP 代理模型列表。无法获取时使用桥接默认模型。",
 "modelDefault": "（桥接默认）",
 "noApiKey": "ACP 桥接未连接。在 ⚙管理 → AI → 聊天 中选择 ACP 代理并保存即可自动配置（或在同一界面的桥接栏中输入端点）。",
},
}

for lang, s in STRINGS.items():
    path = f"web/shared/i18n/{lang}.json"
    text = io.open(path, encoding="utf-8", newline="").read()
    lines = text.splitlines(keepends=True)
    prov_anchor = next(i for i, l in enumerate(lines) if '"chat.provider.antigravity"' in l)
    key_anchor = next(i for i, l in enumerate(lines) if '"chat.noApiKeyAntigravity"' in l)
    prov_line = '  "chat.provider.acp": ' + json.dumps(s["provider"], ensure_ascii=False) + ",\n"
    block = [
        '  "chat.acp.hint": ' + json.dumps(s["hint"], ensure_ascii=False) + ",\n",
        '  "chat.acp.endpoint": ' + json.dumps(s["endpoint"], ensure_ascii=False) + ",\n",
        '  "chat.acp.statusOk": ' + json.dumps(s["statusOk"], ensure_ascii=False) + ",\n",
        '  "chat.acp.statusNg": ' + json.dumps(s["statusNg"], ensure_ascii=False) + ",\n",
        '  "chat.acp.modelLabel": ' + json.dumps(s["modelLabel"], ensure_ascii=False) + ",\n",
        '  "chat.acp.modelHint": ' + json.dumps(s["modelHint"], ensure_ascii=False) + ",\n",
        '  "chat.acp.modelDefault": ' + json.dumps(s["modelDefault"], ensure_ascii=False) + ",\n",
        '  "chat.noApiKeyAcp": ' + json.dumps(s["noApiKey"], ensure_ascii=False) + ",\n",
    ]
    lines.insert(key_anchor + 1, "".join(block))
    lines.insert(prov_anchor + 1, prov_line)
    io.open(path, "w", encoding="utf-8", newline="").write("".join(lines))
    json.load(io.open(path, encoding="utf-8"))
    print(lang, "ok")
