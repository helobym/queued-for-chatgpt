"""Regression: uncertain new-chat URL assignment must not send a second queued prompt."""
from pathlib import Path
from playwright.sync_api import sync_playwright

PROJECT = Path(__file__).resolve().parent.parent
fixture = (PROJECT / 'tests/mock_chat.html').read_text(encoding='utf-8')
fixture = fixture.replace('<div data-message-author-role="user"><div class="whitespace-pre-wrap">An earlier message</div></div>', '')
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    page = browser.new_page()
    page.set_content(fixture)
    page.add_script_tag(path=str(PROJECT / 'core.js'))
    page.add_script_tag(path=str(PROJECT / 'coordinator.js'))
    page.evaluate('''() => {
      window.importScripts = () => {};
      let handler;
      chrome.runtime = {
        id: 'mock-qfc-extension',
        onMessage: { addListener(fn){if(!handler) handler=fn; else window.__qfcUiListener=fn;} },
        sendMessage(request) {
          return new Promise(resolve => handler(request, {
            id: 'mock-qfc-extension', frameId: 0, url: 'https://chatgpt.com/'
          }, resolve));
        }
      };
      Object.defineProperty(navigator, 'locks', {
        value: { request: async (_name,_options,cb) => cb({}) }
      });
    }''')
    page.evaluate("""() => {
      chrome.commands = {onCommand:{addListener(fn){window.__qfcCommandListener=fn;}}};
      chrome.tabs = {query:async()=>[],sendMessage:async()=>{}};
    }""")
    page.add_script_tag(path=str(PROJECT / 'background.js'))
    script = (PROJECT / 'content.js').read_text(encoding='utf-8')
    script = script.replace('function isNewChatPage() {',
      'function isNewChatPage() { return true; } function unusedPageCheck() {', 1)
    # Shorten this test's route-assignment deadline, keeping production deadline at 90 sec.
    script = script.replace('const deadline = Date.now() + 90000;',
      'const deadline = Date.now() + 1500;', 1)
    page.add_script_tag(content=script)
    page.locator('.qfc-dock').click()
    for prompt in ('First queued prompt', 'Second queued prompt'):
        page.locator('#qfc-compose').fill(prompt)
        page.locator('#qfc-add').click()
        page.locator('#qfc-queue-items').get_by_text(prompt).wait_for()
    page.locator('#qfc-start').click()
    try:
        page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('Chat ID was not confirmed')", timeout=10000)
    except Exception:
        print('DEBUG status:', page.locator('#qfc-status').inner_text())
        print('DEBUG queue:', page.locator('#qfc-queue-items').inner_text())
        print('DEBUG user messages:', page.locator('[data-message-author-role="user"]').count())
        raise
    assert page.locator('[data-message-author-role="user"]').count() == 1, 'Second prompt must not be sent without chat ID'
    assert page.locator('#qfc-count').inner_text() == '2'
    assert 'Sending' in page.locator('#qfc-queue-items').inner_text()
    print('PASS: no stable chat ID -> pause, retain uncertain first prompt, do not send second')
    browser.close()
