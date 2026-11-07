"""Do not send a second prompt if a reply has no completion evidence."""
from pathlib import Path
from playwright.sync_api import sync_playwright
PROJECT=Path(__file__).resolve().parent.parent
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1200,'height':900})
    page.set_content((PROJECT/'tests/mock_app_shell.html').read_text(encoding='utf-8'))
    page.evaluate('window.__suppressCompletedActions=true')
    page.add_script_tag(path=str(PROJECT/'core.js'))
    page.add_script_tag(path=str(PROJECT/'coordinator.js'))
    page.evaluate('QFC.conversationId=()=>window.__mockRoute||null')
    page.evaluate('''() => {
      window.importScripts=()=>{};let listener;
      chrome.runtime={id:'mock-qfc-extension',onMessage:{addListener(fn){if(!listener) listener=fn; else window.__qfcUiListener=fn;}},sendMessage(msg){return new Promise(res=>listener(msg,{id:'mock-qfc-extension',frameId:0,url:'https://chatgpt.com/'},res));}};
      Object.defineProperty(navigator,'locks',{value:{request:async(_n,_o,cb)=>cb({})}});
    }''')
    page.evaluate("""() => {
      chrome.commands = {onCommand:{addListener(fn){window.__qfcCommandListener=fn;}}};
      chrome.tabs = {query:async()=>[],sendMessage:async()=>{}};
    }""")
    page.add_script_tag(path=str(PROJECT/'background.js'))
    code=(PROJECT/'content.js').read_text(encoding='utf-8').replace('function isNewChatPage() {',
       'function isNewChatPage() { return true; } function unusedPageCheck() {',1)
    code=code.replace('const deadline = Date.now() + 10 * 60 * 1000;\n    let sawStop = sawStopEarlier, sawReply = false;',
       'const deadline = Date.now() + 2800;\n    let sawStop = sawStopEarlier, sawReply = false;',1)
    page.add_script_tag(content=code)
    page.locator('.qfc-dock').click()
    for prompt in ['First app shell has no completion controls','Second must not send']:
        page.locator('#qfc-compose').fill(prompt)
        page.locator('#qfc-add').click()
        page.locator('#qfc-queue-items').get_by_text(prompt).wait_for()
    page.locator('#qfc-start').click()
    page.wait_for_function('''() => document.querySelector('#qfc-status').textContent.includes('First response completion uncertain')''',timeout=16000)
    assert page.evaluate('window.__sentCount')==1
    print('PASS: no completion signal -> safe pause, no accidental second send')
    browser.close()
