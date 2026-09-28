const stage=document.getElementById('stage');
const canvas=document.getElementById('terrain');
const context=canvas.getContext('2d',{alpha:false});
const status=document.getElementById('progress');
const TILE_CELLS=128;
const TILE_BYTES=TILE_CELLS*TILE_CELLS*3;
const MAX_ACTIVE=4;
const MAX_TILE_PIXELS=1_000_000;
const MAX_IDLE_CELLS=600_000;
const MAX_CACHE_BYTES=32*1024*1024;
const MAX_RASTER_BYTES=96*1024*1024;
const FADE_IN_MS=180;
const SEA_COLOR='#0a2c48';

let map=null,availableTiles=null,zoom=1,fitZoom=1,panX=0,panY=0;
let dragging=null,pinch=null,frame=0,updateTimer=0,active=0,transferred=0;
const touchPoints=new Map();
let suppressTouchClickUntil=0;
let needed=new Map(),tiles=new Map(),requests=new Map(),queue=[];
let cacheBytes=0,cacheTick=0;
let rasterBytes=0,rasterTick=0;
let lastError='',rasterTimer=0,rasterRevision=0;
let displayedFactor=0,idleFactor=0,idleTimer=0;
let loadFocus=null;
const viewListeners=new Set();

window.lineageMapView={
  project(x,y){
    if(!map)return null;
    return {
      x:stage.clientWidth/2+panX+(x-map.width/2)*zoom,
      y:stage.clientHeight/2+panY+(y-map.height/2)*zoom,
    };
  },
  snapClient(clientX,clientY){
    if(!map)return null;
    const rect=stage.getBoundingClientRect();
    const x=map.width/2+(clientX-rect.left-rect.width/2-panX)/zoom;
    const y=map.height/2+(clientY-rect.top-rect.height/2-panY)/zoom;
    let best=null,distance=Infinity;
    const nearRow=Math.round(y/map.rowHeight);
    for(let row=nearRow-1;row<=nearRow+1;row++){
      if(row<0||row>=map.levelSizes['1'].rows)continue;
      const nearCol=Math.round((x-(row%2)*map.halfWidth)/map.columnWidth);
      for(let col=nearCol-1;col<=nearCol+1;col++){
        if(col<0||col>=map.levelSizes['1'].columns)continue;
        const cx=(row%2)*map.halfWidth+col*map.columnWidth;
        const cy=row*map.rowHeight;
        const score=(cx-x)**2+(cy-y)**2;
        if(score<distance){distance=score;best={x:cx,y:cy,row,col};}
      }
    }
    return best;
  },
  cellSize(){
    return map?{width:2*map.halfWidth*zoom,height:2*map.halfHeight*zoom}:null;
  },
  focus(x,y){
    if(!map)return;
    loadFocus={x,y};
    panX=(map.width/2-x)*zoom;
    panY=(map.height/2-y)*zoom;
    cancelIdle(true);render(0);refreshRasters();
  },
  onChange(listener){viewListeners.add(listener);return ()=>viewListeners.delete(listener);},
  suppressPlacementClick(){return Date.now()<suppressTouchClickUntil;},
};
function notifyView(){for(const listener of viewListeners)listener();}

function bounds(margin=0){
  const width=stage.clientWidth,height=stage.clientHeight;
  const extraX=width*margin/zoom,extraY=height*margin/zoom;
  return {
    left:map.width/2+(-width/2-panX)/zoom-extraX,
    right:map.width/2+(width/2-panX)/zoom+extraX,
    top:map.height/2+(-height/2-panY)/zoom-extraY,
    bottom:map.height/2+(height/2-panY)/zoom+extraY,
  };
}

function visualFocus(){
  return loadFocus||{x:map.width/2-panX/zoom,y:map.height/2-panY/zoom};
}

function tileDistanceSquared(tile,focus){
  const factor=tile.factor;
  const left=tile.x*TILE_CELLS*map.columnWidth*factor-map.halfWidth*factor;
  const right=(tile.x+1)*TILE_CELLS*map.columnWidth*factor;
  const top=tile.y*TILE_CELLS*map.rowHeight*factor-map.halfHeight*factor;
  const bottom=(tile.y+1)*TILE_CELLS*map.rowHeight*factor;
  const dx=Math.max(left-focus.x,0,focus.x-right);
  const dy=Math.max(top-focus.y,0,focus.y-bottom);
  return dx*dx+dy*dy;
}

function cellEstimate(factor,area){
  const worldWidth=Math.max(0,Math.min(map.width,area.right)-Math.max(0,area.left));
  const worldHeight=Math.max(0,Math.min(map.height,area.bottom)-Math.max(0,area.top));
  return (Math.ceil(worldWidth/(map.columnWidth*factor))+2)
    *(Math.ceil(worldHeight/(map.rowHeight*factor))+2);
}

function preferredLevel(){
  const ratio=zoom/fitZoom;
  let index=ratio<=.75?5:ratio<=1.5?4:ratio<=3?3:ratio<=6?2:ratio<=12?1:0;
  index=Math.max(0,Math.min(map.levels.length-1,index));
  const area=bounds(.25);
  while(index<map.levels.length-1){
    const factor=map.levels[index];
    if(cellEstimate(factor,area)<=180000)break;
    index++;
  }
  return map.levels[index];
}

function baseLevel(){
  const preferred=preferredLevel();
  const index=map.levels.indexOf(preferred);
  if(index===0)return map.levels[1];
  const finer=map.levels[index-1];
  if(finer*map.columnWidth*zoom>=4&&
     cellEstimate(finer,bounds(.25))<=180000)return preferred;
  return map.levels[Math.min(index+1,map.levels.length-1)];
}

function level(){return displayedFactor||baseLevel();}

function cancelIdle(resetDisplay=false){
  clearTimeout(idleTimer);idleTimer=0;idleFactor=0;
  if(resetDisplay&&map)displayedFactor=baseLevel();
}

function scheduleIdleRefine(){
  if(!map||dragging||idleFactor||idleTimer)return;
  const index=map.levels.indexOf(level());
  if(index<=0)return;
  const coarse=level();
  const finer=map.levels[index-1];
  if(finer*map.columnWidth*zoom<4||cellEstimate(finer,bounds(.25))>MAX_IDLE_CELLS)return;
  const coarseTiles=tileList(coarse,bounds(.25));
  if([...coarseTiles.keys()].some(key=>!tiles.has(key)))return;
  idleTimer=setTimeout(()=>{
    idleTimer=0;
    if(dragging||level()!==coarse)return;
    const fineTiles=tileList(finer,bounds(.25));
    if(!fineTiles.size)return;
    idleFactor=finer;
    updateTiles();
    completeIdleRefine();
  },400);
}

function completeIdleRefine(){
  if(!idleFactor)return;
  const fineTiles=tileList(idleFactor,bounds(.25));
  if(![...fineTiles.keys()].some(key=>tiles.has(key)))return;
  displayedFactor=idleFactor;
  idleFactor=0;
  updateTiles();
  paintSoon();
}

function tileList(factor,area){
  const info=map.levelSizes[String(factor)];
  const halfWidth=map.halfWidth*factor;
  const halfHeight=map.halfHeight*factor;
  const rowHeight=map.rowHeight*factor;
  const columnWidth=map.columnWidth*factor;
  const firstRow=Math.max(0,Math.floor((area.top-halfHeight)/rowHeight));
  const lastRow=Math.min(info.rows-1,Math.ceil((area.bottom+halfHeight)/rowHeight));
  const firstCol=Math.max(0,Math.floor((area.left-halfWidth*2)/columnWidth));
  const lastCol=Math.min(info.columns-1,Math.ceil((area.right+halfWidth)/columnWidth));
  const result=new Map();
  if(firstRow>lastRow||firstCol>lastCol)return result;
  for(let y=Math.floor(firstRow/TILE_CELLS);y<=Math.floor(lastRow/TILE_CELLS);y++){
    for(let x=Math.floor(firstCol/TILE_CELLS);x<=Math.floor(lastCol/TILE_CELLS);x++){
      if(!availableTiles.get(factor).has(`${y}-${x}`))continue;
      const key=`${factor}/${y}-${x}`;
      result.set(key,{factor,x,y,key});
    }
  }
  return result;
}

function scheduleUpdate(delay){
  clearTimeout(updateTimer);
  updateTimer=setTimeout(()=>{updateTimer=0;updateTiles();},delay);
}

function trimCache(){
  if(cacheBytes<=MAX_CACHE_BYTES)return;
  const stale=[...tiles.values()].filter(tile=>!needed.has(tile.key))
    .sort((a,b)=>a.lastUsed-b.lastUsed);
  for(const tile of stale){
    if(cacheBytes<=MAX_CACHE_BYTES)break;
    clearRaster(tile);
    tiles.delete(tile.key);
    cacheBytes-=tile.bytes.byteLength;
  }
}

function clearRaster(tile){
  if(!tile.raster)return;
  rasterBytes-=tile.raster.bytes;
  tile.raster=null;
}

function trimRasters(protect=null){
  if(rasterBytes<=MAX_RASTER_BYTES)return;
  const stale=[...tiles.values()].filter(tile=>tile!==protect&&tile.raster&&!needed.has(tile.key))
    .sort((a,b)=>a.lastRasterUsed-b.lastRasterUsed);
  for(const tile of stale){
    if(rasterBytes<=MAX_RASTER_BYTES)break;
    clearRaster(tile);
  }
}

function updateTiles(){
  if(!map)return;
  lastError='';
  const factor=level(),area=bounds(.25);
  const displayTiles=tileList(factor,area);
  needed=new Map(displayTiles);
  const missing=[...displayTiles.keys()].some(key=>!tiles.has(key));
  const coarser=map.levels[map.levels.indexOf(factor)+1];
  const fallbackFactor=missing?coarser:null;
  if(fallbackFactor){
    for(const [key,tile] of tileList(fallbackFactor,area))needed.set(key,tile);
  }
  if(missing){
    for(const coarse of map.levels.filter(value=>value>factor)){
      for(const [key,tile] of tileList(coarse,area))
        if(tiles.has(key))needed.set(key,tile);
    }
  }
  if(idleFactor){
    for(const [key,tile] of tileList(idleFactor,area))needed.set(key,tile);
  }
  for(const [key,tile] of tiles)if(needed.has(key))tile.lastUsed=++cacheTick;
  trimCache();
  trimRasters();
  for(const [key,request] of requests){
    if(!needed.has(key))request.abort();
  }
  const focus=visualFocus();
  queue=[...needed.values()].filter(tile=>!tiles.has(tile.key)&&!requests.has(tile.key));
  queue.sort((a,b)=>{
    const distance=tileDistanceSquared(a,focus)-tileDistanceSquared(b,focus);
    if(distance)return distance;
    if(a.factor!==b.factor)return b.factor-a.factor;
    return a.key.localeCompare(b.key);
  });
  paintSoon();
  pump();
  scheduleIdleRefine();
}

async function decodeTile(buffer){
  const bytes=new Uint8Array(buffer);
  if(bytes[0]===0x1f&&bytes[1]===0x8b){
    if(!('DecompressionStream' in window))throw new Error('瀏覽器不支援 gzip 解壓縮');
    const stream=new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    buffer=await new Response(stream).arrayBuffer();
  }
  if(buffer.byteLength!==TILE_BYTES)throw new Error('地形資料塊長度不符');
  return new Uint8Array(buffer);
}

function pump(){
  while(active<MAX_ACTIVE&&queue.length){
    const tile=queue.shift();
    if(!needed.has(tile.key)||tiles.has(tile.key)||requests.has(tile.key))continue;
    const controller=new AbortController();
    requests.set(tile.key,controller);active++;
    fetch(`./tiles/${tile.factor}/${tile.y}-${tile.x}.bin.gz`,{signal:controller.signal})
      .then(async response=>{
        if(!response.ok)throw new Error(`HTTP ${response.status}`);
        const buffer=await response.arrayBuffer();
        const decoded=await decodeTile(buffer);
        if(requests.get(tile.key)===controller&&needed.has(tile.key)){
          tiles.set(tile.key,{...tile,bytes:decoded,styles:new Map(),raster:null,
            loadedAt:Date.now(),lastUsed:++cacheTick});
          cacheBytes+=decoded.byteLength;
          trimCache();
          transferred+=buffer.byteLength;
          paintSoon();
          completeIdleRefine();
          if(tile.factor===level()&&
             [...tileList(level(),bounds(.25)).keys()].every(key=>tiles.has(key)))
            scheduleUpdate(0);
        }
      })
      .catch(error=>{
        if(error.name!=='AbortError')lastError=`資料塊載入失敗：${error.message}`;
      })
      .finally(()=>{
        if(requests.get(tile.key)===controller)requests.delete(tile.key);
        active--;pump();updateStatus();scheduleIdleRefine();
      });
  }
  updateStatus();
}

function updateStatus(){
  if(!map)return;
  if(lastError){status.textContent=lastError;return;}
  let loaded=0;
  const displayTiles=tileList(level(),bounds(.25));
  for(const key of displayTiles.keys())if(tiles.has(key))loaded++;
  const factor=level();
  let refining='';
  if(idleFactor){
    const fineTiles=tileList(idleFactor,bounds(.25));
    const fineLoaded=[...fineTiles.keys()].filter(key=>tiles.has(key)).length;
    refining=` · 細化中 ${fineLoaded}/${fineTiles.size}`;
  }
  status.textContent=`${factor===1?'細格':factor+' 倍取樣'} · ${loaded}/${displayTiles.size} 塊${refining} · 已傳 ${Math.round(transferred/1024)} KB`;
}

function styleFor(tile,r,g,b){
  const rgb=(r<<16)|(g<<8)|b;
  let style=tile.styles.get(rgb);
  if(!style){style='#'+rgb.toString(16).padStart(6,'0');tile.styles.set(rgb,style);}
  return style;
}

function rasterize(tile){
  const factor=tile.factor;
  const halfWidth=map.halfWidth*factor,halfHeight=map.halfHeight*factor;
  const columnWidth=map.columnWidth*factor,rowHeight=map.rowHeight*factor;
  const left=tile.x*TILE_CELLS*columnWidth-halfWidth;
  const top=tile.y*TILE_CELLS*rowHeight-halfHeight;
  const widthWorld=TILE_CELLS*columnWidth+halfWidth;
  const heightWorld=TILE_CELLS*rowHeight+halfHeight;
  const desiredScale=zoom*Math.min(devicePixelRatio||1,1.5);
  const scale=Math.min(desiredScale,Math.sqrt(MAX_TILE_PIXELS/(widthWorld*heightWorld)));
  const pixelWidth=Math.max(1,Math.ceil(widthWorld*scale));
  const pixelHeight=Math.max(1,Math.ceil(heightWorld*scale));
  const surface=typeof OffscreenCanvas==='undefined'
    ? document.createElement('canvas') : new OffscreenCanvas(pixelWidth,pixelHeight);
  surface.width=pixelWidth;surface.height=pixelHeight;
  const brush=surface.getContext('2d',{alpha:true});
  brush.setTransform(scale,0,0,scale,-left*scale,-top*scale);
  const maxRows=map.levelSizes[String(factor)].rows;
  const maxCols=map.levelSizes[String(factor)].columns;
  for(let row=tile.y*TILE_CELLS;row<Math.min(maxRows,(tile.y+1)*TILE_CELLS);row++){
    const cy=row*rowHeight,firstX=(row%2)*halfWidth;
    for(let col=tile.x*TILE_CELLS;col<Math.min(maxCols,(tile.x+1)*TILE_CELLS);col++){
      const offset=((row%TILE_CELLS)*TILE_CELLS+(col%TILE_CELLS))*3;
      const r=tile.bytes[offset],g=tile.bytes[offset+1],b=tile.bytes[offset+2];
      const cx=firstX+col*columnWidth;
      brush.beginPath();
      brush.moveTo(cx,cy-halfHeight);
      brush.lineTo(cx+halfWidth,cy);
      brush.lineTo(cx,cy+halfHeight);
      brush.lineTo(cx-halfWidth,cy);
      brush.closePath();
      brush.fillStyle=r===255&&g===255&&b===255?SEA_COLOR:styleFor(tile,r,g,b);
      brush.fill();
    }
  }
  clearRaster(tile);
  const bytes=pixelWidth*pixelHeight*4;
  tile.raster={surface,left,top,widthWorld,heightWorld,scale,bytes};
  tile.firstRasterAt ||= Date.now();
  tile.lastRasterUsed=++rasterTick;
  rasterBytes+=bytes;
  trimRasters(tile);
}

function refreshRasters(){
  clearTimeout(rasterTimer);
  const revision=++rasterRevision;
  rasterTimer=setTimeout(()=>{
    if(dragging)return;
    const factor=level();
    const stale=[...tileList(factor,bounds(.2)).keys()]
      .map(key=>tiles.get(key)).filter(tile=>{
        if(!tile?.raster)return false;
        const widthWorld=TILE_CELLS*map.columnWidth*tile.factor+map.halfWidth*tile.factor;
        const heightWorld=TILE_CELLS*map.rowHeight*tile.factor+map.halfHeight*tile.factor;
        const desired=Math.min(zoom*Math.min(devicePixelRatio||1,1.5),
          Math.sqrt(MAX_TILE_PIXELS/(widthWorld*heightWorld)));
        return tile.raster.scale<desired*.9;
      });
    const focus=visualFocus();
    stale.sort((a,b)=>tileDistanceSquared(a,focus)-tileDistanceSquared(b,focus));
    function next(){
      if(revision!==rasterRevision||!stale.length)return;
      if(dragging||level()!==factor)return;
      const tile=stale.shift();
      if(tiles.get(tile.key)===tile){
        rasterize(tile);
        paintSoon();
      }
      if(stale.length)requestAnimationFrame(next);
    }
    next();
  },100);
}

function paint(){
  frame=0;
  const dpr=Math.min(devicePixelRatio||1,2);
  const width=stage.clientWidth*1.4,height=stage.clientHeight*1.4;
  const pixelWidth=Math.round(width*dpr),pixelHeight=Math.round(height*dpr);
  if(canvas.width!==pixelWidth||canvas.height!==pixelHeight){
    canvas.width=pixelWidth;canvas.height=pixelHeight;
  }
  context.setTransform(dpr,0,0,dpr,0,0);
  context.fillStyle=SEA_COLOR;context.fillRect(0,0,width,height);
  if(!map)return;
  notifyView();
  const area=bounds(.2);
  context.setTransform(dpr*zoom,0,0,dpr*zoom,
    dpr*(width/2+panX-map.width/2*zoom),
    dpr*(height/2+panY-map.height/2*zoom));
  const now=Date.now();
  const target=level();
  const needsCoarse=[...tileList(target,area).keys()].some(key=>{
    const tile=tiles.get(key);
    return !tile||!tile.raster||now-(tile.firstRasterAt||tile.loadedAt||0)<FADE_IN_MS;
  });
  const visible=[];
  for(const tile of tiles.values()){
    if(tile.factor<target||(!needsCoarse&&tile.factor>target))continue;
    const tileLeft=tile.x*TILE_CELLS*map.columnWidth*tile.factor-map.halfWidth*tile.factor;
    const tileTop=tile.y*TILE_CELLS*map.rowHeight*tile.factor-map.halfHeight*tile.factor;
    const tileRight=(tile.x+1)*TILE_CELLS*map.columnWidth*tile.factor;
    const tileBottom=(tile.y+1)*TILE_CELLS*map.rowHeight*tile.factor;
    if(tileLeft>area.right||tileTop>area.bottom||
       tileRight<area.left||tileBottom<area.top)continue;
    visible.push(tile);
  }
  const focus=visualFocus();
  const baseFactor=map.levels.find(factor=>factor>target&&visible.some(tile=>tile.factor===factor));
  const pending=visible.filter(tile=>!tile.raster).sort((a,b)=>{
    const distance=tileDistanceSquared(a,focus)-tileDistanceSquared(b,focus);
    if(distance)return distance;
    const priority=tile=>tile.factor===baseFactor?0:tile.factor===target?1:2;
    return priority(a)-priority(b)||b.factor-a.factor;
  });
  for(const tile of pending.slice(0,2))rasterize(tile);
  let fading=false;
  function drawLayer(factor){
    for(const tile of visible){
      if(tile.factor!==factor||!tile.raster)continue;
      tile.lastRasterUsed=++rasterTick;
      const image=tile.raster;
      context.globalAlpha=Math.min(1,Math.max(0,(now-(tile.firstRasterAt||0))/FADE_IN_MS));
      if(context.globalAlpha<1)fading=true;
      context.drawImage(image.surface,image.left,image.top,image.widthWorld,image.heightWorld);
    }
  }
  for(const factor of [...map.levels].reverse()){
    if(factor===target||(needsCoarse&&factor>target))drawLayer(factor);
  }
  context.globalAlpha=1;
  if(fading||pending.length>2)paintSoon();
}

function paintSoon(){if(!dragging&&!frame)frame=requestAnimationFrame(paint);}
function render(delay=70){paintSoon();if(map)scheduleUpdate(delay);}
function fit(){
  if(!map)return;
  loadFocus=null;
  fitZoom=Math.min(stage.clientWidth/map.width,stage.clientHeight/map.height)*.96;
  zoom=fitZoom;panX=0;panY=0;cancelIdle(true);render(0);refreshRasters();
}
function zoomAt(factor,clientX,clientY,preserveDetail=false){
  if(!map)return;
  const rect=stage.getBoundingClientRect();
  const x=clientX-rect.left-rect.width/2,y=clientY-rect.top-rect.height/2;
  const worldX=(x-panX)/zoom,worldY=(y-panY)/zoom;
  loadFocus={x:map.width/2+worldX,y:map.height/2+worldY};
  const previousZoom=zoom;
  zoom=Math.max(fitZoom*.6,Math.min(fitZoom*24,zoom*factor));
  panX=x-worldX*zoom;panY=y-worldY*zoom;
  cancelIdle(!preserveDetail&&zoom<previousZoom);
  if(zoom>=previousZoom)displayedFactor=Math.min(displayedFactor||baseLevel(),baseLevel());
  render();refreshRasters();
}
function touchPair(){
  const [first,second]=[...touchPoints.values()];
  return {x:(first.x+second.x)/2,y:(first.y+second.y)/2,
    distance:Math.max(1,Math.hypot(first.x-second.x,first.y-second.y))};
}
function finishPinch(){
  pinch=null;
  suppressTouchClickUntil=Date.now()+350;
  const fine=tileList(level(),bounds(.25));
  if(level()<baseLevel()&&[...fine.keys()].some(key=>!tiles.has(key)))displayedFactor=baseLevel();
  render(0);refreshRasters();
}
function resizeView(){
  if(!map)return;
  loadFocus=null;
  const centerX=map.width/2-panX/zoom,centerY=map.height/2-panY/zoom;
  fitZoom=Math.min(stage.clientWidth/map.width,stage.clientHeight/map.height)*.96;
  zoom=Math.max(fitZoom*.6,Math.min(fitZoom*24,zoom));
  panX=(map.width/2-centerX)*zoom;
  panY=(map.height/2-centerY)*zoom;
  render(0);refreshRasters();
}
const center=()=>{const r=stage.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2];};
document.getElementById('fit').onclick=fit;
document.getElementById('zoomIn').onclick=()=>zoomAt(1.4,...center());
document.getElementById('zoomOut').onclick=()=>zoomAt(1/1.4,...center());
stage.addEventListener('wheel',event=>{
  if(event.target.closest('#landmark-panel'))return;
  event.preventDefault();zoomAt(event.deltaY<0?1.18:1/1.18,event.clientX,event.clientY);
},{passive:false});
stage.addEventListener('pointerdown',event=>{
  if(event.target.closest('button,a,input,textarea,select,form,.panel'))return;
  event.preventDefault();
  if(event.pointerType==='touch'){
    touchPoints.set(event.pointerId,{x:event.clientX,y:event.clientY});
    stage.setPointerCapture(event.pointerId);
    if(touchPoints.size===2){
      if(frame){cancelAnimationFrame(frame);frame=0;}
      dragging=null;canvas.style.transform='';stage.classList.remove('dragging');
      pinch=touchPair();cancelIdle();suppressTouchClickUntil=Date.now()+350;
      return;
    }
    if(touchPoints.size>2)return;
  }
  loadFocus=null;
  cancelIdle();scheduleUpdate(0);
  if(frame){cancelAnimationFrame(frame);frame=0;}
  dragging={id:event.pointerId,startX:event.clientX,startY:event.clientY,
    basePanX:panX,basePanY:panY};
  stage.setPointerCapture(event.pointerId);stage.classList.add('dragging');
});
stage.addEventListener('pointermove',event=>{
  if(event.pointerType==='touch'&&touchPoints.has(event.pointerId)){
    touchPoints.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(pinch&&touchPoints.size===2){
      event.preventDefault();
      const current=touchPair();
      zoomAt(current.distance/pinch.distance,pinch.x,pinch.y,true);
      panX+=current.x-pinch.x;panY+=current.y-pinch.y;
      pinch=current;
      suppressTouchClickUntil=Date.now()+350;
      return;
    }
  }
  if(!dragging||dragging.id!==event.pointerId)return;
  const dx=event.clientX-dragging.startX,dy=event.clientY-dragging.startY;
  panX=dragging.basePanX+dx;panY=dragging.basePanY+dy;
  notifyView();
  canvas.style.transform=`translate(${dx}px,${dy}px)`;
  if(Math.abs(dx)>stage.clientWidth*.17||Math.abs(dy)>stage.clientHeight*.17){
    canvas.style.transform='';
    dragging.basePanX=panX;dragging.basePanY=panY;
    dragging.startX=event.clientX;dragging.startY=event.clientY;
    paint();
  }
  scheduleUpdate(140);
});
function stopDrag(event){
  if(event.pointerType==='touch'){
    touchPoints.delete(event.pointerId);
    if(pinch){
      if(touchPoints.size>=2){pinch=touchPair();return;}
      finishPinch();
      if(touchPoints.size===1){
        const [id,point]=[...touchPoints.entries()][0];
        dragging={id,startX:point.x,startY:point.y,basePanX:panX,basePanY:panY};
        stage.classList.add('dragging');
      }
      return;
    }
  }
  if(dragging?.id!==event.pointerId)return;
  dragging=null;canvas.style.transform='';stage.classList.remove('dragging');
  if(level()!==baseLevel()){
    const fineVisible=tileList(level(),bounds(.25));
    if([...fineVisible.keys()].some(key=>!tiles.has(key)))displayedFactor=baseLevel();
  }
  render(0);
}
stage.addEventListener('pointerup',stopDrag);
stage.addEventListener('pointercancel',stopDrag);
window.addEventListener('resize',resizeView);

fetch('./meta.json').then(response=>{
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  return response.json();
}).then(data=>{
  map=data;
  availableTiles=new Map(Object.entries(data.availableTiles)
    .map(([factor,keys])=>[Number(factor),new Set(keys)]));
  fit();
})
  .catch(error=>{status.textContent=`無法載入地圖資料：${error.message}`;});
