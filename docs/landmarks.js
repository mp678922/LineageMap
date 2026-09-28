const landmarkStage=document.getElementById('stage');
const landmarkLayer=document.getElementById('landmark-layer');
const landmarkPanel=document.getElementById('landmark-panel');
const landmarkStatus=document.getElementById('landmark-status');
const landmarkList=document.getElementById('landmark-list');
const editorLandmarkList=document.getElementById('editor-landmark-list');
const landmarkInfo=document.getElementById('landmark-info');
const landmarkListView=document.getElementById('landmark-list-view');
const landmarkEditView=document.getElementById('landmark-edit-view');
const landmarkListTab=document.getElementById('landmark-list-tab');
const landmarkEditTab=document.getElementById('landmark-edit-tab');
const editorGate=document.getElementById('editor-gate');
const editorWorkspace=document.getElementById('editor-workspace');
const landmarkEditor=document.getElementById('landmark-editor');
const editorTitle=document.getElementById('editor-title');
const landmarkLogin=document.getElementById('landmark-login');
const landmarkPassword=document.getElementById('landmark-password');
const landmarkName=document.getElementById('landmark-name');
const landmarkType=document.getElementById('landmark-type');
const landmarkNote=document.getElementById('landmark-note');
const landmarkPosition=document.getElementById('landmark-position');
const landmarkDelete=document.getElementById('landmark-delete');
const landmarkDragLock=document.getElementById('landmark-drag-lock');
const landmarkDragHint=document.getElementById('landmark-drag-hint');
const signoutButton=document.getElementById('landmark-signout');
const editButton=document.getElementById('landmark-edit-toggle');
const landmarksToggle=document.getElementById('landmarks-toggle');
const editorModeHint=document.getElementById('editor-mode-hint');
const placementOverlay=document.getElementById('coordinate-placement');
const placementTarget=document.getElementById('placement-target');
const placementDiamond=document.getElementById('placement-diamond');
const placementCancel=document.getElementById('placement-cancel');
const mapView=window.lineageMapView;
const apiUrl=String(window.LINEAGE_LANDMARK_API_URL||'').trim();
const configured=/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(apiUrl);
const editorCookieName='lineage_map_editor_code';
const editorCookiePath=window.location.pathname.replace(/[^/]*$/,'')||'/';

let landmarks=new Map(),selectedId=null,editPoint=null,placing=false,placingNew=false,editingNew=false,editPassword='';
let editorTabActive=false;
const pins=new Map();
let unlockedId=null;
let clickStart=null,dragged=false,loading=false;
let previewClient=null,targetDrag=null;
let pinDrag=null,moveWorker=null,nextMoveSeq=0,localRevision=0;
const moveQueue=[],pendingPositions=new Map(),latestMoveSeq=new Map();
let verifyingStoredCode=false,manualMutation=false;
let deferredMoveError=null;

function showStatus(message){landmarkStatus.textContent=message;}
function canEdit(){return editorTabActive&&!!editPassword;}
function countStatus(){
  return canEdit()&&deferredMoveError?deferredMoveError.message:
    `${landmarks.size} 個座標${canEdit()?' · 可編輯':''}`;
}
function setPanelVisible(visible){
  landmarkPanel.hidden=!visible;
  landmarksToggle.setAttribute('aria-expanded',String(visible));
}
function showCoordinateTab(tab){
  editorTabActive=tab==='edit';
  landmarkListView.hidden=editorTabActive;
  landmarkEditView.hidden=!editorTabActive;
  landmarkListTab.setAttribute('aria-selected',String(!editorTabActive));
  landmarkEditTab.setAttribute('aria-selected',String(editorTabActive));
  if(!editorTabActive)unlockedId=null;
  syncDragLock();
  showStatus(countStatus());
  if(editorTabActive&&!editPassword&&!verifyingStoredCode)landmarkPassword.focus();
}
function syncDragLock(){
  const available=canEdit()&&!!selectedId&&landmarks.has(selectedId);
  const unlocked=available&&unlockedId===selectedId;
  landmarkDragLock.hidden=!available;
  landmarkDragLock.textContent=unlocked?'🔓 鎖定位置':'🔒 解鎖拖曳';
  landmarkDragLock.classList.toggle('unlocked',unlocked);
  landmarkDragLock.setAttribute('aria-pressed',String(unlocked));
  landmarkDragHint.hidden=!unlocked;
  for(const [id,pin] of pins)pin.classList.toggle('unlocked',unlockedId===id&&canEdit());
}
function readEditorCookie(){
  const entry=document.cookie.split(';').map(part=>part.trim())
    .find(part=>part.startsWith(`${editorCookieName}=`));
  if(!entry)return '';
  try{
    const code=decodeURIComponent(entry.slice(editorCookieName.length+1));
    return /^[0-9]{4}$/.test(code)?code:'';
  }catch{return '';}
}
function writeEditorCookie(code){
  const secure=window.location.protocol==='https:'?'; Secure':'';
  document.cookie=`${editorCookieName}=${encodeURIComponent(code)}; Path=${editorCookiePath}; Max-Age=2592000; SameSite=Lax${secure}`;
}
function clearEditorCookie(){
  document.cookie=`${editorCookieName}=; Path=${editorCookiePath}; Max-Age=0; SameSite=Lax`;
}
function randomId(){
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map(value=>value.toString(16).padStart(2,'0')).join('');
}
function readJsonp(parameters){
  return new Promise((resolve,reject)=>{
    const callback=`lineageCallback_${randomId()}`;
    const script=document.createElement('script');
    const url=new URL(apiUrl);
    for(const [key,value] of Object.entries({...parameters,callback}))url.searchParams.set(key,value);
    url.searchParams.set('_',Date.now());
    let done=false;
    const timer=setTimeout(()=>finish(new Error('連線逾時')),12000);
    function finish(error,value){
      if(done)return;
      done=true;clearTimeout(timer);script.remove();delete window[callback];
      if(error)reject(error);else resolve(value);
    }
    window[callback]=value=>finish(null,value);
    script.onerror=()=>finish(new Error('無法讀取座標服務'));
    script.src=url.href;
    document.head.append(script);
  });
}
async function sendOperation(action,fields={},password=editPassword){
  const opId=randomId();
  const body=new URLSearchParams({action,opId,password,...fields});
  await fetch(apiUrl,{method:'POST',mode:'no-cors',credentials:'omit',body});
  for(let attempt=0;attempt<15;attempt++){
    await new Promise(resolve=>setTimeout(resolve,400+attempt*100));
    const receipt=await readJsonp({action:'receipt',id:opId});
    if(receipt.pending)continue;
    if(!receipt.ok)throw new Error(receipt.error||'操作失敗');
    return receipt;
  }
  throw new Error('無法確認操作結果，請重新讀取座標後再決定是否重試');
}
function pointLabel(point){return point?`格子 ${point.col}, ${point.row}`:'';}
function displayType(type){return type==='boss'||type==='note'?type:'place';}
const landmarkIcons={place:'📍',boss:'👑',note:'📝'};
function landmarkIcon(type){
  const icon=document.createElement('span');
  icon.className='landmark-icon';
  icon.setAttribute('aria-hidden','true');
  icon.textContent=landmarkIcons[displayType(type)];
  return icon;
}
function setPinContent(pin,item){
  pin.dataset.type=displayType(item.type);
  const name=document.createElement('span');
  name.textContent=item.name;
  pin.replaceChildren(landmarkIcon(item.type),name);
}
function setRowContent(row,item,point){
  const text=document.createElement('span');
  text.textContent=`${item.name} · ${pointLabel(point)}`;
  row.replaceChildren(landmarkIcon(item.type),text);
}

function positionPlacementTarget(point){
  const position=point&&mapView.project(point.x,point.y);
  const size=mapView.cellSize();
  if(!position||!size){placementTarget.hidden=true;return;}
  placementTarget.style.left=`${position.x}px`;
  placementTarget.style.top=`${position.y}px`;
  placementDiamond.style.width=`${Math.max(14,size.width)}px`;
  placementDiamond.style.height=`${Math.max(14,size.height)}px`;
  placementTarget.hidden=false;
  if(editingNew){
    const left=landmarkPanel.classList.contains('editor-left');
    if(position.x>landmarkStage.clientWidth*.65&&!left)landmarkPanel.classList.add('editor-left');
    if(position.x<landmarkStage.clientWidth*.35&&left)landmarkPanel.classList.remove('editor-left');
  }
}

function updatePlacementPreview(){
  if(!placingNew||!previewClient)return;
  const rect=landmarkStage.getBoundingClientRect();
  if(previewClient.x<rect.left||previewClient.x>rect.right||
    previewClient.y<rect.top||previewClient.y>rect.bottom){
    placementTarget.hidden=true;return;
  }
  positionPlacementTarget(mapView.snapClient(previewClient.x,previewClient.y));
}

function updateEditorTarget(){
  if(editingNew&&editPoint)positionPlacementTarget(editPoint);
}

function stopFocusedEditor(){
  if(!editingNew)return;
  editingNew=false;targetDrag=null;
  placementTarget.classList.remove('dragging-target');
  placementOverlay.hidden=true;placementTarget.hidden=true;
  landmarkStage.classList.remove('editing-coordinate');
  landmarkPanel.classList.remove('editor-left');
}

function stopNewPlacement(){
  placingNew=false;placing=false;previewClient=null;
  placementOverlay.hidden=true;placementTarget.hidden=true;
  landmarkStage.classList.remove('placing-coordinate');
  setPanelVisible(true);
}

function cancelNewPlacement(){
  if(!placingNew)return;
  stopNewPlacement();
  selectedId=null;editPoint=null;
  showStatus(`${landmarks.size} 個座標 · 可編輯`);
  editButton.focus();
}

function positionPins(){
  for(const [id,pin] of pins){
    const item=pinDrag?.id===id?pinDrag.point:
      pendingPositions.get(id)||landmarks.get(id);
    if(!item)continue;
    const position=mapView.project(item.x,item.y);
    if(!position)continue;
    pin.style.left=`${position.x}px`;
    pin.style.top=`${position.y}px`;
    const hidden=position.x< -100||position.y< -50||
      position.x>landmarkStage.clientWidth+100||position.y>landmarkStage.clientHeight+50;
    pin.hidden=hidden;
  }
  if(pinDrag?.ghost){
    const position=mapView.project(pinDrag.origin.x,pinDrag.origin.y);
    if(position){
      pinDrag.ghost.style.left=`${position.x}px`;
      pinDrag.ghost.style.top=`${position.y}px`;
    }
  }
}

function updatePositionReadout(id,point){
  const item=landmarks.get(id);
  if(!item||!point)return;
  for(const list of [landmarkList,editorLandmarkList])
    for(const row of list.children)
      if(row.dataset.id===id)setRowContent(row,item,point);
  if(selectedId===id){
    editPoint=point;
    landmarkPosition.textContent=pointLabel(point);
    landmarkInfo.textContent=item.note||pointLabel(point);
  }
}

async function flushMoveQueue(){
  while(moveQueue.length){
    const move=moveQueue.shift();
    const item=landmarks.get(move.id);
    if(!item)continue;
    try{
      if(editorTabActive)showStatus(`儲存「${item.name}」的位置…（後續 ${moveQueue.length} 筆）`);
      await sendOperation('save',{id:move.id,name:item.name,type:item.type||'place',note:item.note||'',
        x:String(move.point.x),y:String(move.point.y),
        row:String(move.point.row),col:String(move.point.col)},move.password);
      landmarks.set(move.id,{...item,...move.point});
      if(deferredMoveError?.id===move.id)deferredMoveError=null;
      if(latestMoveSeq.get(move.id)===move.seq){
        pendingPositions.delete(move.id);latestMoveSeq.delete(move.id);
        updatePositionReadout(move.id,move.point);
      }
      if(editorTabActive)
        showStatus(`「${item.name}」位置已儲存${moveQueue.length?`，後續 ${moveQueue.length} 筆待寫入`:''}`);
    }catch(error){
      if(latestMoveSeq.get(move.id)===move.seq){
        pendingPositions.delete(move.id);latestMoveSeq.delete(move.id);
        updatePositionReadout(move.id,landmarks.get(move.id));
      }
      deferredMoveError={id:move.id,message:`「${item.name}」位置未更新：${error.message}`};
      if(editorTabActive)showStatus(deferredMoveError.message);
    }
    positionPins();
  }
}

function enqueueDraggedPosition(id,point){
  localRevision++;
  const seq=++nextMoveSeq;
  latestMoveSeq.set(id,seq);
  pendingPositions.set(id,point);
  moveQueue.push({id,point,seq,password:editPassword});
  updatePositionReadout(id,point);
  positionPins();
  if(!moveWorker)moveWorker=flushMoveQueue().finally(()=>{moveWorker=null;});
}

function beginPinDrag(event,id,pin){
  if(!canEdit()||unlockedId!==id||pinDrag||
    landmarkEditor.querySelector('button[type="submit"]').disabled||landmarkDelete.disabled)return;
  const item=pendingPositions.get(id)||landmarks.get(id);
  const position=item&&mapView.project(item.x,item.y);
  if(!position)return;
  event.preventDefault();event.stopPropagation();
  const rect=landmarkStage.getBoundingClientRect();
  pinDrag={id,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,
    offsetX:event.clientX-rect.left-position.x,
    offsetY:event.clientY-rect.top-position.y,
    origin:{x:item.x,y:item.y,row:item.row,col:item.col},
    point:{x:item.x,y:item.y,row:item.row,col:item.col},moved:false,ghost:null};
  pin.setPointerCapture(event.pointerId);
  pin.classList.add('dragging-pin');
}

function movePinDrag(event){
  if(!pinDrag||pinDrag.pointerId!==event.pointerId)return;
  event.preventDefault();event.stopPropagation();
  if(Math.hypot(event.clientX-pinDrag.startX,event.clientY-pinDrag.startY)>4)pinDrag.moved=true;
  if(!pinDrag.moved)return;
  if(!pinDrag.ghost){
    const ghost=document.createElement('div');
    ghost.className='landmark-pin landmark-origin';
    setPinContent(ghost,landmarks.get(pinDrag.id));
    landmarkLayer.append(ghost);pinDrag.ghost=ghost;
  }
  const rect=landmarkStage.getBoundingClientRect();
  if(event.clientX<rect.left||event.clientX>rect.right||
    event.clientY<rect.top||event.clientY>rect.bottom)return;
  const point=mapView.snapClient(event.clientX-pinDrag.offsetX,
    event.clientY-pinDrag.offsetY);
  if(point){pinDrag.point=point;positionPins();}
}

function endPinDrag(event,pin){
  if(!pinDrag||pinDrag.pointerId!==event.pointerId)return;
  event.stopPropagation();
  const drag=pinDrag;
  drag.ghost?.remove();
  pinDrag=null;pin.classList.remove('dragging-pin');
  if(event.type==='pointercancel'){positionPins();return;}
  if(!drag.moved)return;
  pin.dataset.suppressClick='true';
  setTimeout(()=>{delete pin.dataset.suppressClick;},0);
  if(drag.origin.row===drag.point.row&&drag.origin.col===drag.point.col){positionPins();return;}
  enqueueDraggedPosition(drag.id,drag.point);
}

function selectLandmark(id,focus=false){
  const item=landmarks.get(id);
  if(!item)return;
  if(editorTabActive&&!editPassword)showCoordinateTab('list');
  const point=pendingPositions.get(id)||item;
  if(selectedId!==id){unlockedId=null;landmarkEditor.hidden=true;}
  selectedId=id;editPoint={x:point.x,y:point.y,row:point.row,col:point.col};placing=false;
  setPanelVisible(true);
  landmarkInfo.textContent=item.note||pointLabel(item);
  for(const [pinId,pin] of pins)pin.classList.toggle('selected',pinId===id);
  for(const list of [landmarkList,editorLandmarkList])
    for(const row of list.children)row.classList.toggle('selected',row.dataset.id===id);
  syncDragLock();
  if(canEdit())openEditor(item);
  if(focus)mapView.focus(point.x,point.y);
}

function renderLandmarks(){
  pins.clear();landmarkLayer.replaceChildren();
  landmarkList.replaceChildren();editorLandmarkList.replaceChildren();
  if(unlockedId&&!landmarks.has(unlockedId))unlockedId=null;
  for(const [id,item] of [...landmarks].sort((a,b)=>a[1].name.localeCompare(b[1].name,'zh-Hant'))){
    const pin=document.createElement('button');
    pin.type='button';pin.className='landmark-pin';setPinContent(pin,item);
    pin.title=item.name;
    pin.classList.toggle('unlocked',unlockedId===id&&canEdit());
    pin.onclick=()=>{
      if(pin.dataset.suppressClick){delete pin.dataset.suppressClick;return;}
      selectLandmark(id);
    };
    pin.addEventListener('pointerdown',event=>beginPinDrag(event,id,pin));
    pin.addEventListener('pointermove',movePinDrag);
    pin.addEventListener('pointerup',event=>endPinDrag(event,pin));
    pin.addEventListener('pointercancel',event=>endPinDrag(event,pin));
    landmarkLayer.append(pin);pins.set(id,pin);
    for(const list of [landmarkList,editorLandmarkList]){
      const row=document.createElement('button');
      row.type='button';row.dataset.id=id;
      setRowContent(row,item,item);
      row.onclick=()=>selectLandmark(id,true);
      list.append(row);
    }
  }
  if(selectedId&&!landmarks.has(selectedId)){
    selectedId=null;unlockedId=null;landmarkInfo.textContent='';landmarkEditor.hidden=true;
  }else if(selectedId){
    const item=landmarks.get(selectedId);
    landmarkInfo.textContent=item.note||pointLabel(item);
    pins.get(selectedId)?.classList.add('selected');
    for(const list of [landmarkList,editorLandmarkList])
      for(const row of list.children)
        row.classList.toggle('selected',row.dataset.id===selectedId);
  }
  positionPins();
  syncDragLock();
  if(!editingNew&&!verifyingStoredCode)
    showStatus(countStatus());
}

function openEditor(item=null){
  if(!canEdit()||!editPoint)return;
  editingNew=!item&&!selectedId;
  landmarkEditor.hidden=false;
  editorTitle.textContent=item?'編輯座標':'新增座標';
  landmarkInfo.textContent='';
  landmarkPosition.textContent=pointLabel(editPoint);
  landmarkName.value=item?.name||'';
  landmarkType.value=displayType(item?.type);
  landmarkNote.value=item?.note||'';
  landmarkDelete.hidden=!item;
  syncDragLock();
  setPanelVisible(true);
  if(editingNew){
    placementOverlay.hidden=false;
    landmarkStage.classList.add('editing-coordinate');
    updateEditorTarget();
    showStatus('請填寫座標資料');
  }
  landmarkName.focus();
}

function updateEditorAccess(){
  editorGate.hidden=!!editPassword;
  editorWorkspace.hidden=!editPassword;
  landmarkPassword.disabled=verifyingStoredCode||!configured;
  landmarkLogin.querySelector('button[type="submit"]').disabled=verifyingStoredCode||!configured;
  editorModeHint.textContent=!configured?'座標服務尚未設定。':
    verifyingStoredCode?'正在驗證已儲存的編輯密碼…':
    '請輸入編輯密碼。';
  if(!editPassword){
    unlockedId=null;landmarkEditor.hidden=true;
    if(placingNew)stopNewPlacement();stopFocusedEditor();placing=false;
  }
  renderLandmarks();
}

landmarksToggle.onclick=()=>{
  showCoordinateTab('list');
  setPanelVisible(landmarkPanel.hidden);
};
landmarkListTab.onclick=()=>showCoordinateTab('list');
landmarkEditTab.onclick=()=>showCoordinateTab('edit');
document.getElementById('landmarks-close').onclick=()=>{
  showCoordinateTab('list');setPanelVisible(false);
};
signoutButton.onclick=()=>{
  clearEditorCookie();
  unlockedId=null;deferredMoveError=null;
  editPassword='';landmarkPassword.value='';
  updateEditorAccess();
  landmarkPassword.focus();
};
editButton.onclick=()=>{
  if(!canEdit())return;
  unlockedId=null;syncDragLock();
  selectedId=null;editPoint=null;placing=true;placingNew=true;landmarkEditor.hidden=true;
  landmarkInfo.textContent='';
  for(const pin of pins.values())pin.classList.remove('selected');
  for(const list of [landmarkList,editorLandmarkList])
    for(const row of list.children)row.classList.remove('selected');
  previewClient=null;placementTarget.hidden=true;
  setPanelVisible(false);placementOverlay.hidden=false;
  landmarkStage.classList.add('placing-coordinate');
  placementCancel.focus();
};
placementCancel.onclick=cancelNewPlacement;
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&placingNew){event.preventDefault();cancelNewPlacement();}
});
document.getElementById('landmark-cancel').onclick=()=>{
  stopFocusedEditor();
  unlockedId=null;syncDragLock();
  placing=false;editPoint=null;selectedId=null;landmarkEditor.hidden=true;
  for(const pin of pins.values())pin.classList.remove('selected');
  for(const list of [landmarkList,editorLandmarkList])
    for(const row of list.children)row.classList.remove('selected');
  landmarkInfo.textContent='';showStatus(`${landmarks.size} 個座標 · 可編輯`);
};
landmarkDragLock.onclick=()=>{
  if(!canEdit()||!selectedId||pinDrag)return;
  unlockedId=unlockedId===selectedId?null:selectedId;
  syncDragLock();
};
landmarkStage.addEventListener('pointerdown',event=>{
  clickStart={x:event.clientX,y:event.clientY};dragged=false;
  if(placingNew&&event.pointerType==='touch'){
    previewClient=null;placementTarget.hidden=true;
  }
});
landmarkStage.addEventListener('pointermove',event=>{
  if(clickStart&&Math.hypot(event.clientX-clickStart.x,event.clientY-clickStart.y)>6)dragged=true;
  if(placingNew&&event.pointerType!=='touch'&&!event.target.closest('#placement-cancel')){
    previewClient={x:event.clientX,y:event.clientY};
    updatePlacementPreview();
  }
});
landmarkStage.addEventListener('pointerleave',()=>{
  if(placingNew){previewClient=null;placementTarget.hidden=true;}
});
landmarkStage.addEventListener('pointerup',()=>{clickStart=null;});
landmarkStage.addEventListener('pointercancel',()=>{clickStart=null;dragged=false;});
placementTarget.addEventListener('pointerdown',event=>{
  if(!editingNew||!editPoint)return;
  event.preventDefault();event.stopPropagation();
  const position=mapView.project(editPoint.x,editPoint.y);
  const rect=landmarkStage.getBoundingClientRect();
  targetDrag={id:event.pointerId,
    offsetX:event.clientX-rect.left-position.x,
    offsetY:event.clientY-rect.top-position.y};
  placementTarget.setPointerCapture(event.pointerId);
  placementTarget.classList.add('dragging-target');
});
placementTarget.addEventListener('pointermove',event=>{
  if(!targetDrag||targetDrag.id!==event.pointerId)return;
  event.preventDefault();event.stopPropagation();
  const rect=landmarkStage.getBoundingClientRect();
  if(event.clientX<rect.left||event.clientX>rect.right||
    event.clientY<rect.top||event.clientY>rect.bottom)return;
  const point=mapView.snapClient(event.clientX-targetDrag.offsetX,
    event.clientY-targetDrag.offsetY);
  if(!point)return;
  editPoint=point;
  landmarkPosition.textContent=pointLabel(point);
  updateEditorTarget();
});
function stopTargetDrag(event){
  if(!targetDrag||targetDrag.id!==event.pointerId)return;
  event.stopPropagation();targetDrag=null;
  placementTarget.classList.remove('dragging-target');
}
placementTarget.addEventListener('pointerup',stopTargetDrag);
placementTarget.addEventListener('pointercancel',stopTargetDrag);
landmarkStage.addEventListener('click',event=>{
  if(dragged){dragged=false;return;}
  if(!placing||!canEdit()||event.target.closest('button,a,form,.panel'))return;
  const point=mapView.snapClient(event.clientX,event.clientY);
  if(!point)return;
  editPoint=point;
  if(placingNew)stopNewPlacement();
  else placing=false;
  openEditor(selectedId?landmarks.get(selectedId):null);
});
mapView.onChange(()=>{positionPins();updatePlacementPreview();updateEditorTarget();});

landmarkLogin.addEventListener('submit',async event=>{
  event.preventDefault();
  const candidate=landmarkPassword.value;
  if(!candidate)return;
  const button=landmarkLogin.querySelector('button[type="submit"]');
  button.disabled=true;
  try{
    showStatus('驗證編輯碼中…');
    await sendOperation('verify',{},candidate);
    editPassword=candidate;
    writeEditorCookie(candidate);
    landmarkPassword.value='';
    updateEditorAccess();
    showStatus('編輯碼已驗證，可以編輯座標');
  }catch(error){landmarkPassword.value='';showStatus(error.message);}
  finally{button.disabled=false;}
});

async function restoreEditorAccess(){
  const code=readEditorCookie();
  if(!code)return;
  verifyingStoredCode=true;
  updateEditorAccess();
  showStatus('正在驗證已儲存的編輯碼…');
  try{
    await sendOperation('verify',{},code);
    editPassword=code;
    writeEditorCookie(code);
    verifyingStoredCode=false;
    updateEditorAccess();
    if(editorTabActive)showStatus('編輯碼已驗證，可以編輯座標');
  }catch(error){
    if(error.message==='編輯密碼不正確')clearEditorCookie();
    verifyingStoredCode=false;
    updateEditorAccess();
    if(editorTabActive)showStatus(`自動驗證未完成：${error.message}`);
  }
}

landmarkEditor.addEventListener('submit',async event=>{
  event.preventDefault();
  if(!canEdit()||!editPoint)return;
  const name=landmarkName.value.trim(),note=landmarkNote.value.trim();
  if(!name)return;
  const id=selectedId||randomId();
  const saveButton=landmarkEditor.querySelector('button[type="submit"]');
  saveButton.disabled=true;
  manualMutation=true;localRevision++;
  try{
    showStatus('儲存座標中…');
    if(moveWorker)await moveWorker;
    await sendOperation('save',{id,name,type:landmarkType.value,note,
      x:String(editPoint.x),y:String(editPoint.y),
      row:String(editPoint.row),col:String(editPoint.col)});
    selectedId=id;
    unlockedId=null;
    stopFocusedEditor();
    landmarkEditor.hidden=true;
    manualMutation=false;
    await loadLandmarks();
    if(editorTabActive)showStatus('座標已儲存，其他人開啟同一網址即可看到');
  }catch(error){if(editorTabActive)showStatus(error.message);}
  finally{manualMutation=false;saveButton.disabled=false;}
});

landmarkDelete.onclick=async()=>{
  if(!canEdit()||!selectedId)return;
  const item=landmarks.get(selectedId);
  if(!window.confirm(`刪除「${item?.name||'這個座標'}」？`))return;
  landmarkDelete.disabled=true;
  manualMutation=true;localRevision++;
  try{
    showStatus('刪除座標中…');
    if(moveWorker)await moveWorker;
    await sendOperation('delete',{id:selectedId});
    selectedId=null;unlockedId=null;editPoint=null;landmarkEditor.hidden=true;
    manualMutation=false;
    await loadLandmarks();
    if(editorTabActive)showStatus('座標已刪除');
  }catch(error){if(editorTabActive)showStatus(error.message);}
  finally{manualMutation=false;landmarkDelete.disabled=false;}
};

async function loadLandmarks(){
  if(!configured||loading||pinDrag||moveWorker||manualMutation)return;
  loading=true;
  const startedAt=localRevision;
  try{
    const response=await readJsonp({action:'list'});
    if(pinDrag||moveWorker||manualMutation||localRevision!==startedAt)return;
    if(!response.ok||!Array.isArray(response.landmarks))throw new Error(response.error||'資料格式錯誤');
    landmarks=new Map(response.landmarks.filter(item=>
      /^[a-f0-9]{32}$/.test(item.id)&&Number.isFinite(item.x)&&
      Number.isFinite(item.y)&&typeof item.name==='string')
      .map(item=>[item.id,item]));
    renderLandmarks();
  }catch(error){showStatus(`讀取座標失敗：${error.message}`);}
  finally{loading=false;}
}
if(configured){
  updateEditorAccess();loadLandmarks();restoreEditorAccess();
  setInterval(()=>{if(!document.hidden)loadLandmarks();},30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadLandmarks();});
}else showStatus('座標服務尚未設定');
