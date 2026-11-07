"""Local new-chat browser flow with simulated ChatGPT URL assignment and response."""
from pathlib import Path
from playwright.sync_api import sync_playwright

PROJECT = Path(__file__).resolve().parent.parent
FIXTURE = PROJECT / 'tests' / 'mock_chat.html'
mock = FIXTURE.read_text(encoding='utf-8').replace(
    "const user = document.createElement('div');",
    """if (!window.__mockRoute) {
        // In-memory mock of ChatGPT assigning a conversation ID after its first send.
        window.__mockRoute = 'chat:created-new-chat';
        window.dispatchEvent(new Event('popstate'));
      }
      const user = document.createElement('div');"""
).replace('<div data-message-author-role="user"><div class="whitespace-pre-wrap">An earlier message</div></div>', '')

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1200, 'height': 900})
        page.set_content(mock)
        page.add_style_tag(path=str(PROJECT / 'content.css'))
        page.add_script_tag(path=str(PROJECT / 'core.js'))
        page.add_script_tag(path=str(PROJECT / 'coordinator.js'))
        page.evaluate("QFC.conversationId = () => window.__mockRoute || null")
        page.evaluate('''() => {
          window.importScripts = () => {};
          let workerListener;
          window.chrome.runtime = {
            id: 'mock-qfc-extension',
            onMessage: { addListener(fn){if(!workerListener) workerListener=fn; else window.__qfcUiListener=fn;} },
            sendMessage(message) {
              return new Promise(resolve => {
                workerListener(message, { id: 'mock-qfc-extension', frameId: 0, url: 'https://chatgpt.com/' }, resolve);
              });
            }
          };
          Object.defineProperty(navigator, 'locks', { value: { request: async (_name, _opts, callback) => callback({}) } });
        }''')
        page.evaluate("""() => {
          chrome.commands = {onCommand:{addListener(fn){window.__qfcCommandListener=fn;}}};
          chrome.tabs = {query:async()=>[],sendMessage:async()=>{}};
        }""")
        page.add_script_tag(path=str(PROJECT / 'background.js'))
        # about:blank has no '/' pathname; use a mock home-page predicate only in this test.
        content = (PROJECT / 'content.js').read_text(encoding='utf-8')
        content = content.replace("function isNewChatPage() {", "function isNewChatPage() { return true; } function unusedPageCheck() {", 1)
        page.add_script_tag(content=content)
        page.locator('.qfc-dock').click()
        assert page.locator('#qfc-start').is_disabled()
        page.locator('#qfc-compose').fill('First prompt creates a conversation')
        page.locator('#qfc-add').click()
        page.locator('#qfc-queue-items').get_by_text('First prompt creates a conversation').wait_for()
        assert page.locator('#qfc-start').is_enabled(), 'Start should be available in a new chat'
        page.locator('#qfc-compose').fill('Second prompt is queued in that conversation')
        page.locator('#qfc-add').click()
        page.locator('#qfc-start').click()
        page.wait_for_function('''() => document.querySelector('#qfc-status').textContent.includes('Queue complete')''', timeout=30000)
        assert page.locator('#qfc-count').inner_text() == '0'
        assert page.locator('[data-message-author-role="user"]').count() == 2
        assert page.evaluate("QFC.conversationId(location.pathname)") == 'chat:created-new-chat'
        print('PASS: new-chat Start creates chat, migrates queue, and auto-sends second prompt')
        browser.close()
finally:
    pass
