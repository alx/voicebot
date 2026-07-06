const SELECTORS = {
    chatInput: '#send_textarea',
    sendButton: '#send_but',
    generatingIndicator: '#mes_stop',
    characterEntries: '#rm_print_characters_block .character_select',
    messages: '#chat .mes',
};

/**
 * Select a character by its display name from SillyTavern's character list panel.
 * @param {import('puppeteer').Page} page
 * @param {string} characterName
 */
export async function selectCharacter(page, characterName) {
    const found = await page.evaluate(
        (selector, name) => {
            const entries = Array.from(document.querySelectorAll(selector));
            const match = entries.find(
                (el) => el.querySelector('.ch_name')?.textContent?.trim() === name
            );
            if (!match) return false;
            match.click();
            return true;
        },
        SELECTORS.characterEntries,
        characterName
    );

    if (!found) {
        throw new Error(`Character "${characterName}" not found in SillyTavern's character list`);
    }
}

/**
 * Build a ChatAdapter (see chat-client.js) backed by a real, already-open SillyTavern page.
 * @param {import('puppeteer').Page} page
 * @returns {import('./chat-client.js').ChatAdapter}
 */
export function createPageAdapter(page) {
    let countBeforeSubmit = 0;

    return {
        async submitMessage(text) {
            countBeforeSubmit = await page.$$eval(SELECTORS.messages, (els) => els.length);
            await page.click(SELECTORS.chatInput);
            await page.type(SELECTORS.chatInput, text);
            await page.click(SELECTORS.sendButton);
        },
        async isReplyReady() {
            const { count, lastIsUser } = await page.$$eval(SELECTORS.messages, (els) => ({
                count: els.length,
                lastIsUser: els[els.length - 1]?.getAttribute('is_user') === 'true',
            }));
            if (count <= countBeforeSubmit) {
                return false;
            }
            if (lastIsUser) {
                return false;
            }

            const generating = await page
                .$eval(SELECTORS.generatingIndicator, (el) => el.style.display === 'flex')
                .catch(() => false);
            return !generating;
        },
        async getLatestMessageText() {
            return page.$$eval(SELECTORS.messages, (els) => {
                const last = els[els.length - 1];
                return last?.querySelector('.mes_text')?.textContent?.trim() ?? '';
            });
        },
    };
}
