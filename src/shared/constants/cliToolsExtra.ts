// Additional CLI tool registry entries — kept out of cliTools.ts so that the
// registry file stays under its file-size cap (config/quality/file-size-baseline.json),
// following the same split already used by cliToolsGrokBuild.ts.
//
// Every entry below was verified against the tool's official documentation or its
// source before being added. The verification source is recorded in the doc comment
// above each entry: if a tool's real mechanism could not be read from an official
// page or from its code, it is NOT here — see the PR that introduced this file for
// the list of tools that were checked and rejected.
import type { CliCatalogEntry } from "@/shared/schemas/cliCatalog";

export const EXTRA_CLI_TOOLS: Record<string, CliCatalogEntry> = {
  // ── Code entries ──────────────────────────────────────────────────────────

  /**
   * AIChat (sigoden) — Rust all-in-one LLM CLI.
   * Verified: wiki "Configuration Guide" documents `clients:` entries of
   * `type: openai-compatible` with `api_base` / `api_key` / `models`, the
   * per-OS config.yaml paths, and the `<client>:<model>` model reference
   * ("model: openai:gpt-4o").
   */
  aichat: {
    id: "aichat",
    name: "AIChat",
    icon: "terminal",
    color: "#22C55E",
    description: "AIChat — all-in-one LLM CLI; openai-compatible client with api_base",
    docsUrl: "https://github.com/sigoden/aichat/wiki/Configuration-Guide",
    configType: "guide",
    category: "code",
    vendor: "OSS (sigoden)",
    acpSpawnable: false,
    baseUrlSupport: "full",
    defaultCommand: "aichat",
    guideSteps: [
      { step: 1, title: "Install AIChat", desc: "cargo install aichat (or brew install aichat)" },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "Select Model", type: "modelSelector" },
      {
        step: 5,
        title: "Add the client",
        desc: "Append the block below to config.yaml, then run: aichat -m omniroute:{{model}}",
      },
    ],
    notes: [
      {
        type: "info",
        text: "config.yaml path — Linux ~/.config/aichat/config.yaml • macOS ~/Library/Application Support/aichat/config.yaml • Windows %APPDATA%\\aichat\\config.yaml",
      },
    ],
    codeBlock: {
      language: "yaml",
      code: `clients:
  - type: openai-compatible
    name: omniroute
    api_base: {{baseUrl}}
    api_key: {{apiKey}}
    models:
      - name: {{model}}`,
    },
  },

  /**
   * ShellGPT (TheR1D) — `sgpt`.
   * Verified: README documents the runtime config file ~/.config/shell_gpt/.sgptrc
   * with `API_BASE_URL` and `DEFAULT_MODEL`; sgpt/config.py builds DEFAULT_CONFIG
   * from os.getenv(...) and Config.get() does `os.getenv(key) or super().get(key)`
   * ("Prioritize environment variables over config file"), so the exports below
   * override the file.
   */
  "shell-gpt": {
    id: "shell-gpt",
    name: "ShellGPT",
    icon: "terminal",
    color: "#6B7280",
    description: "ShellGPT (sgpt) — command-line productivity CLI; API_BASE_URL targets OmniRoute",
    docsUrl: "https://github.com/TheR1D/shell_gpt",
    configType: "guide",
    category: "code",
    vendor: "OSS (TheR1D)",
    acpSpawnable: false,
    baseUrlSupport: "full",
    defaultCommand: "sgpt",
    guideSteps: [
      { step: 1, title: "Install ShellGPT", desc: "pip install shell-gpt" },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "Select Model", type: "modelSelector" },
    ],
    notes: [
      {
        type: "info",
        text: "The same three names are also keys in ~/.config/shell_gpt/.sgptrc. ShellGPT reads the environment first, so these exports win over whatever the file already holds.",
      },
    ],
    codeBlock: {
      language: "bash",
      code: `export OPENAI_API_KEY="{{apiKey}}"
export API_BASE_URL="{{baseUrl}}"
export DEFAULT_MODEL="{{model}}"
sgpt "summarise what this repo does"`,
    },
  },

  /**
   * Mods (Charm) — AI for the command line.
   * Verified: README states "Mods works with OpenAI compatible endpoints" and that
   * extra endpoints are configured via `mods --settings`; config_template.yml shows
   * the `default-api:` key and the `apis:` block with `base-url` / `api-key` /
   * `api-key-env` / `models` / `max-input-chars`; config.go resolves the path with
   * `xdg.ConfigFile(filepath.Join("mods", "mods.yml"))`. `-m, --model` is a
   * documented flag.
   */
  mods: {
    id: "mods",
    name: "Mods",
    icon: "terminal",
    color: "#FF5F87",
    description: "Mods — Charm's AI for the command line; custom api entry in mods.yml",
    docsUrl: "https://github.com/charmbracelet/mods",
    configType: "guide",
    category: "code",
    vendor: "OSS (Charm)",
    acpSpawnable: false,
    baseUrlSupport: "full",
    defaultCommand: "mods",
    guideSteps: [
      { step: 1, title: "Install Mods", desc: "brew install charmbracelet/tap/mods" },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "Select Model", type: "modelSelector" },
      {
        step: 5,
        title: "Edit mods.yml",
        desc: "Run `mods --settings` to open it, paste the block below, then: mods -m {{model}} 'explain this diff'",
      },
    ],
    notes: [
      {
        type: "info",
        text: "mods.yml lives at the XDG config path (Linux ~/.config/mods/mods.yml). `mods --settings` opens the right file on every OS.",
      },
    ],
    codeBlock: {
      language: "yaml",
      code: `default-api: omniroute
apis:
  omniroute:
    base-url: {{baseUrl}}
    api-key: {{apiKey}}
    models:
      {{model}}:
        max-input-chars: 392000`,
    },
  },

  /**
   * llm (Simon Willison / Datasette).
   * Verified: "Other models" documents extra-openai-models.yaml with `model_id`,
   * `model_name`, `api_base` and `api_key_name` ("If the api_base is set, the
   * existing configured openai API key will not be sent by default" — hence the
   * named key); "OpenAI models" documents `dirname "$(llm logs path)"` as the way
   * to locate the directory and `llm keys set <name>` to store a key.
   */
  llm: {
    id: "llm",
    name: "LLM (Datasette)",
    icon: "terminal",
    color: "#0369A1",
    description: "Simon Willison's llm CLI — extra-openai-models.yaml adds an api_base model",
    docsUrl: "https://llm.datasette.io/en/stable/other-models.html",
    configType: "guide",
    category: "code",
    vendor: "OSS (S. Willison)",
    acpSpawnable: false,
    baseUrlSupport: "full",
    defaultCommand: "llm",
    guideSteps: [
      { step: 1, title: "Install llm", desc: "pip install llm (or brew install llm)" },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "Select Model", type: "modelSelector" },
      {
        step: 5,
        title: "Register the model",
        desc: "Run the block below — it stores the key under the name `omniroute` and appends the model to extra-openai-models.yaml.",
      },
    ],
    notes: [
      {
        type: "info",
        text: "api_key_name must point at a key saved with `llm keys set`: once api_base is set, llm stops sending the default openai key.",
      },
    ],
    codeBlock: {
      language: "bash",
      code: `llm keys set omniroute   # paste {{apiKey}} when prompted
cat >> "$(dirname "$(llm logs path)")/extra-openai-models.yaml" <<'YAML'
- model_id: omniroute-{{model}}
  model_name: {{model}}
  api_base: {{baseUrl}}
  api_key_name: omniroute
YAML
llm -m omniroute-{{model}} "summarise what this repo does"`,
    },
  },

  /**
   * Fabric (Daniel Miessler) — prompt/pattern CLI.
   * Verified: README documents `fabric --setup`, the ~/.config/fabric/.env settings
   * file and the `-m, --model=` flag. The OpenAI vendor plugin registers
   * AddSetupQuestion("API Key") and AddSetupQuestion("API Base URL") under the
   * vendor name "OpenAI", and plugin.go's BuildEnvVariable upper-cases the name and
   * replaces spaces/hyphens with underscores — so the settings are read from
   * OPENAI_API_KEY and OPENAI_API_BASE_URL.
   */
  fabric: {
    id: "fabric",
    name: "Fabric",
    icon: "terminal",
    color: "#1F2937",
    description: "Fabric — pattern/prompt CLI; OPENAI_API_BASE_URL points its OpenAI vendor here",
    docsUrl: "https://github.com/danielmiessler/Fabric",
    configType: "guide",
    category: "code",
    vendor: "OSS (D. Miessler)",
    acpSpawnable: false,
    baseUrlSupport: "full",
    defaultCommand: "fabric",
    guideSteps: [
      {
        step: 1,
        title: "Install Fabric",
        desc: "go install github.com/danielmiessler/fabric@latest",
      },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "Select Model", type: "modelSelector" },
      {
        step: 5,
        title: "Configure the OpenAI vendor",
        desc: "Run `fabric --setup`, choose OpenAI and paste both values — or write ~/.config/fabric/.env directly, as below.",
      },
    ],
    codeBlock: {
      language: "bash",
      code: `# ~/.config/fabric/.env
OPENAI_API_KEY={{apiKey}}
OPENAI_API_BASE_URL={{baseUrl}}

# then, per run:
#   fabric -m {{model}} -p summarize < notes.md`,
    },
  },

  // ── Agent entries ─────────────────────────────────────────────────────────

  /**
   * OpenHands (formerly OpenDevin) — autonomous software-engineering agent.
   * Verified: "OpenAI-compatible endpoints" documents routing through LiteLLM by
   * enabling Advanced options and setting `Custom Model` to `openai/<model-name>`
   * plus a `Base URL` and `API Key`. Configured through the settings UI (the CLI
   * exposes the same panel with Ctrl+P → Settings); no documented base-URL
   * environment variable, so none is claimed here.
   */
  openhands: {
    id: "openhands",
    name: "OpenHands",
    icon: "smart_toy",
    color: "#EAB308",
    description:
      "OpenHands — autonomous SWE agent; Advanced settings take openai/<model> + Base URL",
    docsUrl: "https://docs.openhands.dev/usage/llms/openai-llms",
    configType: "guide",
    category: "agent",
    vendor: "OpenHands (OSS)",
    acpSpawnable: false,
    baseUrlSupport: "full",
    defaultCommand: "openhands",
    guideSteps: [
      {
        step: 1,
        title: "Install OpenHands",
        desc: "pip install openhands-ai, then run: openhands",
      },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "Select Model", type: "modelSelector" },
      {
        step: 5,
        title: "Fill in Settings → LLM",
        desc: "Enable Advanced options, set Custom Model to openai/{{model}}, paste the Base URL and API Key above.",
      },
    ],
    notes: [
      {
        type: "warning",
        text: "The openai/ prefix is required — OpenHands routes through LiteLLM, which picks the transport from that prefix. Without it the Base URL is ignored.",
      },
    ],
  },

  /**
   * Plandex — long-horizon coding agent.
   * Verified: docs/docs/models/custom-models.md documents `plandex models custom`
   * and the providers/models JSON below (`name`, `baseUrl`, `apiKeyEnvVar`,
   * `skipAuth`; `modelId`, `publisher`, `providers[].provider = "custom"`,
   * `customProvider`, `modelName`), and states that all custom providers must be
   * OpenAI-compatible and that custom providers are only fully supported when
   * self-hosting — Cloud with BYO keys restricts models to built-in providers.
   * Hence baseUrlSupport "partial".
   */
  plandex: {
    id: "plandex",
    name: "Plandex",
    icon: "smart_toy",
    color: "#14B8A6",
    description:
      "Plandex — long-horizon coding agent; custom OpenAI-compatible provider (self-hosted)",
    docsUrl: "https://docs.plandex.ai/models/custom-models",
    configType: "guide",
    category: "agent",
    vendor: "Plandex (OSS)",
    acpSpawnable: false,
    baseUrlSupport: "partial",
    defaultCommand: "plandex",
    guideSteps: [
      {
        step: 1,
        title: "Install Plandex",
        desc: "See docs.plandex.ai — custom providers need self-hosted mode",
      },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "Select Model", type: "modelSelector" },
      {
        step: 5,
        title: "Register the provider",
        desc: "export OMNIROUTE_API_KEY=<your key>, run `plandex models custom`, and paste the block below.",
      },
    ],
    notes: [
      {
        type: "warning",
        text: "Custom providers are only fully supported on self-hosted Plandex. On Plandex Cloud with BYO API keys, models can only use built-in providers.",
      },
    ],
    codeBlock: {
      language: "json",
      code: `{
  "providers": [
    {
      "name": "omniroute",
      "baseUrl": "{{baseUrl}}",
      "apiKeyEnvVar": "OMNIROUTE_API_KEY",
      "skipAuth": false
    }
  ],
  "models": [
    {
      "modelId": "{{model}}",
      "publisher": "OmniRoute",
      "providers": [
        { "provider": "custom", "customProvider": "omniroute", "modelName": "{{model}}" }
      ]
    }
  ]
}`,
    },
  },

  /**
   * gptme — terminal agent with shell/file/browser tools.
   * Verified: "Custom providers" documents both the OPENAI_BASE_URL environment
   * variable and the ~/.config/gptme/config.toml `[[providers]]` block with
   * `name` (required), `base_url` (required), `api_key_env` and `default_model`,
   * and shows models referenced as `<provider>/<model>`.
   */
  gptme: {
    id: "gptme",
    name: "gptme",
    icon: "smart_toy",
    color: "#0891B2",
    description: "gptme — terminal agent with shell and file tools; [[providers]] base_url",
    docsUrl: "https://gptme.org/docs/providers-custom.html",
    configType: "guide",
    category: "agent",
    vendor: "OSS (E. Bjäreholt)",
    acpSpawnable: false,
    baseUrlSupport: "full",
    defaultCommand: "gptme",
    guideSteps: [
      { step: 1, title: "Install gptme", desc: "pipx install gptme" },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "Select Model", type: "modelSelector" },
      {
        step: 5,
        title: "Add the provider",
        desc: "Append the block below to ~/.config/gptme/config.toml, then: gptme 'hello' -m omniroute",
      },
    ],
    notes: [
      {
        type: "info",
        text: "api_key_env names an environment variable, not the key itself — export OMNIROUTE_API_KEY=<your key> before running gptme.",
      },
    ],
    codeBlock: {
      language: "toml",
      code: `# ~/.config/gptme/config.toml
[[providers]]
name = "omniroute"
base_url = "{{baseUrl}}"
api_key_env = "OMNIROUTE_API_KEY"
default_model = "{{model}}"`,
    },
  },

  /**
   * Trae Agent (ByteDance) — `trae-cli`.
   * Verified: README documents the trae_config.yaml `model_providers:` block with
   * `api_key` / `provider` / `base_url`, the `models:` block keyed by name with
   * `model_provider` and `model` (from trae_config.yaml.example), the `agents:`
   * block selecting a model by name, the supported OPENAI_BASE_URL /
   * ANTHROPIC_BASE_URL environment variables, and the resolution order
   * "Command-line arguments > Configuration file > Environment variables >
   * Default values" — which is why the config file, not the env var, is the
   * instruction given here.
   */
  trae: {
    id: "trae",
    name: "Trae Agent",
    icon: "smart_toy",
    color: "#DC2626",
    description:
      "Trae Agent (ByteDance) — trae-cli; base_url under model_providers in trae_config.yaml",
    docsUrl: "https://github.com/bytedance/trae-agent",
    configType: "guide",
    category: "agent",
    vendor: "ByteDance (OSS)",
    acpSpawnable: false,
    baseUrlSupport: "full",
    defaultCommand: "trae-cli",
    guideSteps: [
      {
        step: 1,
        title: "Install Trae Agent",
        desc: "git clone the repo, then: uv sync --all-extras",
      },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "Select Model", type: "modelSelector" },
      {
        step: 5,
        title: "Write trae_config.yaml",
        desc: "cp trae_config.yaml.example trae_config.yaml, paste the block below, then: trae-cli run 'your task'",
      },
    ],
    notes: [
      {
        type: "warning",
        text: "Trae resolves settings as CLI args > trae_config.yaml > environment. A base_url already present in the config file wins over OPENAI_BASE_URL, so edit the file rather than exporting the variable.",
      },
    ],
    codeBlock: {
      language: "yaml",
      code: `model_providers:
  omniroute:
    api_key: {{apiKey}}
    provider: openai
    base_url: {{baseUrl}}

models:
  omniroute_model:
    model_provider: omniroute
    model: {{model}}

agents:
  trae_agent:
    model: omniroute_model`,
    },
  },

  /**
   * Octofriend (Synthetic Lab) — terminal coding agent, `octo`.
   * Verified: README documents `npm install --global octofriend`, the
   * ~/.config/octofriend/octofriend.json5 config and the interactive
   * "Add a custom model..." menu, and states it supports "any OpenAI-compatible or
   * Anthropic-compatible LLM API". source/config.ts confirms the top-level
   * `models` array and the model schema keys `nickname`, `model`, `context`
   * (required), `baseUrl` and `apiEnvVar`.
   */
  octofriend: {
    id: "octofriend",
    name: "Octofriend",
    icon: "smart_toy",
    color: "#A855F7",
    description:
      "Octofriend — terminal coding agent; custom model with baseUrl in octofriend.json5",
    docsUrl: "https://github.com/synthetic-lab/octofriend",
    configType: "guide",
    category: "agent",
    vendor: "OSS (Synthetic Lab)",
    acpSpawnable: false,
    baseUrlSupport: "full",
    defaultCommand: "octofriend",
    guideSteps: [
      { step: 1, title: "Install Octofriend", desc: "npm install --global octofriend" },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "Select Model", type: "modelSelector" },
      {
        step: 5,
        title: "Add a custom model",
        desc: "Run `octo`, pick 'Add a custom model...' — or append the entry below to the models array by hand.",
      },
    ],
    notes: [
      {
        type: "info",
        text: "apiEnvVar names an environment variable, not the key itself — export OMNIROUTE_API_KEY=<your key>. `context` is required; set it to the context window of the model you picked.",
      },
    ],
    codeBlock: {
      language: "json5",
      code: `// ~/.config/octofriend/octofriend.json5 — append to the "models" array
{
  nickname: "OmniRoute — {{model}}",
  model: "{{model}}",
  context: 200000,
  baseUrl: "{{baseUrl}}",
  apiEnvVar: "OMNIROUTE_API_KEY",
}`,
    },
  },

  /**
   * RA.Aid — research-and-implement agent.
   * Verified: "Open models" quickstart documents `OPENAI_API_KEY` and
   * `OPENAI_API_BASE` ("Set custom base URL with OPENAI_API_BASE") together with
   * `ra-aid -m "Your task" --provider openai-compatible --model your-model-name`;
   * the installation page documents `pip install ra-aid`.
   */
  raaid: {
    id: "raaid",
    name: "RA.Aid",
    icon: "smart_toy",
    color: "#059669",
    description: "RA.Aid — research-and-implement agent; OPENAI_API_BASE with openai-compatible",
    docsUrl: "https://docs.ra-aid.ai/quickstart/open-models/",
    configType: "guide",
    category: "agent",
    vendor: "OSS (ai-christianson)",
    acpSpawnable: false,
    baseUrlSupport: "full",
    defaultCommand: "ra-aid",
    guideSteps: [
      { step: 1, title: "Install RA.Aid", desc: "pip install ra-aid" },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "Select Model", type: "modelSelector" },
    ],
    notes: [
      {
        type: "info",
        text: "RA.Aid reads OPENAI_API_BASE (not OPENAI_BASE_URL) and needs --provider openai-compatible for that variable to be honoured.",
      },
    ],
    codeBlock: {
      language: "bash",
      code: `export OPENAI_API_KEY="{{apiKey}}"
export OPENAI_API_BASE="{{baseUrl}}"
ra-aid -m "Add retries to the HTTP client" \\
  --provider openai-compatible \\
  --model {{model}}`,
    },
  },
};
