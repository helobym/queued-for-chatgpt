"""Regression: no recognizable first user *or* assistant turn -> do not send second prompt."""
from pathlib import Path
from playwright.sync_api import sync_playwright

PROJECT=Path(__file__).resolve().parent.parent
fixture=(PROJECT/'tests'/'mock_chat.html').read_text(encoding='utf-8')
fixture=fixture.replace('<div data-message-author-role="user"><div class="whitespace-pre-wrap">An earlier message</div></div>', '')
fixture=fixture.replace(
    "const user = document.createElement('div'); user.setAttribute('data-message-author-role','user');",
    '''if (!window.__mockRoute) {
         window.__mockRoute = 'chat:uncertain-first-prompt';
         window.dispatchEvent(new Event('popstate'));
       }
       window.__sentCount = (window.__sentCount || 0) + 1;
       const user = document.createElement('div');
       user.setAttribute('data-testid', 'unrecognized-user');''')
fixture=fixture.replace("assistant.setAttribute('data-message-author-role','assistant');", "assistant.setAttribute('data-testid','unrecognized-assistant');")
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    page=browser.new_page()
    page.set_content(fixture)
    page.add_script_tag(path=str(PROJECT/'core.js'))
    page.add_script_tag(path=str(PROJECT/'coordinator.js'))
    page.evaluate('QFC.conversationId = () => window.__mockRoute || null')
    page.evaluate('''() => {
      window.importScripts = () => {};
      let handler;
      chrome.runtime = {
        id:'mock-qfc-extension',onMessage:{addListener(fn){if(!handler) handler=fn; else window.__qfcUiListener=fn;}},
        sendMessage(request){return new Promise(resolve=>handler(request,
          {id:'mock-qfc-extension',frameId:0,url:'https://chatgpt.com/'},resolve));}
      };
      Object.defineProperty(navigator,'locks',{value:{request:async (_n,_o,cb)=>cb({})}});
    }''')
    page.evaluate("""() => {
      chrome.commands = {onCommand:{addListener(fn){window.__qfcCommandListener=fn;}}};
      chrome.tabs = {query:async()=>[],sendMessage:async()=>{}};
    }""")
    page.add_script_tag(path=str(PROJECT/'background.js'))
    content=(PROJECT/'content.js').read_text(encoding='utf-8')
    content=content.replace('function isNewChatPage() {',
                            'function isNewChatPage() { return true; } function unusedPageCheck() {',1)
    # Shorten just the evidence deadline for the negative test.
    content=content.replace('const deadline = Date.now() + 2 * 60 * 1000;',
                            'const deadline = Date.now() + 1600;',1)
    page.add_script_tag(content=content)
    page.locator('.qfc-dock').click()
    for prompt in ('First prompt without detectable ChatGPT turns', 'Must not be sent'):
        page.locator('#qfc-compose').fill(prompt)
        page.locator('#qfc-add').click()
        page.locator('#qfc-queue-items').get_by_text(prompt).wait_for()
    page.locator('#qfc-start').click()
    page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('First send could not be confirmed')",timeout=15000)
    assert page.evaluate('window.__sentCount') == 1, 'Second prompt must not be sent without proof of first submission'
    assert page.locator('#qfc-count').inner_text() == '2'
    print('PASS: no first-turn evidence -> safe pause, second prompt is not sent')
    browser.close()
