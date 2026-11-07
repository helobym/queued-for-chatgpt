"""v1.2.8 notifications: verified success, automatic stop, manual pause and click."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
MOCK = (ROOT / 'tests/mock_chat.html').read_text(encoding='utf-8')


def install(page, disable_send=False):
    page.set_content(MOCK)
    page.add_style_tag(path=str(ROOT / 'content.css'))
    page.add_script_tag(path=str(ROOT / 'core.js'))
    page.add_script_tag(path=str(ROOT / 'coordinator.js'))
    page.evaluate("""() => {
      QFC.conversationId = () => 'chat:notification';
      window.importScripts = () => {};
      const listeners = [];
      window.__notices = [];
      window.__focused = [];
      chrome.runtime = {
        id:'mock-qfc-extension',
        getURL(file) { return 'chrome-extension://mock-qfc-extension/' + file; },
        onMessage:{addListener(fn){listeners.push(fn);}},
        sendMessage(message) {
          return new Promise(resolve => {
            let handled = false;
            const sender={id:'mock-qfc-extension',frameId:0,
              url:'https://chatgpt.com/c/notification',tab:{id:31}};
            for (const fn of listeners) {
              if (fn(message,sender,resolve) === true) handled = true;
            }
            if (!handled) resolve(undefined);
          });
        }
      };
      const session = {};
      chrome.storage.session = {
        async get(k) { return {[k]:session[k]}; },
        async set(o) { Object.assign(session,o); },
        async remove(k) { delete session[k]; }
      };
      window.__session = session;
      chrome.commands={onCommand:{addListener(){}}};
      chrome.notifications={
        onClicked:{addListener(fn){window.__noticeClick=fn;}},
        async create(id,options) { window.__notices.push({id,options}); return id; }
      };
      chrome.tabs={
        onUpdated:{addListener(fn){window.__tabUpdated=fn;}},
        onRemoved:{addListener(fn){window.__tabRemoved=fn;}},
        async get(id){return {id,windowId:7,url:'https://chatgpt.com/c/notification'};},
        async update(id,properties){window.__focused.push(['tab',id,properties.active]);return {id,windowId:7};}
      };
      chrome.windows={
        async update(id,properties){window.__focused.push(['window',id,properties.focused]);}
      };
      Object.defineProperty(navigator,'locks',{configurable:true,value:{
        request:async (_name,_options,callback)=>callback({})
      }});
    }""")
    if disable_send:
        page.evaluate("document.querySelector('[data-testid=send-button]').disabled=true")
    page.add_script_tag(path=str(ROOT / 'background.js'))
    page.add_script_tag(path=str(ROOT / 'content.js'))
    page.locator('.qfc-dock').click()


def make_workflow(page, name, steps):
    page.locator('[data-action="tab-workflows"]').click()
    page.locator('[data-action="new-workflow"]').click()
    page.locator('#qfc-edit-workflow-name').fill(name)
    page.locator('#qfc-step-0').fill(steps[0])
    for i, step in enumerate(steps[1:], start=1):
        page.locator('[data-action="add-workflow-step"]').click()
        page.locator('#qfc-step-' + str(i)).fill(step)
    page.locator('[data-action="save-workflow-edit"]').click()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])

    page = browser.new_page(viewport={'width':1100,'height':850})
    install(page)
    make_workflow(page,'MyRiser Security Audit',['Review controls','Summarize findings'])
    page.locator('[data-action="start-workflow"]').click()
    assert page.locator('#qfc-workflows-view').is_visible()
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('Queue complete')",
        timeout=45000)
    page.wait_for_function('window.__notices.length === 1')
    title,message = page.evaluate("""() => {
      const notice=window.__notices[0].options;
      return [notice.title,notice.message];
    }""")
    assert title == 'Workflow completed successfully', title
    assert 'All 2 prompts finished · MyRiser Security Audit' in message, message
    assert page.evaluate('Object.keys(window.__session).length') == 0
    page.evaluate("window.__tabUpdated(31,{discarded:true})")
    page.wait_for_timeout(100)
    assert page.evaluate('window.__notices.length') == 1
    page.evaluate("window.__noticeClick(window.__notices[0].id)")
    page.wait_for_function('window.__focused.length === 2')
    assert page.evaluate('window.__focused[0][1]') == 31
    page.close()

    # Disabled Send button prevents safe submission and must never claim success.
    page = browser.new_page(viewport={'width':1100,'height':850})
    install(page, disable_send=True)
    make_workflow(page,'Blocked submission',['Do not send this draft'])
    page.locator('[data-action="start-workflow"]').click()
    page.wait_for_function('window.__notices.length === 1',timeout=20000)
    title,message = page.evaluate("""() => [
      window.__notices[0].options.title,window.__notices[0].options.message
    ]""")
    assert title == 'Workflow stopped — action required',title
    assert 'Prompt submission could not be confirmed' in message,message
    assert page.locator('[data-message-author-role="user"]').count() == 1
    page.close()

    # Explicit manual pause must never emit a desktop notification.
    page = browser.new_page(viewport={'width':1100,'height':850})
    install(page)
    page.locator('#qfc-compose').fill('Manual pause check')
    page.locator('#qfc-add').click()
    page.wait_for_function("document.querySelector('#qfc-count').textContent === '1'")
    page.locator('#qfc-start').click()
    page.locator('#qfc-pause').click()
    page.wait_for_timeout(200)
    assert page.evaluate('window.__notices.length') == 0
    assert page.evaluate('Object.keys(window.__session).length') == 0
    page.close()

    print('PASS: verified workflow notification, automatic send failure, manual pause, click routing')
    browser.close()
