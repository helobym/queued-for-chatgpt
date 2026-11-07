"""Regression: first user bubble isn't recognizable, but the assistant reply is.
The extension must continue only after the first reply is complete.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

PROJECT = Path(__file__).resolve().parent.parent
fixture = (PROJECT / 'tests' / 'mock_chat.html').read_text(encoding='utf-8')
fixture = fixture.replace(
    '<div data-message-author-role="user"><div class="whitespace-pre-wrap">An earlier message</div></div>', '')
fixture = fixture.replace(
    "const user = document.createElement('div'); user.setAttribute('data-message-author-role','user');",
    '''if (!window.__mockRoute) {
         window.__mockRoute = 'chat:first-reply-fallback';
         window.dispatchEvent(new Event('popstate'));
       }
       window.__sentCount = (window.__sentCount || 0) + 1;
       const user = document.createElement('div');
       if (window.__sentCount > 1) user.setAttribute('data-message-author-role','user');
       // The first user message is displayed, but its role is deliberately
       // unrecognizable (e.g. a ChatGPT DOM variant).
       else user.setAttribute('data-testid','new-user-markup');''')
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1200, 'height': 900})
    page.set_content(fixture)
    page.add_style_tag(path=str(PROJECT / 'content.css'))
    page.add_script_tag(path=str(PROJECT / 'core.js'))
    page.add_script_tag(path=str(PROJECT / 'coordinator.js'))
    page.evaluate("QFC.conversationId = () => window.__mockRoute || null")
    page.evaluate('''() => {
      window.importScripts = () => {};
      let handler;
      chrome.runtime = {
        id: 'mock-qfc-extension',
        onMessage: { addListener(fn){if(!handler) handler=fn; else window.__qfcUiListener=fn;} },
        sendMessage(request) {
          return new Promise(resolve => handler(request,
            {id:'mock-qfc-extension',frameId:0,url:'https://chatgpt.com/'},resolve));
        }
      };
      Object.defineProperty(navigator, 'locks', {
        value: { request: async (_name, _opts, cb) => cb({}) }
      });
    }''')
    page.evaluate("""() => {
      chrome.commands = {onCommand:{addListener(fn){window.__qfcCommandListener=fn;}}};
      chrome.tabs = {query:async()=>[],sendMessage:async()=>{}};
    }""")
    page.add_script_tag(path=str(PROJECT / 'background.js'))
    content = (PROJECT / 'content.js').read_text(encoding='utf-8')
    content = content.replace('function isNewChatPage() {',
                              'function isNewChatPage() { return true; } function unusedPageCheck() {', 1)
    page.add_script_tag(content=content)
    page.locator('.qfc-dock').click()
    for prompt in ('First prompt: user UI has different markup', 'Second prompt: must send automatically'):
        page.locator('#qfc-compose').fill(prompt)
        page.locator('#qfc-add').click()
        page.locator('#qfc-queue-items').get_by_text(prompt).wait_for()
    page.locator('#qfc-start').click()
    page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('Queue complete')", timeout=30000)
    assert page.evaluate('window.__sentCount') == 2, 'Expected two sequential sends'
    assert page.locator('#qfc-count').inner_text() == '0'
    assert page.locator('[data-testid="new-user-markup"]').count() == 1
    print('PASS: unrecognized first user message but verified assistant completion -> second prompt auto-sent')
    browser.close()
