# Proxy CommandCode

A transparent reverse proxy that translates **OpenAI-compatible** requests (`/v1/chat/completions`) into CommandCode's internal endpoint (`/alpha/generate`), then returns responses in OpenAI format your editor understands.

Use any CommandCode model (including the Go plan) with **ZCode**, **9router**, **Cursor**, **Continue**, **Aider**, and any editor that supports custom OpenAI endpoints.

## Why

CommandCode has two API surfaces:

| Endpoint | Plan required |
|---|---|
| `/provider/v1/chat/completions` | Pro |
| `/provider/v1/messages` | Pro |
| `/alpha/generate` | **Any plan** (Go included) |

This proxy speaks the same envelope the official CLI uses, so it works on any plan.

## How it works

```
Editor → POST /v1/chat/completions (OpenAI format)
  → Proxy translates to CommandCode format
    → POST api.commandcode.ai/alpha/generate
  ← Proxy translates NDJSON stream back to OpenAI SSE/JSON
← Editor receives standard OpenAI response
```

## Quick start

```bash
git clone https://github.com/nasrulhadi/proxy-commandcode.git
cd proxy-commandcode
node server.js
# → listening on http://localhost:3456
```

Zero dependencies. Node.js 18+ only.

### Get your token

1. Go to [https://commandcode.ai/settings/billing](https://commandcode.ai/settings/billing)
2. Copy your `user_...` token
3. Use it as the API key in your editor

### Env vars

| Variable | Default |
|---|---|
| `PCMC_PORT` | `3456` |
| `PCMC_VERSION` | `0.41.1` |
| `PCMC_DEBUG` | off (set `1` to dump raw upstream responses to `dump/`) |

## Integration

### 9router

```json
{
  "commandcode": {
    "base_url": "http://localhost:3456/v1",
    "api_key": "user_xxxxxxxxxx",
    "models": ["deepseek/deepseek-v4-pro", "moonshotai/Kimi-K2.5"]
  }
}
```

### ZCode

Set custom OpenAI endpoint in settings:

- **Base URL**: `http://localhost:3456/v1`
- **API Key**: your `user_...` token
- **Model**: `deepseek/deepseek-v4-pro`

### Cursor

Settings → OpenAI API Key → Override Base URL: `http://localhost:3456/v1`

### Continue (VS Code)

```json
{
  "models": [{
    "title": "DeepSeek V4 Pro",
    "provider": "openai",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "user_xxxxxxxxxx",
    "model": "deepseek/deepseek-v4-pro"
  }]
}
```

### Aider

```bash
aider --openai-api-base http://localhost:3456/v1 \
      --openai-api-key user_xxxxxxxxxx \
      --model openai/deepseek/deepseek-v4-pro
```

### Other editors

Any editor with custom OpenAI endpoint support works the same way: point base URL to `http://localhost:3456/v1`, use your token as API key.

## Available models

Open-weight models accessible on any plan (including Go). Use the exact slug as the model field.

| Model | Notes |
|---|---|
| `tencent/Hy3` | Free until 2026-07-21 |
| `deepseek/deepseek-v4-pro` | |
| `deepseek/deepseek-v4-flash` | |
| `moonshotai/Kimi-K2.5` | |
| `moonshotai/Kimi-K2.6` | |
| `moonshotai/Kimi-K2.7` | |
| `Qwen/Qwen3.7-Max` | |
| `Qwen/Qwen3.7-Plus` | |
| `Qwen/Qwen3.6-Max-Preview` | |
| `GLM/GLM-5.2` | |
| `GLM/GLM-5.1` | |
| `GLM/GLM-5` | |
| `MiniMax/MiniMax-M3` | |
| `MiniMax/MiniMax-M2.7` | |
| `MiniMax/MiniMax-M2.5` | |
| `MiMo/MiMo-V2.5-Pro` | |
| `MiMo/MiMo-V2.5` | |
| `stepfun/Step-3.7` | |
| `stepfun/Step-3.5-Flash` | |
| `nvidia/Nemotron-3-Ultra` |

> Slugs are case-sensitive (e.g. `tencent/Hy3`, not `tencent/HY3`). Model list may change — check `GET /provider/v1/models` for the current roster.

## Logs

All requests logged to `proxy.log`:

```
[req] deepseek/deepseek-v4-pro stream=true
[upstream] 200
[done] text=1052 reasoning=38 tools=2 reason=tool_calls
```

- `text` + `reasoning` = total characters in response
- `tools` = number of tool calls the model made
- `reason` = `stop` (finished) or `tool_calls` (waiting for tool results)

### Common errors

| Log | Fix |
|---|---|
| `[upstream] 401` | Token invalid. Get a fresh one from billing. |
| `[upstream] 400` | Request format mismatch. Check proxy version. |
| `[upstream] timeout` | Upstream took >5 min. Retry. |
| `EADDRINUSE` | Proxy auto-kills the old process on start. |

## Disclaimer

This project is for educational and research purposes only. It uses CommandCode's internal `/alpha/generate` endpoint, which is undocumented and may change or be restricted at any time. Use at your own risk and in accordance with CommandCode's Terms of Service.

## License

MIT

