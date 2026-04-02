# Clama

Small Claude-inspired CLI agent that talks to a local Ollama model through the OpenAI-compatible API.

## Requirements

- Node.js 18+
- Ollama running on `http://localhost:11434`
- A model such as `gpt-oss:20b-cloud`

## Run

```bash
cd /Users/Shared/AI/Clama
node ./src/cli.mjs
```

Or set the model explicitly:

```bash
OLLAMA_MODEL=gpt-oss:20b-cloud node ./src/cli.mjs
```

If you install the package globally or link it locally, the command name is `clama`.

## What it can do

- read files
- write files
- replace text in files
- list files
- search text with `rg`
- run shell commands in the project directory
- open macOS apps such as Music
- control Music playback with `play`, `pause`, `next`, `previous`, `stop`
- understand human phrases like `открой finder`, `включи музыку`, `следующий трек`, `открой safari`
- understand folder commands like `открой downloads`, `открой documents`, `открой pictures`
- also understand variants like `открой папку downloads` and `open downloads folder`
- open `desktop` with `открой desktop`
- answer `какая музыка сейчас играет`
- adjust macOS volume with `/volume up`, `/volume down`, `/volume set 50`
- answer `что в буфере обмена`
- copy text with `скопируй: ...` or `скопируй это`
- answer disk space questions like `сколько свободного места на диске`
- read the clipboard with `/clip get`
- handle a few direct commands without the model, like `включи музыку` or `/open Music`

## Notes

- File tools are restricted to the working directory by default.
- Shell commands run in the working directory, but they are still normal shell commands.
- The agent expects the model to return JSON tool calls or a final answer.
- Recent conversation history is saved in `.clama/history.jsonl` and loaded on the next launch.
- A small structured memory is saved in `.clama/memory.json` for simple facts like likes, dislikes, name, recent actions, and last opened apps.
- You can ask things like `что я люблю?`, `что я не люблю?`, `что меня зовут?`, `какие приложения я открывал?`, and `что я делал?`.
- Existing `.claudegemma` state is migrated automatically to `.clama` on first launch.
- For local OS actions, the prompt now includes examples so the model is more likely to call `open_app` or `run_shell` instead of refusing.
- Some common OS actions are routed directly before the model runs, which makes them more reliable on small models.
