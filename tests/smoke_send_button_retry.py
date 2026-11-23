"""Three bounded Send-button readiness retries, without unsafe duplicate sends."""
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
      QFC.conversationId = () => 'chat:send-retry-test';
      window.importScripts = () => {};
      let listener;
      chrome.runtime = {
        id: 'mock-qfc-extension',
        onMessage: {addListener(fn) {if (!listener) listener = fn;}},
        sendMessage(msg) {return new Promise(resolve =>
          listener(msg, {id: 'mock-qfc-extension', frameId: 0,
            url: 'https://chatgpt.com/c/send-retry-test'}, resolve));}
      };
      chrome.commands = {onCommand: {addListener() {}}};
      chrome.tabs = {query: async () => [], sendMessage: async () => {}};
      Object.defineProperty(navigator, 'locks', {
        value: {request: async (_name, _options, callback) => callback({})}
      });
    }""")
    page.add_script_tag(path=str(ROOT / 'background.js'))
    source = (ROOT / 'content.js').read_text(encoding='utf-8')
    assert 'const SEND_BUTTON_RETRY_MS = 3000;' in source
    # Accelerate only the retry cadence in this simulated-browser test.
    source = source.replace('const SEND_BUTTON_RETRY_MS = 3000;',
                            'const SEND_BUTTON_RETRY_MS = 350;', 1)
    page.add_script_tag(content=source)
    page.locator('.qfc-dock').click()
    page.locator('#qfc-compose').fill('Retry-safe test prompt')
    page.locator('#qfc-add').click()
    page.wait_for_function(
        "document.querySelector('#qfc-count').textContent === '1'")
    return page


with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])

    # Send stays disabled at first, then becomes ready during the retries.
    page = open_queue(browser)
    page.locator('[data-testid="send-button"]').evaluate('(el) => el.disabled = true')
    page.locator('#qfc-start').click()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('retry 2/3')",
        timeout=12000)
    assert page.evaluate('window.__sentCount') == 0
    page.locator('[data-testid="send-button"]').evaluate('(el) => el.disabled = false')
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('Queue complete')",
        timeout=20000)
    assert page.evaluate('window.__sentCount') == 1
    assert page.locator('#qfc-count').inner_text() == '0'
    page.close()

    # All three retries expire: keep the draft and uncertain queue head.
    page = open_queue(browser)
    page.locator('[data-testid="send-button"]').evaluate('(el) => el.disabled = true')
    page.locator('#qfc-start').click()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('after 3 retries')",
        timeout=12000)
    assert page.evaluate('window.__sentCount') == 0
    assert page.locator('#prompt-textarea').inner_text().strip() == 'Retry-safe test prompt'
    assert page.locator('#qfc-count').inner_text() == '1'
    assert 'Sending' in page.locator('#qfc-queue-items').inner_text()
    page.close()

    # Never overwrite a user-modified draft while waiting for a Send control.
    page = open_queue(browser)
    page.locator('[data-testid="send-button"]').evaluate('(el) => el.disabled = true')
    page.locator('#qfc-start').click()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('retry 1/3')",
        timeout=12000)
    page.locator('#prompt-textarea').fill('My new unsent draft')
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('Composer changed')",
        timeout=6000)
    assert page.evaluate('window.__sentCount') == 0
    assert page.locator('#prompt-textarea').inner_text() == 'My new unsent draft'
    assert page.locator('#qfc-count').inner_text() == '1'
    page.close()

    # Pause must cancel the retry loop, even if Send becomes enabled later.
    page = open_queue(browser)
    page.locator('[data-testid="send-button"]').evaluate('(el) => el.disabled = true')
    page.locator('#qfc-start').click()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('retry 1/3')",
        timeout=12000)
    page.locator('#qfc-pause').click()
    page.locator('[data-testid="send-button"]').evaluate('(el) => el.disabled = false')
    page.wait_for_timeout(900)
    assert page.evaluate('window.__sentCount') == 0
    assert 'Paused by you' in page.locator('#qfc-status').inner_text()
    page.close()

    print('PASS: delayed Send, 3-retry exhaustion, edited draft, and manual pause')
    browser.close()
