"""Only verified completion may advance queue, including after 3 bounded retries."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
MOCK = (ROOT / 'tests/mock_app_shell.html').read_text(encoding='utf-8')


def open_queue(browser):
    page = browser.new_page(viewport={'width': 1200, 'height': 900})
    page.set_content(MOCK)
    page.evaluate('window.__suppressCompletedActions = true')
    page.add_script_tag(path=str(ROOT / 'core.js'))
    page.add_script_tag(path=str(ROOT / 'coordinator.js'))
    page.evaluate("""() => {
      QFC.conversationId = () => 'chat:response-retry-test';
      window.importScripts = () => {};
      let listener;
      chrome.runtime = {
        id: 'mock-qfc-extension',
        onMessage: {addListener(fn) {if (!listener) listener = fn;}},
        sendMessage(msg) {return new Promise(resolve =>
          listener(msg, {id: 'mock-qfc-extension', frameId: 0,
            url: 'https://chatgpt.com/c/response-retry-test'}, resolve));}
      };
      chrome.commands = {onCommand: {addListener() {}}};
      chrome.tabs = {query: async () => [], sendMessage: async () => {}};
      Object.defineProperty(navigator, 'locks', {
        value: {request: async (_name, _options, callback) => callback({})}
      });
    }""")
    page.add_script_tag(path=str(ROOT / 'background.js'))
    source = (ROOT / 'content.js').read_text(encoding='utf-8')
    assert 'const RESPONSE_RETRY_MS = 3000;' in source
    assert 'const MAX_RESPONSE_RETRIES = 3;' in source
    source = source.replace(
        'const deadline = Date.now() + 10 * 60 * 1000;\n    let sawStop = sawStopEarlier, sawReply = false;',
        'const deadline = Date.now() + 2400;\n    let sawStop = sawStopEarlier, sawReply = false;', 1)
    source = source.replace('const RESPONSE_RETRY_MS = 3000;',
                            'const RESPONSE_RETRY_MS = 1800;', 1)
    page.add_script_tag(content=source)
    page.locator('.qfc-dock').click()
    for prompt in ('First response needs completion evidence', 'Second must wait for first'):
        page.locator('#qfc-compose').fill(prompt)
        page.locator('#qfc-add').click()
        page.locator('#qfc-queue-items').get_by_text(prompt).wait_for()
    return page


with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])

    # A completed response's Copy control appears after the normal deadline.
    page = open_queue(browser)
    page.locator('#qfc-start').click()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('response completion — retry 1/3')",
        timeout=14000)
    assert page.evaluate('window.__sentCount') == 1
    page.evaluate("""() => {
      window.__suppressCompletedActions = false;
      const assistant = document.querySelector('[data-chatgpt-search-unit-key$=":assistant"]');
      const turn = assistant.closest('[data-turn-key]');
      const footer = document.createElement('div');
      footer.className = 'turn-action-controls';
      const copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.setAttribute('aria-label', 'Copy');
      footer.append(copy);
      turn.append(footer);
    }""")
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('Queue complete')",
        timeout=30000)
    assert page.evaluate('window.__sentCount') == 2
    assert page.locator('#qfc-count').inner_text() == '0'
    page.close()

    # With no independent completion proof, do not send the next prompt.
    page = open_queue(browser)
    page.locator('#qfc-start').click()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('Response completion uncertain after 3 retries')",
        timeout=22000)
    assert page.evaluate('window.__sentCount') == 1
    assert page.locator('#qfc-count').inner_text() == '2'
    assert 'Awaiting response' in page.locator('#qfc-queue-items').inner_text()
    page.close()

    # Manual Pause cancels rechecking and leaves the user's status intact.
    page = open_queue(browser)
    page.locator('#qfc-start').click()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('response completion — retry 1/3')",
        timeout=14000)
    page.locator('#qfc-pause').click()
    page.evaluate("""() => {
      const assistant = document.querySelector('[data-chatgpt-search-unit-key$=":assistant"]');
      const turn = assistant.closest('[data-turn-key]');
      const copy = document.createElement('button');
      copy.setAttribute('aria-label', 'Copy');
      turn.append(copy);
    }""")
    page.wait_for_timeout(2200)
    assert page.evaluate('window.__sentCount') == 1
    assert 'Paused by you' in page.locator('#qfc-status').inner_text()
    assert page.locator('#qfc-count').inner_text() == '2'
    page.close()

    print('PASS: late completion evidence, exhausted checks, and manual Pause')
    browser.close()
