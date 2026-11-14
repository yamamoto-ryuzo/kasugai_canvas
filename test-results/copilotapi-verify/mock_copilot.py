# Copilot API 互換モック: /models, /chat/completions, /responses
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = []

class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        LOG.append(("GET", self.path, self.headers.get("Authorization")))
        if self.path == "/models":
            self._json({"data": [
                {"id": "mock-chat", "capabilities": {"type": "chat",
                    "limits": {"max_context_window_tokens": 128000}},
                 "policy": {"state": "enabled"},
                 "supported_endpoints": ["/chat/completions", "/responses"]},
                {"id": "mock-resp", "capabilities": {"type": "chat"},
                 "supported_endpoints": ["/responses"]},
                {"id": "mock-disabled", "capabilities": {"type": "chat"},
                 "policy": {"state": "disabled"},
                 "supported_endpoints": ["/chat/completions"]},
                {"id": "mock-embed", "capabilities": {"type": "embeddings"},
                 "supported_endpoints": ["/embeddings"]},
            ]})
            return
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        req = json.loads(self.rfile.read(n) or b"{}")
        LOG.append(("POST", self.path, self.headers.get("Authorization"),
                    req.get("model"), len(req.get("messages") or req.get("input") or [])))
        if self.headers.get("Authorization") != "Bearer mock-token":
            self._json({"error": {"message": "unauthorized"}}, 401)
            return
        if self.path == "/chat/completions":
            has_tool_msg = any(m.get("role") == "tool" for m in req.get("messages", []))
            if has_tool_msg:
                self._json({"choices": [{"message": {"role": "assistant",
                    "content": "chat: tool result received"}}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5}})
            else:
                self._json({"choices": [{"message": {"role": "assistant",
                    "content": None,
                    "tool_calls": [{"id": "call_1", "type": "function",
                        "function": {"name": "listInstructions", "arguments": "{}"}}]}}],
                    "usage": {"prompt_tokens": 8, "completion_tokens": 4}})
            return
        if self.path == "/responses":
            has_fc_out = any(i.get("type") == "function_call_output" for i in req.get("input", []))
            if has_fc_out:
                self._json({"output": [{"type": "message", "role": "assistant",
                    "content": [{"type": "output_text",
                                 "text": "responses: tool result received"}]}],
                    "usage": {"input_tokens": 11, "output_tokens": 6}})
            else:
                self._json({"output": [{"type": "function_call",
                    "call_id": "call_r1", "name": "listInstructions",
                    "arguments": "{}"}],
                    "usage": {"input_tokens": 9, "output_tokens": 3}})
            return
        self._json({"error": {"message": "not found"}}, 404)

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8801
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
