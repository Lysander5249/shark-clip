import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../pair-page.js',import.meta.url),'utf8');
const core=fs.readFileSync(new URL('../capture-core.js',import.meta.url),'utf8');
const PAIR=`http://127.0.0.1:43100/browser-pair#${'a'.repeat(64)}`;
function fixture({href=PAIR,marker='1',nested=false}={}){
  const calls=[],registry=new Map();
  function element(tag){return{tag,style:{},textContent:'',children:[],listeners:{},attributes:{},
    append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},
    addEventListener(type,handler){this.listeners[type]=handler;},setAttribute(name,value){this.attributes[name]=value;}};}
  const action=element('div');registry.set('browser-pair-action',action);
  const body=element('body');body.getAttribute=()=>marker;body.prepend=value=>body.children.unshift(value);
  const document={body,getElementById:id=>registry.get(id),createElement:element};
  const window={};window.top=nested?{}:window;
  const context={window,document,URL,TextEncoder,location:{href},chrome:{runtime:{async sendMessage(message){calls.push(message);return{ok:true};}}}};
  vm.createContext(context);vm.runInContext(core,context);vm.runInContext(source,context);
  return{calls,action,body,button:action.children[0]?.children.find(item=>item.tag==='button')};
}

test('the pairing-page button responds only to a trusted explicit click and does not display its capability',async()=>{
  const h=fixture();assert.ok(h.button);assert.equal(h.calls.length,0);
  await h.button.listeners.click({isTrusted:false});assert.equal(h.calls.length,0);
  await h.button.listeners.click({isTrusted:true});assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].type,'helper:pair-page');assert.equal(h.calls[0].pairingUrl,PAIR);
  assert.equal(h.button.disabled,true);
  assert.doesNotMatch(JSON.stringify(h.action.children),(new RegExp('a'.repeat(64))));
});

test('the helper does not insert pairing UI on another path, a subframe or an unmarked local page',()=>{
  for(const opts of [{href:PAIR.replace('/browser-pair','/other')},{nested:true},{marker:null},
    {href:PAIR.replace('127.0.0.1','localhost')},{href:PAIR.replace('127.0.0.1','pan.xunlei.com')}]){
    const h=fixture(opts);assert.equal(h.button,undefined);assert.equal(h.calls.length,0);
  }
});

test('the real manifest stays scoped to intended sites and has no cookie or all-sites permission',()=>{
  const manifest=JSON.parse(fs.readFileSync(new URL('../manifest.json',import.meta.url),'utf8'));
  assert.equal(manifest.manifest_version,3);assert.equal(manifest.content_scripts.length,1);
  assert.deepEqual(manifest.content_scripts[0].matches,['http://127.0.0.1/browser-pair*']);
  assert.equal(manifest.content_scripts[0].all_frames,false);
  assert.deepEqual(manifest.host_permissions,['http://127.0.0.1/*','https://pan.xunlei.com/*','https://pan.baidu.com/*']);
  assert.ok(!manifest.permissions.includes('cookies'));assert.ok(!JSON.stringify(manifest).includes('<all_urls>'));
});
