"""App-shell ChatGPT DOM: old role attributes absent; prove sequential sends."""
from pathlib import Path
from playwright.sync_api import sync_playwright
PROJECT=Path(__file__).resolve().parent.parent
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1200,'height':900})
    page.set_content((PROJECT/'tests/mock_app_shell.html').read_text(encoding='utf-8'))
    page.add_style_tag(path=str(PROJECT/'content.css'))
    page.add_script_tag(path=str(PROJECT/'core.js'))
    page.add_script_tag(path=str(PROJECT/'coordinator.js'))
    page.evaluate('QFC.conversationId=()=>window.__mockRoute||null')
    page.evaluate('''() => {
      window.importScripts=()=>{}; let listener;
      chrome.runtime={id:'mock-qfc-extension',onMessage:{addListener(fn){listener=fn;}},
      sendMessage(request){return new Promise(resolve=>listener(request,
        {id:'mock-qfc-extension',frameId:0,url:'https://chatgpt.com/'},resolve));}};
      Object.defineProperty(navigator,'locks',{value:{request:async (_name,_opts,cb)=>cb({})}});
    }''')
    page.add_script_tag(path=str(PROJECT/'background.js'))
    code=(PROJECT/'content.js').read_text(encoding='utf-8').replace('function isNewChatPage() {',
       'function isNewChatPage() { return true; } function unusedPageCheck() {',1)
    page.add_script_tag(content=code)
    page.locator('.qfc-dock').click()
    for prompt in ['First app shell prompt','Second app shell prompt']:
        page.locator('#qfc-compose').fill(prompt)
        page.locator('#qfc-add').click()
        page.locator('#qfc-queue-items').get_by_text(prompt).wait_for()
    page.locator('#qfc-start').click()
    page.wait_for_function('''() => document.querySelector('#qfc-status').textContent.includes('Queue complete')''',timeout=35000)
    assert page.evaluate('window.__sentCount')==2
    assert page.locator('#qfc-count').inner_text()=='0'
    assert page.locator('[data-message-author-role]').count()==0
    assert page.locator('.qfc-message-star').count()==0
    assert page.locator('[data-action="tab-workflows"]').count()==1
    print('PASS: current-style app shell auto-sends two prompts without Favorites observers')
    browser.close()
