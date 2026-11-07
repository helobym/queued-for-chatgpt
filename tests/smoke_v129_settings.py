"""v1.2.9 compact workflow disclosure and in-panel notification preferences."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1050,'height':780})
    page.set_content((ROOT / 'tests/mock_chat.html').read_text(encoding='utf-8'))
    page.add_style_tag(path=str(ROOT / 'content.css'))
    page.add_script_tag(path=str(ROOT / 'core.js'))
    page.add_script_tag(path=str(ROOT / 'coordinator.js'))
    page.evaluate("""() => {
      QFC.conversationId = () => 'chat:settings-smoke';
      window.importScripts=()=>{};
      const listeners=[];
      let audioOpen=false;
      window.__alerts=[];
      window.__audio=[];
      window.__offscreenCreates=0;
      chrome.runtime={
        id:'mock-qfc-extension',
        getURL(f){return 'chrome-extension://mock-qfc-extension/'+f;},
        getContexts:async()=>audioOpen ? [{documentUrl:'offscreen.html'}] : [],
        onMessage:{addListener(fn){listeners.push(fn);}},
        async sendMessage(message){
          if(message.app==='qfc-audio-v1'){
            window.__audio.push(message);
            return {played:true};
          }
          return new Promise(resolve=>{
            let handled=false;
            for(const fn of listeners) {
              if(fn(message,{id:'mock-qfc-extension',frameId:0,
                url:'https://chatgpt.com/c/settings-smoke',tab:{id:42}},resolve)===true)
                handled=true;
            }
            if(!handled)resolve(undefined);
          });
        }
      };
      const data={};
      chrome.storage.session={
        async get(key){return {[key]:data[key]};},
        async set(o){Object.assign(data,o);},
        async remove(key){delete data[key];}
      };
      chrome.notifications={
        async create(id,opts){window.__alerts.push({id,opts});return id;},
        async getPermissionLevel(){return 'granted';},
        onClicked:{addListener(){}}
      };
      chrome.offscreen={
        async createDocument(options){
          audioOpen=true;
          window.__offscreenCreates++;
          window.__audioDocumentOptions=options;
        }
      };
      chrome.commands={onCommand:{addListener(){}}};
      chrome.tabs={
        onUpdated:{addListener(){}},onRemoved:{addListener(){}},
        async query(){return[];},async sendMessage(){}
      };
      Object.defineProperty(navigator,'locks',{configurable:true,value:{
        request:async(_name,_opts,fn)=>fn({})
      }});
    }""")
    page.add_script_tag(path=str(ROOT / 'background.js'))
    page.add_script_tag(path=str(ROOT / 'content.js'))
    page.locator('.qfc-dock').click()
    page.locator('[data-action="tab-workflows"]').click()
    page.locator('[data-action="new-workflow"]').click()
    page.locator('#qfc-edit-workflow-name').fill('Alert test workflow')
    page.locator('#qfc-step-0').fill('First test prompt')
    page.locator('[data-action="add-workflow-step"]').click()
    page.locator('#qfc-step-1').fill('Second test prompt')
    page.locator('[data-action="save-workflow-edit"]').click()
    chevron=page.locator('[data-action="toggle-workflow"]')
    heading=page.locator('.qfc-workflow-heading')
    assert chevron.locator('xpath=..').get_attribute('class').find('qfc-workflow-heading') >= 0
    assert chevron.bounding_box()['x'] < heading.locator('.qfc-workflow-title').bounding_box()['x']
    assert chevron.bounding_box()['width'] <= 32
    chevron.focus()
    chevron.press('Enter')
    assert chevron.get_attribute('aria-expanded') == 'true'
    assert page.locator('.qfc-workflow-prompt-text').count() == 2

    page.locator('[data-action="open-settings"]').click()
    assert page.locator('#qfc-settings-view').is_visible()
    assert page.locator('.qfc-nav').is_hidden()
    assert page.locator('#qfc-workflows-view').is_hidden()
    assert page.locator('#qfc-notify-enabled').is_checked()
    assert page.locator('#qfc-notify-sound').input_value() == 'system'
    assert page.locator('#qfc-notify-duration').is_disabled()
    assert page.locator('#qfc-test-sound').is_disabled()
    page.locator('#qfc-notify-sound').select_option('double')
    page.locator('#qfc-notify-duration').select_option('10')
    page.locator('#qfc-notify-visibility').select_option('persistent')
    page.locator('#qfc-notify-interrupted').uncheck()
    page.wait_for_function("""async()=>{
      const v=(await chrome.storage.local.get('qfc_v1_notification_settings')).qfc_v1_notification_settings;
      return v?.sound==='double' && v?.soundDuration==='10' &&
        v?.visibility==='persistent' && v?.onInterrupted===false;
    }""")
    page.locator('#qfc-test-sound').click()
    page.wait_for_function('window.__audio.length === 1')
    assert page.evaluate('window.__audio[0].duration') == '10'
    assert page.evaluate('window.__offscreenCreates') == 1
    assert page.evaluate('window.__audioDocumentOptions.reasons[0]') == 'AUDIO_PLAYBACK'

    # A storage update from another tab should refresh the open Settings view.
    page.evaluate("""async()=>{
      const key='qfc_v1_notification_settings';
      const saved=(await chrome.storage.local.get(key))[key];
      await chrome.storage.local.set({[key]:{...saved,onSuccess:false}});
    }""")
    assert not page.locator('#qfc-notify-success').is_checked()
    page.locator('#qfc-notify-success').check()
    page.locator('[data-action="settings-back"]').click()
    assert page.locator('#qfc-workflows-view').is_visible()
    assert page.locator('[data-action="toggle-workflow"]').get_attribute('aria-expanded') == 'true'
    assert page.locator('.qfc-workflow-prompt-text').count() == 2

    page.locator('[data-action="start-workflow"]').click()
    page.wait_for_function(
      "document.querySelector('#qfc-status').textContent.includes('Queue complete')",
      timeout=45000)
    page.wait_for_function('window.__alerts.length === 1')
    notice=page.evaluate('window.__alerts[0].opts')
    assert notice['title'] == 'Workflow completed successfully',notice
    assert notice['silent'] is True
    assert notice['requireInteraction'] is True
    assert 'All 2 prompts finished' in notice['message']
    page.wait_for_function('window.__audio.length === 2')
    assert page.evaluate('window.__offscreenCreates') == 1

    page.locator('[data-action="open-settings"]').click()
    page.locator('#qfc-notify-enabled').uncheck()
    assert page.locator('#qfc-notify-sound').is_disabled()
    assert page.locator('#qfc-test-sound').is_disabled()
    page.wait_for_function("""async()=>{
      const s=(await chrome.storage.local.get('qfc_v1_notification_settings')).qfc_v1_notification_settings;
      return s?.enabled===false;
    }""")
    page.evaluate("""async()=>{
      const base={app:'qfc-v1.1',command:'runLifecycle',runId:'disabled-test-12345678'};
      await chrome.runtime.sendMessage({...base,action:'start'});
      await chrome.runtime.sendMessage({...base,action:'success',verifiedCount:1});
    }""")
    assert page.evaluate('window.__alerts.length') == 1
    assert page.evaluate('window.__audio.length') == 2
    assert not page.locator('.qfc-nav').is_visible()
    page.locator('[data-action="settings-back"]').click()
    page.locator('[data-action="tab-queue"]').click()
    assert page.locator('#qfc-queue-view').is_visible()
    assert page.locator('#qfc-status').is_visible()

    print('PASS: compact workflow chevron, persisted settings, cross-tab update, preview, silent custom alerts, disable')
    browser.close()
