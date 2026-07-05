# Finding Your WhatsApp Group ID

This guide explains how to find the WhatsApp group ID where you want to deploy the bot.

## Quick Start

Run the group ID finder script:

```bash
./scripts/get_group_id.sh
```

## What This Script Does

1. Connects to WhatsApp using the same authentication as your main bot
2. Lists all your WhatsApp groups with their names and IDs
3. Shows the number of participants in each group
4. Provides instructions for configuring your bot

## First Time Usage

**If you haven't authenticated WhatsApp yet:**

1. Run the script:
   ```bash
   ./scripts/get_group_id.sh
   ```

2. A QR code will appear in the terminal

3. Open WhatsApp on your phone:
   - Go to **Settings** → **Linked Devices**
   - Tap **"Link a Device"**
   - Scan the QR code displayed in the terminal

4. Wait for authentication to complete

5. The script will list all your groups with their IDs

## Subsequent Usage

**If you've already authenticated (session exists in `.wwebjs_auth/`):**

1. Run the script:
   ```bash
   ./scripts/get_group_id.sh
   ```

2. It will connect automatically (no QR code needed)

3. Groups will be listed immediately

## Example Output

```
==========================================================
WhatsApp Group ID Finder
==========================================================

This script will list all your WhatsApp groups with their IDs.
You can then copy the ID to your .env file.

Starting WhatsApp Group ID Finder...

Connecting to WhatsApp...
This may take a moment...

✓ Authenticated successfully!

==========================================================
✓ WhatsApp connected!
==========================================================

Fetching all chats...

Found 3 group(s):

==========================================================

1. Family Group
   ID: 120363123456789@g.us
   Participants: 5

2. Work Team
   ID: 120363987654321@g.us
   Participants: 12

3. Friends
   ID: 120363555555555@g.us
   Participants: 8

==========================================================

To use a group, copy its ID to your .env file:
VOICEBOT_GROUP_ID=<paste_id_here>

Example:
VOICEBOT_GROUP_ID=120363123456789@g.us
==========================================================

Disconnecting...
✓ Done! You can now close this script.
```

## Configuring Your Bot

1. Copy the group ID from the script output

2. Edit your `.env` file:
   ```bash
   nano .env
   ```

3. Add or update the `VOICEBOT_GROUP_ID` line:
   ```bash
   VOICEBOT_GROUP_ID=120363123456789@g.us
   ```

4. Save and exit

5. Start (or restart) your bot:
   ```bash
   ./start_bot.sh
   ```

## Group ID Format

WhatsApp group IDs always follow this format:
- **Groups**: `120363123456789@g.us`
- **Individual chats**: `1234567890@c.us` (your bot only processes groups)

The `@g.us` suffix indicates it's a group chat.

## Troubleshooting

### "No groups found"

- Make sure you're a member of at least one WhatsApp group
- Try creating a test group with yourself and one other person
- Refresh by running the script again

### "Authentication failed"

1. Delete the authentication data:
   ```bash
   rm -rf bot/.wwebjs_auth/
   ```

2. Run the script again:
   ```bash
   ./scripts/get_group_id.sh
   ```

3. Scan the new QR code

### "Client error" or Connection Issues

1. Check your internet connection
2. Make sure WhatsApp Web is working in your browser
3. Try logging out of all WhatsApp Web sessions on your phone and re-authenticate

### Script Hangs or Takes Too Long

1. Press `Ctrl+C` to stop
2. Delete session data:
   ```bash
   rm -rf bot/.wwebjs_auth/
   ```
3. Try again

## Manual Method (Alternative)

If the script doesn't work, you can find the group ID manually:

1. Start your main bot without setting `VOICEBOT_GROUP_ID`:
   ```bash
   # Make sure VOICEBOT_GROUP_ID is empty in .env
   ./start_bot.sh
   ```

2. Send any message to your target WhatsApp group

3. Check the bot logs - it will print:
   ```
   Incoming message from chat: 120363123456789@g.us (Group Name)
   ```

4. Copy the ID and add it to `.env`

## Files Created

- `bot/get_group_id.js` - Node.js script that connects to WhatsApp
- `scripts/get_group_id.sh` - Shell wrapper for easy execution

## Notes

- The script uses the same authentication session as your main bot
- If you've already authenticated the main bot, this script will reuse that session
- Running this script doesn't affect your main bot's operation
- The script automatically disconnects after listing groups

## Next Steps

After getting your group ID:

1. Configure `.env` with the group ID
2. Test your bot: `./start_bot.sh`
3. Send a voice message to the configured group
4. Verify the bot responds

For more information, see the main README.md file.
