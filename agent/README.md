# TrueForge agent

`ourloss.json` is the inline TrueForge agent definition for the extension. The extension fills in the live MCP connector name, model reference and selected tools before creating a session. It preloads the tools used in every run and defers the optional workspace outline. `review_changes` requires native TrueForge approval.

Local TrueForge requires the loopback allowlist for the editor connector and Ollama model. Start the harness in a PowerShell window:

```powershell
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1","localhost"]'
npx.cmd @truefoundry/trueforge@0.185.1
```

In a second window, pull the example model and register its alias:

```powershell
ollama pull qwen3:4b-instruct-2507-q4_K_M
Invoke-RestMethod -Method Put -Uri http://127.0.0.1:8790/api/v1/settings/model-providers -ContentType application/json -InFile agent/model-provider.example.json
```

The example model alias is `tech-local-4b/qwen3-instruct`. Select a different configured alias in the extension when using a different model. Enter API credentials via TrueForge Settings for providers that need them. The editor connection uses a per-launch local credential generated in memory.

For the Task C failure demo, choose an unused port and register an unreachable model alias.

```powershell
$offline = @{ manifest = @{ type = 'custom'; name = 'forge-unavailable'; base_url = 'http://127.0.0.1:18797/v1'; models = @(@{ name = 'offline'; model_id = 'offline'; properties = @{ context_length = 4096; max_output_tokens = 1024 } }) } }
Invoke-RestMethod -Method Put -Uri http://127.0.0.1:8790/api/v1/settings/model-providers -ContentType application/json -Body ($offline | ConvertTo-Json -Depth 8)
```

For a larger local conversation window, start a separate Ollama process with `OLLAMA_CONTEXT_LENGTH=8192` and set the configured provider context length to the same value. Check the effective context using `ollama ps`. The Round 1 host driver accepts `OURLOSS_HOST_MODEL_PARAMS` as a JSON object for TrueForge parameters. For example, compatible Qwen endpoints can use `{"reasoning_effort":"none"}`.
