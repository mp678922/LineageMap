// Exercise continuous coordinate dragging without a browser or live sheet.
const assert=require('assert');
const fs=require('fs');
const vm=require('vm');

function element(id=''){
  const classes=new Set(),listeners={};
  return {
    id,hidden:false,disabled:false,style:{},dataset:{},children:[],listeners,
    classList:{
      add:name=>classes.add(name),remove:name=>classes.delete(name),
      contains:name=>classes.has(name),
      toggle:(name,on)=>{if(on)classes.add(name);else classes.delete(name);},
    },
    append(child){this.children.push(child);},
    replaceChildren(...children){this.children=children;},
    remove(){this.removed=true;},
    addEventListener(name,handler){listeners[name]=handler;},
    setAttribute(){},focus(){},setPointerCapture(){},
    querySelector(){return id==='landmark-login'?loginButton:saveButton;},
  };
}
const saveButton=element('save');
const loginButton=element('login-submit');
const nodes=new Map();
function byId(id){
  if(!nodes.has(id))nodes.set(id,element(id));
  return nodes.get(id);
}
const stage=byId('stage');
stage.clientWidth=1000;stage.clientHeight=700;
stage.getBoundingClientRect=()=>({left:0,top:0,right:1000,bottom:700});
const mapView={
  project:(x,y)=>({x,y}),
  snapClient:(x,y)=>({x,y,row:Math.round(y),col:Math.round(x)}),
  onChange:()=>{},
};
const context=vm.createContext({
  document:{getElementById:byId,createElement:()=>element(),cookie:'',addEventListener:()=>{}},
  window:{lineageMapView:mapView,LINEAGE_LANDMARK_API_URL:'',location:{pathname:'/',protocol:'http:'}},
  setTimeout,clearTimeout,URL,URLSearchParams,Math,Map,Set,
});
vm.runInContext(fs.readFileSync('docs/landmarks.js','utf8'),context);
vm.runInContext('showCoordinateTab("edit");updateEditorAccess()',context);
assert.strictEqual(byId('editor-gate').hidden,false);
assert.strictEqual(byId('editor-workspace').hidden,true);
const requests=[];
context.mockSend=(_action,fields)=>new Promise((resolve,reject)=>{
  requests.push({fields,resolve,reject});
});
vm.runInContext(`
  sendOperation=mockSend;
  editPassword='1234';
  editorTabActive=true;selectedId='a';unlockedId='a';
  landmarks=new Map([['a',{id:'a',name:'城門',type:'place',note:'',x:20,y:10,row:10,col:20}]]);
  updateEditorAccess();
`,context);
assert.strictEqual(byId('editor-gate').hidden,true);
assert.strictEqual(byId('editor-workspace').hidden,false);

async function until(check){
  for(let i=0;i<20;i++){
    if(check())return;
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  throw new Error('Queue did not advance');
}
const pointer=(x,y,type='pointermove')=>({
  type,pointerId:1,clientX:x,clientY:y,preventDefault(){},stopPropagation(){},
});
(async()=>{
  vm.runInContext('enqueueDraggedPosition("a",{x:24,y:10,row:10,col:24})',context);
  assert.strictEqual(requests.length,1);
  vm.runInContext('beginPinDrag(testPointer,"a",pins.get("a"))',
    Object.assign(context,{testPointer:pointer(24,10,'pointerdown')}));
  assert(vm.runInContext('pinDrag!==null',context),'dragging must remain available during a write');
  context.testPointer=pointer(30,10);
  vm.runInContext('movePinDrag(testPointer)',context);
  const ghost=vm.runInContext('pinDrag.ghost',context);
  assert(ghost&&ghost.className.includes('landmark-origin'));
  assert.strictEqual(ghost.style.left,'24px','the translucent marker stays at the drag origin');
  context.testPointer=pointer(30,10,'pointerup');
  vm.runInContext('endPinDrag(testPointer,pins.get("a"))',context);
  assert(ghost.removed,'the origin marker disappears when dragging ends');
  assert.strictEqual(requests.length,1,'the second write must wait for the first');
  requests[0].resolve({ok:true});
  await until(()=>requests.length===2);
  assert.strictEqual(requests[1].fields.col,'30');
  assert.strictEqual(vm.runInContext('pendingPositions.get("a").col',context),30);
  requests[1].resolve({ok:true});
  await vm.runInContext('moveWorker',context);
  assert.strictEqual(vm.runInContext('landmarks.get("a").col',context),30);
  assert.strictEqual(vm.runInContext('pendingPositions.size',context),0);
  vm.runInContext('enqueueDraggedPosition("a",{x:35,y:10,row:10,col:35})',context);
  vm.runInContext('enqueueDraggedPosition("a",{x:40,y:10,row:10,col:40})',context);
  requests[2].reject(new Error('temporary failure'));
  await until(()=>requests.length===4);
  requests[3].resolve({ok:true});
  await vm.runInContext('moveWorker',context);
  assert.strictEqual(vm.runInContext('landmarks.get("a").col',context),40,
    'a failed earlier write must not discard the later queued position');
  vm.runInContext('enqueueDraggedPosition("a",{x:45,y:10,row:10,col:45})',context);
  requests[4].reject(new Error('last write failed'));
  await vm.runInContext('moveWorker',context);
  assert.strictEqual(vm.runInContext('landmarks.get("a").col',context),40);
  assert.strictEqual(vm.runInContext('pendingPositions.size',context),0);
  vm.runInContext('showCoordinateTab("list")',context);
  assert.strictEqual(vm.runInContext('canEdit()',context),false);
  assert.strictEqual(vm.runInContext('editPassword',context),'1234',
    'the list tab must retain verified editor identity');
  assert(!vm.runInContext('pins.get("a").classList.contains("unlocked")',context));
  vm.runInContext('showCoordinateTab("edit")',context);
  assert.strictEqual(vm.runInContext('canEdit()',context),true);
  vm.runInContext('signoutButton.onclick()',context);
  assert.strictEqual(vm.runInContext('editPassword',context),'');
  assert.strictEqual(byId('editor-gate').hidden,false);
  vm.runInContext(`
    landmarks.set('b',{id:'b',name:'巨龍',type:'boss',note:'',x:30,y:30,row:30,col:30});
    landmarks.set('c',{id:'c',name:'路線',type:'note',note:'',x:40,y:40,row:40,col:40});
    renderLandmarks();
  `,context);
  assert.strictEqual(vm.runInContext('pins.get("a").children[0].textContent',context),'📍');
  assert.strictEqual(vm.runInContext('pins.get("b").children[0].textContent',context),'👑');
  assert.strictEqual(vm.runInContext('pins.get("c").children[0].textContent',context),'📝');
  assert.strictEqual(byId('landmark-list').children.find(row=>row.dataset.id==='c').children[0].textContent,'📝');
  console.log('Coordinate drag queue, origin ghost, failure recovery, and tab access passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
