// Smoke test the static map's loading and cache logic without a browser UI.
const fs=require('fs');
const vm=require('vm');
const assert=require('assert');

const controls={};
for(const id of ['fit','zoomIn','zoomOut','detail'])controls[id]={textContent:''};
const listeners={};
const counts={paths:0,draws:0,fadeDraws:0};
const stage={
  clientWidth:1920,clientHeight:1080,
  getBoundingClientRect:()=>({left:0,top:0,width:1920,height:1080}),
  addEventListener:(name,handler)=>{listeners[name]=handler;},
  setPointerCapture:()=>{},classList:{add:()=>{},remove:()=>{}},
};
const drawing={
  setTransform:()=>{},fillRect:()=>{},beginPath:()=>{counts.paths++;},moveTo:()=>{},
  lineTo:()=>{},closePath:()=>{},fill:()=>{},drawImage:()=>{
    counts.draws++;
    if(drawing.globalAlpha>0&&drawing.globalAlpha<1)counts.fadeDraws++;
  },
};
const canvas={width:0,height:0,style:{},getContext:()=>drawing};
const status={textContent:''};
const document={
  getElementById:id=>({stage,terrain:canvas,progress:status})[id]||controls[id],
  createElement:()=>({width:0,height:0,getContext:()=>drawing}),
};
const context=vm.createContext({
  document,window:{addEventListener:()=>{},DecompressionStream},
  devicePixelRatio:1,Blob,Response,DecompressionStream,AbortController,
  setTimeout,clearTimeout,
  requestAnimationFrame:callback=>setTimeout(callback,0),
  cancelAnimationFrame:clearTimeout,
  fetch:(url,options)=>fetch('http://127.0.0.1:8765/'+url.replace(/^\.\//,''),options),
});
vm.runInContext(fs.readFileSync('docs/map.js','utf8'),context);

async function settle(){
  for(let attempt=0;attempt<100;attempt++){
    await new Promise(resolve=>setTimeout(resolve,50));
    const ready=vm.runInContext('needed.size>0 && [...needed.keys()].every(key=>tiles.has(key)) && requests.size===0 && transition===null',context);
    if(ready)return;
  }
  throw new Error('Static tiles did not finish loading: '+status.textContent);
}

(async()=>{
  await settle();
  assert.strictEqual(vm.runInContext('level()',context),16);
  const gridPoint=vm.runInContext('window.lineageMapView.snapClient(960,540)',context);
  const projected=vm.runInContext(`window.lineageMapView.project(${gridPoint.x},${gridPoint.y})`,context);
  assert(Math.abs(projected.x-960)<1&&Math.abs(projected.y-540)<1,
    'landmarks should snap to the source grid and project back to the map');
  const farTiles=vm.runInContext('tiles.size',context);
  const initialBytes=vm.runInContext('transferred',context);
  for(let attempt=0;attempt<40;attempt++){
    await new Promise(resolve=>setTimeout(resolve,50));
    if(vm.runInContext('level()',context)===8)break;
  }
  await settle();
  assert.strictEqual(vm.runInContext('level()',context),8,'idle auto mode should refine one level');
  assert(vm.runInContext('[...needed.values()].every(tile=>tile.factor===8)',context));
  controls.detail.onclick();
  await new Promise(resolve=>setTimeout(resolve,40));
  assert(vm.runInContext('transition?.fromFactor===8 && transition?.toFactor===32',context));
  assert(vm.runInContext('[...tiles.values()].some(tile=>tile.factor===8)',context),
    'the old level should stay visible while the new level loads');
  await settle();
  assert(counts.fadeDraws>0,'level changes should draw intermediate opacity frames');
  assert(vm.runInContext('[...tiles.values()].some(tile=>tile.factor===8&&tile.raster)',context),
    'old tile canvases should remain cached across detail changes');
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.strictEqual(vm.runInContext('level()',context),32,'data-saving mode should not refine on idle');
  const bytesBeforeRevisit=vm.runInContext('transferred',context);
  const pathsBeforeRevisit=counts.paths;
  controls.detail.onclick();
  await settle();
  assert.strictEqual(vm.runInContext('level()',context),8);
  assert(vm.runInContext('[...needed.values()].every(tile=>tile.factor===8)',context));
  assert.strictEqual(vm.runInContext('transferred',context),bytesBeforeRevisit,
    'revisiting a cached detail level should not download its tiles again');
  assert.strictEqual(counts.paths,pathsBeforeRevisit,
    'revisiting a cached detail level should not redraw its cells');
  const beforeZoom={bytes:vm.runInContext('transferred',context),paths:counts.paths};
  controls.zoomIn.onclick();
  await settle();
  controls.zoomOut.onclick();
  await settle();
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.strictEqual(vm.runInContext('transferred',context),beforeZoom.bytes,
    'zooming through an already loaded area should reuse numeric tiles');
  assert.strictEqual(counts.paths,beforeZoom.paths,
    'zooming back should reuse the existing tile canvases');
  for(let i=0;i<6;i++)controls.zoomIn.onclick();
  vm.runInContext('window.lineageMapView.focus(map.width*.4004,map.height*.3263)',context);
  await settle();
  assert.strictEqual(vm.runInContext('level()',context),2);
  assert(vm.runInContext('[...needed.values()].every(tile=>tile.factor===2)',context));
  const beforeDrag={...counts};
  let selectionPrevented=false;
  listeners.pointerdown({pointerId:1,clientX:500,clientY:500,
    target:{closest:()=>null},preventDefault:()=>{selectionPrevented=true;}});
  assert(selectionPrevented,'map dragging should prevent native text selection');
  listeners.pointermove({pointerId:1,clientX:620,clientY:530});
  assert.strictEqual(counts.paths,beforeDrag.paths,'dragging should reuse cached tile canvases');
  listeners.pointerup({pointerId:1});
  assert(vm.runInContext('panX',context)!==0);
  await settle();
  assert(counts.draws>beforeDrag.draws,'dragging should composite cached tiles');
  controls.detail.onclick();
  vm.runInContext('window.lineageMapView.focus(map.width*.4004,map.height*.3263)',context);
  assert.strictEqual(vm.runInContext('level()',context),4,'auto mode should initially use coarse Dragon Valley cells');
  await settle();
  for(let attempt=0;attempt<40;attempt++){
    await new Promise(resolve=>setTimeout(resolve,50));
    if(vm.runInContext('level()',context)===2)break;
  }
  await settle();
  assert.strictEqual(vm.runInContext('level()',context),2,'idle Dragon Valley should refine to the next level');
  assert(vm.runInContext('[...needed.values()].every(tile=>tile.factor===2)',context));
  for(let attempt=0;attempt<60;attempt++){
    await new Promise(resolve=>setTimeout(resolve,50));
    if(vm.runInContext('level()',context)===1)break;
  }
  await settle();
  assert.strictEqual(vm.runInContext('level()',context),1,'idle Dragon Valley should continue to the finest level');
  assert(vm.runInContext('[...needed.values()].every(tile=>tile.factor===1)',context));
  const finestTile=vm.runInContext('[...tileList(1,bounds()).keys()].find(key=>tiles.get(key)?.raster)',context);
  assert(finestTile,'the finest view should have a cached canvas');
  const fineRasterScales=vm.runInContext('new Map([...tileList(1,bounds()).keys()].map(key=>[key,tiles.get(key)?.raster?.scale||0]))',context);
  controls.zoomIn.onclick();
  assert.strictEqual(vm.runInContext('level()',context),1,
    'zooming in should keep an already loaded fine level instead of showing coarse cells');
  assert(vm.runInContext(`tiles.get(${JSON.stringify(finestTile)})?.raster!==null`,context),
    'zooming in should retain the cached fine canvas');
  await new Promise(resolve=>setTimeout(resolve,400));
  context.oldScales=fineRasterScales;
  assert(vm.runInContext('[...tileList(1,bounds()).keys()].some(key=>tiles.get(key)?.raster?.scale>(oldScales.get(key)||0)*1.1)',
    context),
    'visible cached canvases should be sharpened after zooming in');
  console.log('Static map loaded, refined to the finest level, reused cached tiles, faded between levels, and dragged. Initial tiles:',farTiles,'initial transfer:',initialBytes,'bytes');
})().catch(error=>{console.error(error);process.exitCode=1;});
