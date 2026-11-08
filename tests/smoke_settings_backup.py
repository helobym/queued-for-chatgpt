"""v1.2.12 regression: configurable idle setting, minimize/close, backup compatibility."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"]
    )
    page = browser.new_page(viewport={"width": 1120, "height": 810}, accept_downloads=True)
    page.set_content((ROOT / "tests/mock_chat.html").read_text(encoding="utf-8"))
    page.add_style_tag(path=str(ROOT / "content.css"))
    page.add_script_tag(path=str(ROOT / "core.js"))
    page.add_script_tag(path=str(ROOT / "coordinator.js"))
    page.evaluate("""() => {
      QFC.conversationId = () => 'chat:backup-settings';
      window.importScripts = () => {};
      const listeners = [];
      chrome.runtime = {
        id: 'mock-qfc-extension',
        onMessage: {
          addListener(fn) { listeners.push(fn); },
          removeListener(fn) {
            const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1);
          }
        },
        sendMessage(message) {
          return new Promise(resolve => {
            let handled = false, resolved = false;
            const sender = { id: 'mock-qfc-extension', frameId: 0,
              url: 'https://chatgpt.com/c/backup-settings', tab: { id: 12 } };
            for (const fn of [...listeners]) {
              const result = fn(message, sender, data => {
                resolved = true; resolve(data);
              });
              if (result === true) handled = true;
            }
            if (!handled && !resolved) resolve(undefined);
          });
        }
      };
      chrome.commands = { onCommand: { addListener() {} } };
      chrome.action = { onClicked: { addListener() {} } };
      chrome.scripting = { async removeCSS() {}, async insertCSS() {} };
      chrome.tabs = {
        onUpdated: { addListener() {} }, onRemoved: { addListener() {} },
        async query() { return []; }
      };
      Object.defineProperty(navigator, 'locks', { configurable: true, value: {
        request: async (_name, _opts, fn) => fn({})
      }});
    }""")
    page.add_script_tag(path=str(ROOT / "background.js"))
    page.add_script_tag(path=str(ROOT / "content.js"))
    page.locator(".qfc-dock").click()

    minimize = page.locator('.qfc-head-actions [data-action="toggle"]')
    shutdown = page.locator('.qfc-head-actions [data-action="turn-off"]')
    assert minimize.inner_text() == "−"
    assert shutdown.inner_text() == "✕"
    assert "Minimize" in minimize.get_attribute("aria-label")
    assert "turn it off" in shutdown.get_attribute("aria-label")
    # Close is the rightmost header control immediately following minimize.
    assert shutdown.evaluate("(el)=>el.previousElementSibling?.dataset.action") == "toggle"
    assert shutdown.bounding_box()["x"] > minimize.bounding_box()["x"]
    # Both controls inherit the same neutral button styling in normal and dark mode.
    assert page.evaluate("""() => {
      const a=getComputedStyle(document.querySelector('.qfc-minimize'));
      const b=getComputedStyle(document.querySelector('.qfc-power'));
      return a.backgroundColor===b.backgroundColor &&
        a.color===b.color &&
        a.borderTopColor===b.borderTopColor &&
        a.fontWeight===b.fontWeight &&
        a.fontSize===b.fontSize;
    }""")
    minimize.click()
    assert page.locator("#qfc-panel").is_hidden()
    assert page.locator(".qfc-dock").is_visible()
    page.locator(".qfc-dock").click()
    assert page.locator("#qfc-panel").is_visible()

    page.locator('[data-action="open-settings"]').click()
    timeout = page.locator("#qfc-auto-turn-off")
    assert timeout.input_value() == "5"
    timeout.select_option("0")
    page.wait_for_function("""async () => {
      const v = await chrome.storage.local.get('qfc_v1_settings');
      return v.qfc_v1_settings?.autoTurnOffMinutes === 0;
    }""")
    page.wait_for_function("document.querySelector('#qfc-auto-turn-off-status').textContent === 'Saved'")
    timeout.select_option("15")
    page.wait_for_function("""async () => {
      const v = await chrome.storage.local.get('qfc_v1_settings');
      return v.qfc_v1_settings?.autoTurnOffMinutes === 15;
    }""")
    page.locator("#qfc-notify-interrupted").uncheck()
    page.locator("#qfc-notify-sound").select_option("soft")
    page.locator("#qfc-notify-duration-mode").select_option("timed")
    page.locator("#qfc-notify-duration").fill("13")
    page.locator("#qfc-notify-duration").press("Tab")
    page.locator("#qfc-notify-volume").evaluate("""el => {
      el.value = '40';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    page.wait_for_function("""async () => {
      const v = (await chrome.storage.local.get('qfc_v1_notification_settings')).qfc_v1_notification_settings;
      return v?.sound === 'soft' && v.soundDuration === '13'
        && v.soundVolume === 40 && v.onInterrupted === false;
    }""")
    page.locator('[data-action="settings-back"]').click()
    page.locator('[data-action="tab-workflows"]').click()
    page.locator('[data-action="new-workflow"]').click()
    page.locator("#qfc-edit-workflow-name").fill("Settings backup workflow")
    page.locator("#qfc-step-0").fill("Original prompt")
    page.locator('[data-action="save-workflow-edit"]').click()
    page.locator("#qfc-workflow-items").get_by_text("Settings backup workflow").wait_for()

    with page.expect_download() as download_info:
        page.locator('[data-action="export-workflows"]').click()
    download = download_info.value
    payload = json.loads(Path(download.path()).read_text(encoding="utf-8"))
    assert payload["version"] == 4
    assert payload["kind"] == "workflows"
    assert payload["settings"]["autoTurnOffMinutes"] == 15
    assert payload["settings"]["notificationSettings"]["sound"] == "soft"
    assert payload["settings"]["notificationSettings"]["soundDuration"] == "13"
    assert payload["settings"]["notificationSettings"]["soundVolume"] == 40
    assert payload["settings"]["notificationSettings"]["onInterrupted"] is False
    assert payload["workflows"][0]["steps"] == ["Original prompt"]

    # An old workflow-only v3 backup is still accepted, without overwriting settings.
    page.locator('[data-action="open-settings"]').click()
    page.locator("#qfc-auto-turn-off").select_option("0")
    page.wait_for_function("""async()=>{
      const s=(await chrome.storage.local.get('qfc_v1_settings')).qfc_v1_settings;
      return s?.autoTurnOffMinutes===0;
    }""")
    page.locator("#qfc-notify-interrupted").check()
    page.wait_for_function("""async()=>{
      const s=(await chrome.storage.local.get('qfc_v1_notification_settings')).qfc_v1_notification_settings;
      return s?.onInterrupted===true;
    }""")
    page.locator('[data-action="settings-back"]').click()
    legacy = {
        "app": "Queued for ChatGPT", "kind": "workflows", "version": 3,
        "workflows": [{"name": "Old format workflow", "steps": ["Legacy prompt"]}]
    }
    page.locator("#qfc-import-file").set_input_files({
        "name": "v3.json", "mimeType": "application/json",
        "buffer": json.dumps(legacy).encode("utf-8")
    })
    page.locator("#qfc-workflow-items").get_by_text("Old format workflow").wait_for()
    assert page.evaluate("""async()=>{
      return (await chrome.storage.local.get('qfc_v1_settings')).qfc_v1_settings.autoTurnOffMinutes;
    }""") == 0

    # Invalid new settings are refused before changing any workflows.
    bad = {
        **payload, "workflows": [
            {"name": "Should not import", "steps": ["Bad payload"]}
        ],
        "settings": {**payload["settings"], "autoTurnOffMinutes": "60"}
    }
    page.locator("#qfc-import-file").set_input_files({
        "name": "bad.json", "mimeType": "application/json",
        "buffer": json.dumps(bad).encode("utf-8")
    })
    page.wait_for_function("document.querySelector('#qfc-status').textContent.includes('Invalid settings')")
    assert page.locator("#qfc-workflow-items").get_by_text("Should not import").count() == 0

    # Importing a v4 backup restores all settings and still merges workflows.
    page.once("dialog", lambda dialog: dialog.accept())
    page.locator("#qfc-import-file").set_input_files({
        "name": "v4.json", "mimeType": "application/json",
        "buffer": json.dumps(payload).encode("utf-8")
    })
    page.wait_for_function("""async()=>{
      const stored=await chrome.storage.local.get([
        'qfc_v1_settings','qfc_v1_notification_settings'
      ]);
      return stored.qfc_v1_settings?.autoTurnOffMinutes===15 &&
        stored.qfc_v1_notification_settings?.onInterrupted===false;
    }""")
    page.locator('[data-action="open-settings"]').click()
    assert page.locator("#qfc-auto-turn-off").input_value() == "15"
    assert not page.locator("#qfc-notify-interrupted").is_checked()
    assert page.locator("#qfc-notify-sound").input_value() == "soft"

    # A failed timeout write restores the last confirmed selection.
    page.evaluate("""() => {
      const original=chrome.storage.local.set.bind(chrome.storage.local);
      let fail=true;
      chrome.storage.local.set=async changes=>{
        if(fail && 'qfc_v1_settings' in changes){
          fail=false;throw new Error('Injected settings failure');
        }
        return original(changes);
      };
    }""")
    page.locator("#qfc-auto-turn-off").select_option("30")
    page.wait_for_function("document.querySelector('#qfc-auto-turn-off-status').textContent.includes('Save failed')")
    assert page.locator("#qfc-auto-turn-off").input_value() == "15"

    # The close icon fully disables the tab rather than minimizing it.
    shutdown.click()
    page.wait_for_function("!document.querySelector('#qfc-root')")
    assert page.evaluate("globalThis.__qfcContentLoaded") is False
    browser.close()
    print("PASS: timeout preferences, minimize/close, v3 import, v4 backup restore, and rollback")
