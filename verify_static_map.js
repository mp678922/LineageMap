// Smoke test the static map's loading and cache logic without a browser UI.
const fs=require('fs');
const vm=require('vm');
const assert=require('assert');

const controls={};
for(const id of ['fit','zoomIn','zoomOut','detail'])controls[id]={textContent:''};
const listeners={};
const windowListeners={};
const counts={paths:0,draws:0,fadeDraws:0};
const drawnWorldWidths=[];
const stage={
  clientWidth:1920,clientHeight:1080,
  getBoundingClientRect:()=>({left:0,top:0,width:1920,height:1080}),
  addEventListener:(name,handler)=>{listeners[name]=handler;},
  setPointerCapture:()=>{},classList:{add:()=>{},remove:()=>{}},
};
const drawing={
  setTransform:()=>{},fillRect:()=>{},beginPath:()=>{counts.paths++;},moveTo:()=>{},
  lineTo:()=>{},closePath:()=>{},fill:()=>{},drawImage:(_surface,_left,_top,widthWorld)=>{
    counts.draws++;
    drawnWorldWidths.push(widthWorld);
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
  document,window:{addEventListener:(name,handler)=>{windowListeners[name]=handler;},DecompressionStream},
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
    const ready=vm.runInContext('needed.size>0 && [...needed.keys()].every(key=>tiles.has(key)) && requests.size===0 && !updateTimer',context);
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
  const focusCandidates=vm.runInContext('[...tileList(8,bounds()).keys()].filter(key=>tiles.has(key)).slice(0,3)',context);
  assert.strictEqual(focusCandidates.length,3,'the focal redraw check needs several visible tiles');
  context.focusCandidates=focusCandidates;
  vm.runInContext(`
    for(const factor of map.levels.filter(value=>value>8))
      for(const key of tileList(factor,bounds(.2)).keys()){
        const tile=tiles.get(key);
        if(tile&&!tile.raster)rasterize(tile);
      }
    for(const key of focusCandidates)clearRaster(tiles.get(key));
    const focusTile=tiles.get(focusCandidates[2]);
    loadFocus={x:(focusTile.x+.5)*TILE_CELLS*map.columnWidth*focusTile.factor,
      y:(focusTile.y+.5)*TILE_CELLS*map.rowHeight*focusTile.factor};
    paint();
  `,context);
  assert(vm.runInContext('!!tiles.get(focusCandidates[2]).raster',context),
    'the first redraw pass should include the focal tile');
  assert(vm.runInContext('focusCandidates.filter(key=>!!tiles.get(key).raster).length<=2',context),
    'only a small number of tile canvases should be built per frame');
  vm.runInContext('loadFocus=null',context);
  const partialKey=vm.runInContext('[...tileList(8,bounds()).keys()].find(key=>tiles.has(key))',context);
  context.partialKey=partialKey;
  const partialTile=vm.runInContext('tiles.get(partialKey)',context);
  vm.runInContext('tiles.delete(partialKey)',context);
  drawnWorldWidths.length=0;
  vm.runInContext('paint()',context);
  assert(drawnWorldWidths.includes(514*8),
    'available fine tiles should draw before the whole level is complete');
  assert(drawnWorldWidths.includes(514*16),
    'a coarse tile should stay underneath the missing fine tile');
  assert(drawnWorldWidths.lastIndexOf(514*16)<drawnWorldWidths.indexOf(514*8),
    'coarse layers should draw before finer layers');
  context.partialTile=partialTile;
  vm.runInContext('tiles.set(partialKey,partialTile)',context);
  controls.detail.onclick();
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.strictEqual(vm.runInContext('level()',context),32);
  assert(vm.runInContext('[...tiles.values()].some(tile=>tile.factor===8)',context),
    'the fine level should stay cached across detail changes');
  await settle();
  assert(counts.fadeDraws>0,'individual loaded tiles should fade in');
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
  const beforeZoom={bytes:vm.runInContext('transferred',context),
    tile:vm.runInContext('[...tiles.values()].find(tile=>tile.factor===8&&tile.raster)',context)};
  controls.zoomIn.onclick();
  await settle();
  controls.zoomOut.onclick();
  await settle();
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.strictEqual(vm.runInContext('transferred',context),beforeZoom.bytes,
    'zooming through an already loaded area should reuse numeric tiles');
  assert.strictEqual(vm.runInContext(`tiles.get(${JSON.stringify(beforeZoom.tile.key)})`,context),
    beforeZoom.tile,'zooming back should retain the fine numeric tile');
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
  const pinchZoom=vm.runInContext('zoom',context);
  const worldCenter=vm.runInContext('({x:map.width/2-panX/zoom,y:map.height/2-panY/zoom})',context);
  const touch=(pointerId,x,y)=>(
    {pointerId,pointerType:'touch',clientX:x,clientY:y,target:{closest:()=>null},preventDefault(){}}
  );
  listeners.pointerdown(touch(11,860,540));
  listeners.pointerdown(touch(12,1060,540));
  listeners.pointermove(touch(12,1160,540));
  assert(vm.runInContext('zoom',context)>pinchZoom*1.45,'two fingers should zoom the map');
  const projectedCenter=vm.runInContext(`window.lineageMapView.project(${worldCenter.x},${worldCenter.y})`,context);
  assert(Math.abs(projectedCenter.x-1010)<1&&Math.abs(projectedCenter.y-540)<1,
    'pinch zoom should follow the moving midpoint');
  listeners.pointerup(touch(12,1160,540));
  listeners.pointerup(touch(11,860,540));
  assert(vm.runInContext('window.lineageMapView.suppressPlacementClick()',context),
    'a pinch should not accidentally place a coordinate');
  const visibleCenter=vm.runInContext('({x:map.width/2-panX/zoom,y:map.height/2-panY/zoom})',context);
  stage.clientWidth=1200;stage.clientHeight=800;
  windowListeners.resize();
  const resizedCenter=vm.runInContext('({x:map.width/2-panX/zoom,y:map.height/2-panY/zoom})',context);
  assert(Math.abs(resizedCenter.x-visibleCenter.x)<1&&Math.abs(resizedCenter.y-visibleCenter.y)<1,
    'viewport resize should keep the viewed world position');
  console.log('Static map progressively layered coarse and fine tiles, refined, reused cache, pinch zoomed, and dragged. Initial tiles:',farTiles,'initial transfer:',initialBytes,'bytes');
})().catch(error=>{console.error(error);process.exitCode=1;});
