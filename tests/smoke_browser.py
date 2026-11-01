"""Optional smoke test (needs Python Playwright and Chromium). Uses a *mock* webpage."""
from pathlib import Path
from playwright.sync_api import sync_playwright

PROJECT = Path(__file__).resolve().parent.parent
FIXTURE = PROJECT / 'tests' / 'mock_chat.html'

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={"width": 1200, "height": 900})
        page.set_content(FIXTURE.read_text(encoding='utf-8'))
        page.add_style_tag(path=str(PROJECT / 'content.css'))
        page.add_script_tag(path=str(PROJECT / 'core.js'))
        page.add_script_tag(path=str(PROJECT / 'coordinator.js'))
        page.evaluate('''() => {
          window.importScripts = () => {};
          let workerListener;
          window.chrome.runtime = {
            id: 'mock-qfc-extension',
            onMessage: { addListener(fn) { workerListener = fn; } },
            sendMessage(message) {
              return new Promise(resolve => {
                workerListener(message, { id: 'mock-qfc-extension', frameId: 0, url: 'https://chatgpt.com/c/test-chat' }, resolve);
              });
            }
          };
        }''')
        page.add_script_tag(path=str(PROJECT / 'background.js'))
        page.evaluate("QFC.conversationId = () => 'chat:test-chat'; Object.defineProperty(navigator, 'locks', { value: { request: async (_name, _opts, callback) => callback({}) } });")
        page.add_script_tag(path=str(PROJECT / 'content.js'))
        page.locator('.qfc-dock').click()
        page.locator('#qfc-compose').fill('First queued prompt')
        page.locator('#qfc-add').click()
        page.locator('#qfc-queue-items').get_by_text('First queued prompt').wait_for()
        page.locator('#qfc-compose').fill('Second queued prompt')
        page.locator('#qfc-add').click()
        page.locator('#qfc-workflow-name').fill('Two steps')
        page.locator('[data-action="save-queue-workflow"]').click()
        page.locator('#qfc-workflow-items').get_by_text('Two steps').wait_for()
        page.locator('[data-action="tab-queue"]').click()
        page.locator('#qfc-start').click()
        page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('Queue complete')", timeout=25000)
        assert page.locator('#qfc-count').inner_text() == '0'
        assert page.locator('[data-message-author-role="user"]').count() == 3
        print('PASS: queue auto-sends two prompts after saving multi-step workflow')
        browser.close()
finally:
    pass
