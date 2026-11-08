"""Regression: auto turn-off counts a fresh idle interval only after a run completes."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SOURCE = (ROOT / "content.js").read_text(encoding="utf-8").replace(
    "const IDLE_SLEEP_SCALE_MS = 60 * 1000;", "const IDLE_SLEEP_SCALE_MS = 900;"
)
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"]
    )
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    page.set_content((ROOT / "tests/mock_app_shell.html").read_text(encoding="utf-8"))
    page.evaluate("window.__suppressCompletedActions=true")
    page.add_style_tag(path=str(ROOT / "content.css"))
    page.add_script_tag(path=str(ROOT / "core.js"))
    page.add_script_tag(path=str(ROOT / "coordinator.js"))
    page.evaluate('''() => {
      QFC.conversationId = () => 'chat:idle-after-run';
      window.importScripts = () => {};
      window.__removedCss = 0;
      const listeners = [];
      chrome.runtime = {
        id: 'mock-qfc-extension',
        onMessage: {
          addListener(fn) { listeners.push(fn); },
          removeListener(fn) {
            const index = listeners.indexOf(fn);
            if (index >= 0) listeners.splice(index, 1);
          }
        },
        async sendMessage(message) {
          if (message.command === 'queue' && message.mutation?.type === 'awaiting')
            await new Promise(resolve => setTimeout(resolve, 1200));
          return new Promise(resolve => {
            let handled = false, replied = false;
            for (const listener of [...listeners]) {
              const result = listener(message, {id:'mock-qfc-extension',frameId:0,
                url:'https://chatgpt.com/c/idle-after-run',tab:{id:8}}, data => {
                  replied = true; resolve(data);
                });
              if (result === true) handled = true;
            }
            if (!handled && !replied) resolve(undefined);
          });
        }
      };
      chrome.commands = {onCommand:{addListener(){}}};
      chrome.scripting = {
        async removeCSS() { window.__removedCss++; },
        async insertCSS() {}, async executeScript() {}
      };
      chrome.tabs = {
        onUpdated:{addListener(){}},onRemoved:{addListener(){}},
        async query(){return[];}
      };
      Object.defineProperty(navigator, 'locks', {configurable:true,value:{
        request:async(_name,_opts,fn)=>fn({})
      }});
      document.querySelector('[data-testid="send-button"]').addEventListener(
        'click', () => {
          const stop = document.createElement('button');
          stop.dataset.testid = 'stop-button'; stop.textContent = 'Stop';
          document.querySelector('form').append(stop);
          setTimeout(() => stop.remove(), 140);
        }, true
      );
    }''')
    page.add_script_tag(path=str(ROOT / "background.js"))
    page.add_script_tag(content=SOURCE)
    page.locator(".qfc-dock").click()
    page.locator('[data-action="open-settings"]').click()
    page.locator("#qfc-auto-turn-off").select_option("1")
    page.wait_for_function(
        "document.querySelector('#qfc-auto-turn-off-status').textContent === 'Saved'"
    )
    page.locator('[data-action="settings-back"]').click()
    page.locator("#qfc-compose").fill("Run longer than the idle duration")
    page.locator("#qfc-add").click()
    page.locator("#qfc-queue-items").get_by_text("Run longer than the idle duration").wait_for()
    page.locator("#qfc-start").click()
    page.wait_for_function("!document.querySelector('#qfc-pause').disabled", timeout=10000)
    page.wait_for_timeout(1000)
    assert page.locator("#qfc-root").count() == 1, "active run was turned off"
    page.wait_for_function(
        "document.querySelector('#qfc-status').textContent.includes('Queue complete.')",
        timeout=45000
    )
    assert page.evaluate("window.__sentCount") == 1
    page.wait_for_timeout(220)
    assert page.locator("#qfc-root").count() == 1, "idle time from the run was incorrectly counted"
    page.wait_for_function("!document.querySelector('#qfc-root')", timeout=10000)
    assert page.evaluate("window.__removedCss") == 1
    browser.close()
    print("PASS: running queue survives long response; idle countdown restarts only after completion")
