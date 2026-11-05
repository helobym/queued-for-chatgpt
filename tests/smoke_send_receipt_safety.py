"""Receipt safety regressions for existing-chat sequential sends (simulated ChatGPT)."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
MOCK = (ROOT / 'tests/mock_app_shell.html').read_text(encoding='utf-8')


def open_queue(browser):
    page = browser.new_page(viewport={'width': 1200, 'height': 900})
    page.set_content(MOCK)
    page.add_script_tag(path=str(ROOT / 'core.js'))
    page.add_script_tag(path=str(ROOT / 'coordinator.js'))
    page.evaluate("""() => {
      QFC.conversationId = () => 'chat:receipt-test';
      window.importScripts = () => {};
      let listener;
      chrome.runtime = {
        id: 'mock-qfc-extension',
        onMessage: { addListener(fn) { listener = fn; } },
        sendMessage(msg) { return new Promise(resolve =>
          listener(msg, {id: 'mock-qfc-extension', frameId: 0,
            url: 'https://chatgpt.com/c/receipt-test'}, resolve)); }
      };
      Object.defineProperty(navigator, 'locks', {
        value: {request: async (_name, _options, callback) => callback({})}
      });
    }""")
    page.add_script_tag(path=str(ROOT / 'background.js'))
    # Shorten only the simulated receipt deadline.
    source = (ROOT / 'content.js').read_text(encoding='utf-8')
    source = source.replace('const deadline = Date.now() + 15000;',
                            'const deadline = Date.now() + 1800;', 1)
    page.add_script_tag(content=source)
    page.locator('.qfc-dock').click()
    return page


def add_duplicate_prompts(page):
    for count in (1, 2):
        page.locator('#qfc-compose').fill('Repeat exactly this prompt')
        page.locator('#qfc-add').click()
        page.wait_for_function(
            "(expected) => document.querySelector('#qfc-count').textContent === String(expected)",
            arg=count)


with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])

    # Legitimately repeated prompts must be sent twice as distinct user turns.
    page = open_queue(browser)
    add_duplicate_prompts(page)
    page.locator('#qfc-start').click()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('Queue complete')",
        timeout=35000)
    assert page.evaluate('window.__sentCount') == 2
    assert page.locator('#qfc-count').inner_text() == '0'
    page.close()

    # ChatGPT ignores the second click and re-renders the first user message.
    # Old code wrongly treated the replaced DOM node as a new send receipt.
    page = open_queue(browser)
    page.evaluate("""() => {
      window.__ignoredClicks = 0;
      document.querySelector('[data-testid="send-button"]')
        .addEventListener('click', event => {
          if (window.__sentCount !== 1) return;
          event.stopImmediatePropagation();
          window.__ignoredClicks++;
          const unit = document.querySelector(
            '[data-chatgpt-search-unit-key$=":user"]');
          unit.replaceWith(unit.cloneNode(true));
        }, true);
    }""")
    add_duplicate_prompts(page)
    page.locator('#qfc-start').click()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('Could not confirm sent message')",
        timeout=20000)
    assert page.evaluate('window.__sentCount') == 1
    assert page.evaluate('window.__ignoredClicks') == 1
    assert page.locator('#qfc-count').inner_text() == '1'
    assert 'Sending' in page.locator('#qfc-queue-items').inner_text()
    assert 'Awaiting response' not in page.locator('#qfc-queue-items').inner_text()
    assert page.locator('#prompt-textarea').inner_text().strip() == 'Repeat exactly this prompt'
    page.close()

    print('PASS: repeated sends succeed; ignored click and DOM re-render never becomes awaiting')
    browser.close()
