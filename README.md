# Clama

A local AI assistant for your Mac. No cloud. No noise. Just commands.

Website: https://acast.github.io/clama/

## What it is

Clama is a small CLI assistant for macOS that talks to a local Ollama model through the OpenAI-compatible API. It understands natural language in English and Russian, opens apps, controls music, reads files, and remembers simple facts.

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
- understand phrases like `open Finder`, `open Safari`, `open downloads`, `open desktop`
- understand folder commands like `open downloads folder` and `open documents`
- answer `what's playing now`
- adjust macOS volume with `/volume up`, `/volume down`, `/volume set 50`
- answer `what's in my clipboard`
- copy text with `copy: ...` or `copy this`
- answer disk space questions like `how much free disk space do I have`
- read the clipboard with `/clip get`
- handle a few direct commands without the model, like `play music` or `/open Music`

## Notes

- File tools are restricted to the working directory by default.
- Shell commands run in the working directory, but they are still normal shell commands.
- The agent expects the model to return JSON tool calls or a final answer.
- Recent conversation history is saved in `.clama/history.jsonl` and loaded on the next launch.
- A small structured memory is saved in `.clama/memory.json` for simple facts like likes, dislikes, name, recent actions, and last opened apps.
- You can ask things like `what do I like?`, `what do I dislike?`, `what is my name?`, `what apps did I open?`, and `what did I do?`
- Existing `.claudegemma` state is migrated automatically to `.clama` on first launch.
- The prompt explicitly tells the model to answer in the user's language and support English and Russian equally.
- Common OS actions are routed directly before the model runs, which makes them more reliable on small models.
