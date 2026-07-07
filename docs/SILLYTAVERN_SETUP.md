# Using a SillyTavern Persona for the LLM Step

By default, the voice pipeline sends each transcription straight to the LLM
with a fixed system prompt (`SYSTEM_PROMPT` in `src/config.py`) and no memory
between messages. Setting `LLM_BACKEND=sillytavern` instead routes that step
through a live [SillyTavern](https://github.com/SillyTavern/SillyTavern)
instance, so replies come from a real character/persona you define there —
with SillyTavern's own multi-turn chat history.

This works by having a small companion service, `st-bridge/`, drive
SillyTavern's actual web UI with a headless browser (the same approach this
project already uses for WhatsApp itself). It types each message into
SillyTavern's chat box and reads the reply back out, so persona behavior,
example dialogue, and conversation memory all come from SillyTavern directly
— nothing is reimplemented on the Python/Node side.

## 1. Install and run SillyTavern

```bash
git clone https://github.com/SillyTavern/SillyTavern.git
cd SillyTavern
npm install
npm start
```

By default this serves the UI at `http://localhost:8000`. If `st-bridge` will
run on a *different* machine than SillyTavern, edit SillyTavern's
`config.yaml` and set `listen: true` so it accepts connections from other
hosts — and see the security note at the bottom of this guide before doing
so.

## 2. Connect SillyTavern to an LLM

SillyTavern needs its own connection to an LLM backend (separate from this
bot's own `LLM_BASE_URL` — though it can point at the exact same server):

1. Open SillyTavern in a browser, click the "API Connections" plug icon.
2. Choose **Chat Completion** as the API, and **Custom (OpenAI-compatible)**
   as the source.
3. Enter your LLM server's URL (e.g. `http://localhost:8081/v1`) — do not
   add `/chat/completions` to the end.
4. Click "Connect" and confirm it shows as connected.

## 3. Create a character/persona

1. Click the "Character Management" icon in the left panel.
2. Click "Create New Character".
3. Fill in: **Name**, **Description**, **Personality**, **Scenario**, and
   optionally **Example Dialogue** and a **First Message**. This is the
   persona `st-bridge` will talk to.
4. Save the character.

## 4. Start a chat with the character

Click the character in the character list to open a chat with them. This is
the chat `st-bridge` will keep open and reuse for every voice message.

## 5. Configure and start `st-bridge`

```bash
cd st-bridge
cp .env.example .env
```

Edit `st-bridge/.env`:

```bash
ST_BRIDGE_PORT=8091
ST_BASE_URL=http://localhost:8000
ST_CHARACTER_NAME=<exact name you gave the character in step 3>
ST_REPLY_TIMEOUT_MS=60000
```

Install and start it:

```bash
npm install
npm start
```

On startup it launches a headless browser, opens SillyTavern, selects the
configured character, and listens for requests from the Python pipeline.
Leave this process running alongside the WhatsApp bot.

## 6. Enable the route in the bot's `.env`

In the project's root `.env`:

```bash
LLM_BACKEND=sillytavern
ST_BRIDGE_URL=http://localhost:8091
```

Restart the bot (`./start_bot.sh`). Voice messages will now be answered by
the SillyTavern persona instead of the direct LLM call.

## 7. Taming verbose roleplay replies

Voice replies get read aloud, so scene narration, `*action text*`, and
paragraph-length prose don't translate well — you want short, spoken
dialogue only. Two things work together to keep replies that way:

- **Chat-level instruction (primary fix).** If your character/preset was
  built for immersive roleplay (e.g. narrative-focused Chat Completion
  presets like "Marinara's Spaghetti Recipe"), it likely has a per-chat
  `variables.length` (or similar) telling the model to "expand with
  paragraphs" — that's usually the actual source of verbosity, more so than
  the character card itself. In SillyTavern, open the chat and set an
  **Author's Note** (top toolbar → note icon) instructing something like:
  *"Reply with spoken dialogue only, one to two short sentences, no
  narration, actions, or scene/environment descriptions."* If the active
  preset exposes a response-length toggle/variable, set that to something
  equally terse — it's usually the more direct lever than the Author's Note.
- **Code-level safety net.** `src/pipeline.py`'s `_strip_narration()` strips
  any `*action text*` segments from every SillyTavern reply before TTS, in
  case the persona still slips into narration occasionally. This is a
  fallback, not a fix — it can't repair prose that isn't asterisk-wrapped,
  so the chat-level instruction above is what actually controls verbosity.

## Notes and limitations

- **One shared conversation.** All voice messages in the configured WhatsApp
  group share a single SillyTavern chat/history — there's no per-sender
  memory.
- **No automatic fallback.** If `st-bridge` is down or SillyTavern fails to
  reply in time, the bot reports an error instead of silently falling back
  to the direct LLM path.
- **UI-dependent.** `st-bridge` drives SillyTavern's actual web page, so a
  SillyTavern update that changes its chat UI's markup can break it. If
  replies stop working after upgrading SillyTavern, check `st-bridge`'s
  selectors in `st-bridge/puppeteer-adapter.js` against the new markup.
- **Network security.** If SillyTavern or `st-bridge` are exposed beyond
  `localhost` (e.g. `st-bridge` running on a different machine than
  SillyTavern), securing that connection (VPN, reverse proxy with auth,
  firewall rules) is your responsibility — this integration does not add
  any authentication of its own.
