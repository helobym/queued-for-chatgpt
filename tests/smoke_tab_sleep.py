"""v1.2.11: idle sleep, reactivation, manual-stop safety and storage retention."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
MOCK = (ROOT / "tests/mock_chat.html").read_text(encoding="utf-8").replace(
    "}, 350);", "}, 1600);"
)
SOURCE = (ROOT / "content.js").read_text(encoding="utf-8").replace(
    "const IDLE_SLEEP_SCALE_MS = 60 * 1000;", "const IDLE_SLEEP_SCALE_MS = 160;"
)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"]
    )
    page = browser.new_page(viewport={"width": 1150, "height": 800})
    page.set_content(MOCK)
    page.add_style_tag(path=str(ROOT / "content.css"))
    page.add_script_tag(path=str(ROOT / "core.js"))
    page.add_script_tag(path=str(ROOT / "coordinator.js"))
    page.evaluate("""() => {
      QFC.conversationId = () => 'chat:sleep-test';
      window.importScripts = () => {};
      const handlers = [];
      window.__removedCss = 0;
      window.__notices = [];
      chrome.runtime = {
        id: 'mock-qfc-extension',
        getURL(f) { return 'chrome-extension://mock-qfc-extension/' + f; },
        onMessage: {
          addListener(fn) { handlers.push(fn); },
          removeListener(fn) { const i=handlers.indexOf(fn); if(i>=0)handlers.splice(i,1); }
        },
        sendMessage(message) {
          return new Promise(resolve => {
            let handled = false, responded = false;
            const sender = {id:'mock-qfc-extension', frameId:0,
              url:'https://chatgpt.com/c/sleep-test',tab:{id:42}};
            for(const handler of [...handlers]) {
              const result=handler(message,sender,data=>{
                if(!responded){responded=true;resolve(data);}
              });
              if(result===true)handled=true;
            }
            if(!handled&&!responded)resolve(undefined);
          });
        }
      };
      const session={};
      chrome.storage.session={
        async get(k){return {[k]:session[k]};},
        async set(v){Object.assign(session,v);},
        async remove(k){delete session[k];}
      };
      chrome.commands={onCommand:{addListener(){}}};
      chrome.action={onClicked:{addListener(){}}};
      chrome.scripting={
        async removeCSS(){window.__removedCss++;},
        async insertCSS(){},
        async executeScript(){}
      };
      chrome.tabs={
        onUpdated:{addListener(){}},onRemoved:{addListener(){}},
        async query(){return[];},async sendMessage(){},
      };
      chrome.notifications={
        onClicked:{addListener(){}},
        async create(id,options){window.__notices.push({id,options});return id;},
        async getPermissionLevel(){return 'granted';}
      };
      Object.defineProperty(navigator,'locks',{configurable:true,value:{
        request:async(_name,_opts,callback)=>callback({})
      }});
    }""")
    page.add_script_tag(path=str(ROOT / "background.js"))
    def activate():
        page.add_script_tag(content=SOURCE)
        page.locator("#qfc-root").wait_for()
        page.evaluate("""async()=>await chrome.runtime.sendMessage({
          app:'qfc-ui-v1', action:'open-panel'
        })""")
        assert page.locator("#qfc-panel").is_visible()

    activate()
    # An untouched active tab sleeps, disconnects its UI, and can be reactivated.
    page.wait_for_function("!document.querySelector('#qfc-root')", timeout=12000)
    assert page.evaluate("globalThis.__qfcContentLoaded") is False
    assert page.evaluate("window.__removedCss") == 1

    activate()
    page.locator("#qfc-compose").fill("Keep unsaved input in the editor")
    page.wait_for_timeout(950)
    assert page.locator("#qfc-root").count() == 1
    page.locator("#qfc-compose").fill("")
    page.wait_for_function("!document.querySelector('#qfc-root')", timeout=12000)

    # Settings and workflow records survive disposal and re-initialization.
    activate()
    page.locator('[data-action="tab-workflows"]').click()
    page.locator('[data-action="new-workflow"]').click()
    page.locator("#qfc-edit-workflow-name").fill("Persistent workflow")
    page.locator("#qfc-step-0").fill("Remember this prompt")
    page.locator('[data-action="save-workflow-edit"]').click()
    page.locator("#qfc-workflow-items").get_by_text("Persistent workflow").wait_for()
    page.locator('[data-action="open-settings"]').click()
    page.locator("#qfc-notify-interrupted").uncheck()
    page.wait_for_function("""async()=>{
      const s=await chrome.storage.local.get('qfc_v1_notification_settings');
      return s.qfc_v1_notification_settings?.onInterrupted===false;
    }""")
    # The power button turns off just this instance without deleting stored data.
    page.locator('[data-action="turn-off"]').click()
    page.wait_for_function("!document.querySelector('#qfc-root')", timeout=12000)
    activate()
    page.locator('[data-action="tab-workflows"]').click()
    page.locator("#qfc-workflow-items").get_by_text("Persistent workflow").wait_for()
    page.locator('[data-action="open-settings"]').click()
    assert not page.locator("#qfc-notify-interrupted").is_checked()

    # Manual OFF during a run must pause safely without false terminal success.
    page.locator('[data-action="settings-back"]').click()
    page.locator('[data-action="tab-queue"]').click()
    for prompt in ("First in-flight", "Second still pending"):
        page.locator("#qfc-compose").fill(prompt)
        page.locator("#qfc-add").click()
        page.locator("#qfc-queue-items").get_by_text(prompt).wait_for()
    page.locator("#qfc-start").click()
    page.locator("#qfc-pause").wait_for(state="visible")
    page.wait_for_function("!document.querySelector('#qfc-pause').disabled",timeout=10000)
    page.once("dialog", lambda dialog: dialog.accept())
    page.locator('[data-action="turn-off"]').click()
    page.wait_for_function("!document.querySelector('#qfc-root')",timeout=12000)
    record = page.evaluate("""async()=>{
      const reply=await chrome.runtime.sendMessage({
        app:'qfc-v1.1',command:'getQueue',route:'chat:sleep-test'
      });
      return reply.data;
    }""")
    assert len(record["items"]) >= 1
    assert record["items"][0]["status"] in ("pending", "sending", "awaiting")
    assert not any("completed successfully" in n["options"]["title"]
                   for n in page.evaluate("window.__notices"))

    # Never disables the timer; selecting one minute re-arms it immediately.
    activate()
    page.locator('[data-action="open-settings"]').click()
    page.locator("#qfc-auto-turn-off").select_option("0")
    page.wait_for_function("""async()=>{
      const s=(await chrome.storage.local.get('qfc_v1_settings')).qfc_v1_settings;
      return s?.autoTurnOffMinutes===0;
    }""")
    page.wait_for_timeout(950)
    assert page.locator("#qfc-root").count() == 1
    page.locator("#qfc-auto-turn-off").select_option("1")
    page.wait_for_function("!document.querySelector('#qfc-root')",timeout=12000)

    browser.close()
    print("PASS: configurable idle sleep, Never, reactivation, manual pause and persisted settings")
